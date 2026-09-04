import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../shared/ipc';

// Renderer copy of the persisted settings. Main is the source of truth: every
// update sends a patch and adopts whatever main returns.

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let alive = true;
    window.karaoke
      .settingsGet()
      .then((s) => alive && setSettings(s))
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(async (patch: SettingsPatch): Promise<Settings> => {
    const s = await window.karaoke.settingsSet(patch);
    setSettings(s);
    return s;
  }, []);

  return { settings: settings ?? DEFAULT_SETTINGS, loaded: settings !== null, update };
}
