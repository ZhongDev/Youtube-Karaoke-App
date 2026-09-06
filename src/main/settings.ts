import type Database from 'better-sqlite3';
import {
  DEFAULT_SETTINGS,
  LYRICS_MODES,
  PROVIDER_IDS,
  RUBY_MODES,
  type LyricsMode,
  type RubyMode,
  type Settings,
  type SettingsPatch,
} from '../shared/ipc';

// Settings live in the `settings(key, value)` table as one row per leaf
// (e.g. 'provider.netease' = '1', 'ollama.endpoint' = 'http://…'). Missing
// rows mean the default, so adding a setting never needs a migration.

export class SettingsStore {
  constructor(private db: Database.Database) {}

  private raw(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? undefined;
  }

  private write(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  get(): Settings {
    const providers = { ...DEFAULT_SETTINGS.providers };
    for (const id of PROVIDER_IDS) {
      const v = this.raw(`provider.${id}`);
      if (v !== undefined) providers[id] = v === '1';
    }
    const enabled = this.raw('ollama.enabled');
    const mode = this.raw('display.lyricsMode');
    const ruby = this.raw('display.ruby');
    return {
      providers,
      ollama: {
        enabled: enabled === undefined ? DEFAULT_SETTINGS.ollama.enabled : enabled === '1',
        endpoint: this.raw('ollama.endpoint') ?? DEFAULT_SETTINGS.ollama.endpoint,
        model: this.raw('ollama.model') ?? DEFAULT_SETTINGS.ollama.model,
      },
      display: {
        lyricsMode: (LYRICS_MODES as readonly string[]).includes(mode ?? '')
          ? (mode as LyricsMode)
          : DEFAULT_SETTINGS.display.lyricsMode,
        ruby: (RUBY_MODES as readonly string[]).includes(ruby ?? '')
          ? (ruby as RubyMode)
          : DEFAULT_SETTINGS.display.ruby,
      },
      ytdlp: {
        path: this.raw('ytdlp.path') ?? DEFAULT_SETTINGS.ytdlp.path,
      },
    };
  }

  /** Apply a validated patch; unknown keys are ignored. Returns the result. */
  set(patch: SettingsPatch): Settings {
    this.db.transaction(() => {
      for (const id of PROVIDER_IDS) {
        const v = patch.providers?.[id];
        if (typeof v === 'boolean') this.write(`provider.${id}`, v ? '1' : '0');
      }
      const o = patch.ollama;
      if (o) {
        if (typeof o.enabled === 'boolean') this.write('ollama.enabled', o.enabled ? '1' : '0');
        if (typeof o.endpoint === 'string') {
          this.write('ollama.endpoint', o.endpoint.trim().replace(/\/+$/, ''));
        }
        if (typeof o.model === 'string') this.write('ollama.model', o.model.trim());
      }
      const d = patch.display;
      if (d) {
        if (d.lyricsMode && LYRICS_MODES.includes(d.lyricsMode)) {
          this.write('display.lyricsMode', d.lyricsMode);
        }
        if (d.ruby && RUBY_MODES.includes(d.ruby)) this.write('display.ruby', d.ruby);
      }
      if (typeof patch.ytdlp?.path === 'string') this.write('ytdlp.path', patch.ytdlp.path.trim());
    })();
    return this.get();
  }
}
