/**
 * The folder tree's width (the --folder-tree-width CSS variable, saved as a setting), and the
 * drag that resizes it.
 */
import { settings } from '../api';

export const FOLDERS = { setting: 'folderTreeWidth', min: 180, max: 560, initial: 280, cssVar: '--folder-tree-width' };

type Panel = typeof FOLDERS;

const widths = new Map<Panel, number>([[FOLDERS, FOLDERS.initial]]);

export function clampWidth(panel: Panel, px: number, max = panel.max): number {
  return Math.min(Math.max(panel.min, max), Math.max(panel.min, Math.round(px)));
}

export function getWidth(panel: Panel): number {
  return widths.get(panel) ?? panel.initial;
}

function applyWidth(panel: Panel, px: number, max?: number) {
  const width = clampWidth(panel, px, max);
  widths.set(panel, width);
  document.documentElement.style.setProperty(panel.cssVar, `${width}px`);
}

export async function loadSavedWidths() {
  for (const panel of [FOLDERS]) {
    try {
      const saved = parseInt(String(await settings.get<string | null>(panel.setting)), 10);
      if (Number.isFinite(saved) && saved > 0) applyWidth(panel, saved);
    } catch {
      /* keep the default */
    }
  }
}

/**
 * Mouse-down handler for a resize handle: drag to change the panel's width, saved on release.
 * `maxWidth` limits it further (the popover must stay on screen).
 */
export function startResize(panel: Panel, maxWidth?: () => number) {
  return (event: { button: number; clientX: number; preventDefault(): void; stopPropagation(): void; currentTarget: EventTarget }) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startWidth = getWidth(panel);
    const max = maxWidth?.();
    handle.classList.add('is-active');
    document.body.classList.add('is-panel-resizing');
    const onMove = (move: MouseEvent) => applyWidth(panel, startWidth + (move.clientX - startX), max);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('is-active');
      document.body.classList.remove('is-panel-resizing');
      settings.save(panel.setting, String(getWidth(panel))).catch(() => {});
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}
