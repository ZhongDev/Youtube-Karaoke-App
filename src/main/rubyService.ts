import crypto from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import kuromoji, { type Tokenizer } from 'kuromoji';
import type { RubyMode } from '../shared/ipc';
import { parseLrc } from '../shared/lrc';
import { segmentsJa, segmentsKo, type RubyDoc, type RubySegment } from '../shared/ruby';
import type { Repo } from './repo';

// Reading aids (Phase 6). Japanese needs a morphological analyser for kanji
// readings: kuromoji (pure JS, IPADIC, ~17 MB of dictionary loaded once,
// ~0.1 s). Korean romanization is algorithmic (shared/ruby.ts). Results are
// computed lazily per song and cached in ruby_cache by a hash of the lyrics
// body, so a song is analysed once ever.

export class RubyService {
  private tokenizer: Promise<Tokenizer> | null = null;

  constructor(private repo: Repo) {}

  /** node_modules/kuromoji/dict — inside app.asar when packaged (fs reads it fine). */
  private get dicPath(): string {
    return path.join(app.getAppPath(), 'node_modules', 'kuromoji', 'dict');
  }

  private getTokenizer(): Promise<Tokenizer> {
    if (!this.tokenizer) {
      const t0 = Date.now();
      this.tokenizer = new Promise<Tokenizer>((resolve, reject) => {
        kuromoji.builder({ dicPath: this.dicPath }).build((err, tok) => {
          if (err) reject(err);
          else {
            console.log(`[ruby] kuromoji dictionary loaded in ${Date.now() - t0} ms`);
            resolve(tok);
          }
        });
      });
      this.tokenizer.catch(() => {
        this.tokenizer = null; // let the next request retry
      });
    }
    return this.tokenizer;
  }

  async annotate(videoId: string, source: string, mode: RubyMode): Promise<RubyDoc | null> {
    if (mode === 'none') return null;
    const row = this.repo.getTrack(videoId);
    if (!row) throw new Error('Unknown video — play or queue it first');
    const lang = row.language;
    if (lang !== 'ja' && lang !== 'ko') return null;
    const doc = this.repo.getLyrics(videoId).find((d) => d.source === source);
    if (!doc) throw new Error(`No "${source}" lyrics stored for this video`);
    const parsed = parseLrc(doc.body);
    if (!parsed) return null;

    const hash = crypto.createHash('sha1').update(`${lang}\n${doc.body}`).digest('hex');
    const cached = this.repo.getRuby(hash, mode);
    if (cached) {
      const lines = JSON.parse(cached) as RubySegment[][];
      if (Array.isArray(lines) && lines.length === parsed.lines.length) {
        return { lang, mode, lines };
      }
    }

    const t0 = Date.now();
    let lines: RubySegment[][];
    if (lang === 'ko') {
      lines = parsed.lines.map((l) => segmentsKo(l.text));
    } else {
      const tok = await this.getTokenizer();
      lines = parsed.lines.map((l) =>
        segmentsJa(
          tok.tokenize(l.text).map((t) => ({
            surface: t.surface_form,
            reading: t.reading ?? null,
            pos: t.pos,
          })),
          mode,
        ),
      );
    }
    this.repo.putRuby(hash, mode, JSON.stringify(lines));
    console.log(
      `[ruby] ${videoId}/${source} ${lang} ${mode}: ${lines.length} lines in ${Date.now() - t0} ms`,
    );
    return { lang, mode, lines };
  }
}
