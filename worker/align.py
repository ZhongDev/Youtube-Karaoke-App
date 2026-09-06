#!/usr/bin/env python3
"""Forced-alignment worker (SPEC.md §5, Tier 3).

Turns (YouTube audio + known lyric text) into word-level enhanced LRC:

    yt-dlp bestaudio → ffmpeg → wav → Demucs (vocals) → stable-ts align → LRC

Protocol (the Node side owns the job queue; this process does exactly one job):
  stdin  : one JSON object
             { "videoId": "...", "text": "line\nline\n…", "language": "en"|"ja"|"ko"|null,
               "model": "large-v3", "device": "auto"|"cpu"|"mps",
               "ytdlp": "/path/to/yt-dlp", "workDir": "/tmp/…", "keepAudio": false }
  stdout : NDJSON events, one per line
             {"event":"progress","stage":"download|decode|separate|load|align","percent":0-100,"message":"…"}
             {"event":"result","ok":true,"enhancedLrc":"…","warnings":[…]}
             {"event":"result","ok":false,"error":"…"}
  stderr : library chatter (torch / whisper warnings) — logged by the caller.

Alignment is against the *known* text (not free transcription): every lyric
line becomes one LRC line with a <mm:ss.xx> tag per word.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path

# Must be set before torch is imported: lets unsupported MPS ops run on CPU.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

WARNINGS: list[str] = []


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(stage: str, percent: float, message: str) -> None:
    emit({"event": "progress", "stage": stage, "percent": round(max(0.0, min(100.0, percent)), 1), "message": message})


def warn(msg: str) -> None:
    WARNINGS.append(msg)
    sys.stderr.write(f"[align] warning: {msg}\n")
    sys.stderr.flush()


# ── stage 1: download ──


def download_audio(ytdlp: str, video_id: str, work: Path) -> Path:
    url = f"https://www.youtube.com/watch?v={video_id}"
    template = str(work / "audio.%(ext)s")
    cmd = [
        ytdlp, "-f", "bestaudio/best", "-o", template, "--no-playlist", "--ignore-config",
        "--no-warnings", "--newline", "--progress", url,
    ]
    progress("download", 0, "Downloading audio…")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    tail: list[str] = []
    pct_re = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip()
        if not line:
            continue
        tail = (tail + [line])[-8:]
        m = pct_re.search(line)
        if m:
            progress("download", float(m.group(1)), f"Downloading audio… {m.group(1)}%")
    code = proc.wait()
    if code != 0:
        raise RuntimeError("yt-dlp failed: " + (tail[-1] if tail else f"exit {code}"))
    files = sorted(p for p in work.glob("audio.*") if p.suffix != ".wav")
    if not files:
        raise RuntimeError("yt-dlp produced no audio file")
    progress("download", 100, "Audio downloaded")
    return files[0]


# ── stage 2: decode to wav ──


def decode_to_wav(src: Path, work: Path) -> Path:
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    dst = work / "audio.wav"
    progress("decode", 0, "Decoding audio…")
    # Demucs wants 44.1 kHz stereo; float wav keeps it lossless.
    cmd = [ffmpeg, "-y", "-v", "error", "-i", str(src), "-ac", "2", "-ar", "44100", "-c:a", "pcm_f32le", str(dst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        raise RuntimeError("ffmpeg failed: " + (r.stderr.strip().splitlines() or ["unknown error"])[-1])
    progress("decode", 100, "Audio decoded")
    return dst


# ── stage 3: vocals ──


def pick_devices(requested: str) -> tuple[str, str]:
    """(Demucs device, Whisper device). Demucs runs fine on Apple's GPU (MPS);
    Whisper's checkpoints register a *sparse* alignment-heads buffer that MPS
    cannot hold (aten::_sparse_coo_tensor… on SparseMPS), so Whisper stays on
    CPU — alignment mode is forced-token decoding, which the CPU handles."""
    import torch

    if requested == "cpu" or not torch.backends.mps.is_available():
        return "cpu", "cpu"
    return "mps", "cpu"


def separate_vocals(wav_path: Path, device: str, work: Path):
    """Returns (vocals tensor [channels, samples], sample_rate)."""
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    progress("separate", 0, "Loading Demucs (htdemucs)…")
    model = get_model("htdemucs")
    model.eval()
    data, sr = sf.read(str(wav_path), dtype="float32", always_2d=True)  # [samples, channels]
    wav = torch.from_numpy(data.T.copy())  # [channels, samples]
    if sr != model.samplerate:
        import torchaudio

        wav = torchaudio.functional.resample(wav, sr, model.samplerate)
        sr = model.samplerate
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav_n = (wav - mean) / std

    total_s = wav.shape[1] / sr

    def callback(info: dict) -> None:
        # demucs reports segment offsets as it goes; good enough for a bar.
        if info.get("state") == "end":
            done = (info.get("segment_offset", 0) + info.get("segment_length", 0)) / info.get("audio_length", 1)
            progress("separate", 5 + 90 * min(1.0, done), f"Separating vocals ({device})… {int(100 * min(1.0, done))}%")

    progress("separate", 5, f"Separating vocals ({device})… ({total_s:.0f}s of audio)")
    try:
        with torch.no_grad():
            sources = apply_model(model, wav_n[None], device=device, shifts=1, split=True, overlap=0.25, progress=False, callback=callback)[0]
    except Exception as e:  # noqa: BLE001 — MPS op gaps → retry on CPU
        if device != "cpu":
            warn(f"Demucs on {device} failed ({type(e).__name__}: {str(e)[:120]}); retrying on CPU")
            device = "cpu"
            with torch.no_grad():
                sources = apply_model(model, wav_n[None], device="cpu", shifts=1, split=True, overlap=0.25, progress=False, callback=callback)[0]
        else:
            raise
    vocals = sources[model.sources.index("vocals")] * std + mean
    progress("separate", 100, "Vocals isolated")
    return vocals.cpu(), sr


# ── stage 4/5: alignment ──


def to_whisper_audio(vocals, sr: int):
    """[channels, samples] @ sr → mono float32 numpy @ 16 kHz."""
    import torch
    import torchaudio

    mono = vocals.mean(0)
    if sr != 16000:
        mono = torchaudio.functional.resample(mono, sr, 16000)
    return mono.clamp(-1, 1).to(torch.float32).numpy()


def align_lyrics(audio16k, text: str, language: str | None, model_name: str, device: str):
    import stable_whisper

    progress("load", 0, f"Loading Whisper {model_name} ({device})… first use downloads the model")
    try:
        model = stable_whisper.load_model(model_name, device=device)
    except Exception as e:  # noqa: BLE001
        if device == "cpu":
            raise
        warn(f"Whisper on {device} failed to load ({type(e).__name__}: {str(e)[:120]}); using CPU")
        device = "cpu"
        model = stable_whisper.load_model(model_name, device=device)
    progress("load", 100, f"Whisper {model_name} ready")

    total_s = len(audio16k) / 16000

    def on_progress(seek: float, total: float) -> None:
        progress("align", 100 * seek / max(total, 1e-6), f"Aligning lyrics ({device})… {int(100 * seek / max(total, 1e-6))}%")

    progress("align", 0, f"Aligning lyrics ({device})… ({total_s:.0f}s)")
    kwargs = dict(language=language, original_split=True, verbose=None, progress_callback=on_progress)
    try:
        result = model.align(audio16k, text, **kwargs)
    except Exception as e:  # noqa: BLE001
        if device != "cpu":
            warn(f"Whisper on {device} failed ({type(e).__name__}: {str(e)[:120]}); retrying on CPU")
            model = stable_whisper.load_model(model_name, device="cpu")
            result = model.align(audio16k, text, **kwargs)
        else:
            raise
    progress("align", 100, "Alignment done")
    return result


# ── output ──


def fmt(t: float) -> str:
    t = max(0.0, float(t))
    m = int(t // 60)
    s = t - 60 * m
    return f"{m:02d}:{s:05.2f}"


def to_enhanced_lrc(result, lines: list[str]) -> str:
    """One LRC line per reference line, <tag> per word. Words keep their leading
    space (Latin) or none (CJK) so the app's parser re-joins text exactly."""
    out = ["[re:karaoke-align]"]
    unaligned = 0
    segs = list(result.segments)
    for i, seg in enumerate(segs):
        words = [w for w in (seg.words or []) if (w.word or "").strip()]
        if not words:
            unaligned += 1
            out.append(f"[{fmt(seg.start)}]{seg.text.strip()}")
            continue
        parts = [f"[{fmt(words[0].start)}]"]
        for j, w in enumerate(words):
            token = w.word
            lead = " " if j > 0 and token.startswith(" ") else ""
            parts.append(f"{lead}<{fmt(w.start)}>{token.strip()}")
        out.append("".join(parts))
    if len(segs) != len(lines):
        warn(f"{len(lines)} reference lines became {len(segs)} aligned segments")
    if unaligned:
        warn(f"{unaligned} line(s) had no word timings")
    return "\n".join(out) + "\n"


def main() -> int:
    job = json.loads(sys.stdin.read() or "{}")
    video_id = job["videoId"]
    lines = [l.strip() for l in str(job.get("text", "")).splitlines() if l.strip()]
    if not lines:
        emit({"event": "result", "ok": False, "error": "No lyric text to align"})
        return 1
    work = Path(job.get("workDir") or Path.cwd() / "align-work" / video_id)
    work.mkdir(parents=True, exist_ok=True)
    language = job.get("language") or None
    model_name = job.get("model") or "large-v3"
    demucs_device, whisper_device = pick_devices(job.get("device") or "auto")
    try:
        wav = work / "audio.wav"
        if not wav.exists():
            src = download_audio(job["ytdlp"], video_id, work)
            wav = decode_to_wav(src, work)
        vocals, sr = separate_vocals(wav, demucs_device, work)
        audio16k = to_whisper_audio(vocals, sr)
        result = align_lyrics(audio16k, "\n".join(lines), language, model_name, whisper_device)
        lrc = to_enhanced_lrc(result, lines)
        if not job.get("keepAudio"):
            for p in work.glob("audio.*"):
                p.unlink(missing_ok=True)
        emit({"event": "result", "ok": True, "enhancedLrc": lrc, "warnings": WARNINGS})
        return 0
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit({"event": "result", "ok": False, "error": f"{type(e).__name__}: {e}", "warnings": WARNINGS})
        return 1


if __name__ == "__main__":
    sys.exit(main())
