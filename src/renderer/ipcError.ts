/**
 * Human-readable message from a rejected `window.karaoke.*` call. Electron
 * wraps main-side throws as "Error invoking remote method 'x:y': Name: msg";
 * only the message is useful to a person.
 */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^[A-Za-z]*Error:\s*/, '');
}
