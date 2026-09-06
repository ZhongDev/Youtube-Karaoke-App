import { BrowserWindow, screen } from 'electron';
import type { DisplayInfo } from '../shared/ipc';

// TV mode (SPEC.md §7): native macOS fullscreen, optionally on a chosen
// display — the window is parked inside that display first, because a
// fullscreen window cannot be moved between screens.

export function listDisplays(win: BrowserWindow): DisplayInfo[] {
  const current = screen.getDisplayMatching(win.getBounds()).id;
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: d.label || `Display ${i + 1}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === primary,
    current: d.id === current,
  }));
}

export async function setFullscreen(
  win: BrowserWindow,
  on: boolean,
  displayId?: number,
): Promise<void> {
  if (!on) {
    if (win.isFullScreen()) await transition(win, false);
    return;
  }
  const target =
    displayId === undefined ? null : screen.getAllDisplays().find((d) => d.id === displayId);
  const current = screen.getDisplayMatching(win.getBounds());
  if (target && target.id !== current.id) {
    if (win.isFullScreen()) await transition(win, false);
    const { x, y, width, height } = target.workArea;
    const b = win.getBounds();
    win.setBounds({
      x: x + 40,
      y: y + 40,
      width: Math.min(width - 80, b.width),
      height: Math.min(height - 80, b.height),
    });
  }
  if (!win.isFullScreen()) await transition(win, true);
}

/** setFullScreen + wait for the animation's event (bounded — never hang IPC). */
function transition(win: BrowserWindow, on: boolean): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (on) win.removeListener('enter-full-screen', done);
      else win.removeListener('leave-full-screen', done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    if (on) win.once('enter-full-screen', done);
    else win.once('leave-full-screen', done);
    win.setFullScreen(on);
  });
}
