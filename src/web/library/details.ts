/**
 * What the sidebar's lower half shows: one model's details, a bundle's panel, or the multi-edit
 * panel for the selection. Clicking cards, the arrow keys, Ctrl/Cmd+A and filter changes move
 * between them. The panels' contents are React (src/web/details/); this shows, hides and fills them.
 */
import { useSyncExternalStore } from 'react';
import { models as modelApi } from '../api';
import { buildDisplayRecords, folderOf, normalizePath, type GridModel, type GridView, type GroupRecord } from '../grid/layout';
import { foldersAsModels } from './folderMode';
import { selection } from '../selection';
import { sidebarOn } from '../details/sidebarPref';
import { navigate } from '../shell/routes';
import { expandedGroups, listHooks, refreshGrid, shownModels } from './models';

const panel = (id: 'model-details' | 'bundle-details' | 'multi-edit-panel') => document.getElementById(id);

// ---- The model shown in the details panel ----

let detailsPath: string | null = null;
/** Bumped by every show/clear, so a slower load cannot fill the panel after a newer choice. */
let detailsToken = 0;

/** Keep the shown model's path on #path-tree-container (the phone header and the sidebar read it). */
function setDetailsPath(filePath: string | null) {
  const container = document.getElementById('path-tree-container');
  if (filePath) {
    container?.setAttribute('data-file-path', filePath);
    window.detailsPath?.show(filePath);
  } else {
    container?.removeAttribute('data-file-path');
    window.detailsPath?.clear();
  }
}

/** The model the details panel shows (null when the panel is hidden or empty). */
export function currentModelPath(): string | null {
  const details = panel('model-details');
  if (!details || details.classList.contains('hidden')) return null;
  return document.getElementById('path-tree-container')?.getAttribute('data-file-path') || null;
}

/** Empty the details panel. */
export function clearDetails() {
  detailsToken++;
  detailsPath = null;
  setDetailsPath(null);
  window.detailsFields?.clear();
  window.detailsNotes?.clear();
  window.detailsPrint?.clear();
  window.detailsHero?.clear();
}

/** Show a model in the details panel. */
export async function showModelDetails(filePath: string) {
  const token = ++detailsToken;
  detailsPath = filePath;
  try {
    const model = await modelApi.get<GridModel & Record<string, unknown>>(filePath);
    if (token !== detailsToken || !model) return;
    hideBundleDetails();
    const details = panel('model-details');
    if (!details) return;
    window.detailsFields?.show(model as never);
    setDetailsPath(model.filePath || '');
    window.detailsNotes?.show(model as never);
    window.detailsPrint?.show(model as never);
    window.detailsHero?.show(model as never);
    details.classList.remove('hidden');
    window.collapseSidebarFilters?.();
    requestAnimationFrame(() => details.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    panel('multi-edit-panel')?.classList.add('hidden');
    window.multiEdit?.open();
  } catch (error) {
    console.error('Error showing model details:', error);
  }
}

// ---- Bundle panel ----

let bundleGroupKey: string | null = null;

export const isBundleShown = (groupKey: string) => !!bundleGroupKey && bundleGroupKey === groupKey;

export function hideBundleDetails() {
  panel('bundle-details')?.classList.add('hidden');
  bundleGroupKey = null;
  window.bundleDetails?.clear();
  refreshGrid();
}

/** The archive (or folder) a bundle's models are in. */
function bundleContainer(record: GroupRecord): { path: string; kind: 'zip' | 'folder' } {
  const first = record.children?.[0];
  if (!first?.filePath) return { path: '', kind: 'folder' };
  if (first.bundleKind === 'zip' || first.filePath.includes('::')) return { path: first.filePath.split('::')[0], kind: 'zip' };
  const cut = Math.max(first.filePath.lastIndexOf('/'), first.filePath.lastIndexOf('\\'));
  return { path: cut >= 0 ? first.filePath.slice(0, cut) : first.filePath, kind: 'folder' };
}

export function showBundleDetails(record: GroupRecord) {
  if (!record?.children?.length) return;
  bundleGroupKey = record.groupKey;
  panel('model-details')?.classList.add('hidden');
  panel('multi-edit-panel')?.classList.add('hidden');
  window.collapseSidebarFilters?.();
  const bundle = panel('bundle-details') as (HTMLElement & { _bundleRecord?: GroupRecord }) | null;
  if (!bundle) return;
  // The phone header's 3D button reads it.
  bundle._bundleRecord = record;
  const container = bundleContainer(record);
  window.bundleDetails?.show({ record, kind: container.kind, containerPath: container.path } as never);
  bundle.classList.remove('hidden');
  requestAnimationFrame(() => bundle.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  refreshGrid();
}

// ---- Edit mode (the library header's Edit button) ----

/**
 * Edit mode: a click on a card chooses it instead of opening it. One model chosen: its details
 * in the sidebar; more (or a group): the Multi-edit panel for all of them.
 */
let multiEdit = false;
export const isMultiEdit = () => multiEdit;
const modeListeners = new Set<() => void>();

/** True while Edit mode is on (the header's Edit button). */
export function useEditMode(): boolean {
  return useSyncExternalStore(
    (listener) => {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    () => multiEdit
  );
}

function syncModeButton() {
  document.body.classList.toggle('jp-editing', multiEdit);
  modeListeners.forEach((listener) => listener());
}

/** Show the panel for what is chosen: one model's details, else Multi-edit. */
function showEditPanels() {
  if (!multiEdit) return;
  const paths = selection.values();
  if (paths.length === 1) {
    void showModelDetails(paths[0]);
    return;
  }
  detailsToken++;
  panel('model-details')?.classList.add('hidden');
  if (!panel('bundle-details')?.classList.contains('hidden')) {
    panel('bundle-details')?.classList.add('hidden');
    bundleGroupKey = null;
  }
  const multi = panel('multi-edit-panel');
  const wasHidden = !!multi?.classList.contains('hidden');
  multi?.classList.remove('hidden');
  if (wasHidden) window.multiEdit?.open();
  else window.multiEdit?.selectionChanged();
}

/** Turn Edit mode on with what is chosen. */
export function enterMultiEdit() {
  multiEdit = true;
  syncModeButton();
  showEditPanels();
  const multi = panel('multi-edit-panel');
  if (multi && !multi.classList.contains('hidden')) requestAnimationFrame(() => multi.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

/** Leave Edit mode: nothing chosen, the (empty) details panel. */
export function exitMultiEdit() {
  selection.clear();
  multiEdit = false;
  syncModeButton();
  panel('multi-edit-panel')?.classList.add('hidden');
  panel('model-details')?.classList.add('hidden');
  clearDetails();
  refreshGrid();
}

/** The Edit button and Ctrl/Cmd+E: from the details panel, start with its model; else switch modes. */
export function toggleMultiEdit(fromDetails = false) {
  if (fromDetails) {
    const current = currentModelPath();
    if (current) selection.add(current);
    return enterMultiEdit();
  }
  if (multiEdit) return exitMultiEdit();
  // The Edit button starts with nothing chosen: the next click chooses the model to edit.
  selection.clear();
  enterMultiEdit();
}

/** Select every model the filters show (not only the drawn cards). */
export async function selectAllShown() {
  try {
    const models = (await window.getCombinedFilteredModels?.()) as { filePath?: string }[] | undefined;
    selection.set((models || []).map((m) => m?.filePath).filter((p): p is string => !!p));
  } catch (error) {
    console.error('Error selecting all models:', error);
  }
}

// ---- Selection and filters ----

/** The result set is about to change (a filter changed): drop the selection and details. */
export function resetSelectionAndDetails() {
  detailsToken++;
  selection.clear();
  clearDetails();
  // Edit mode stays on, with nothing chosen.
  if (multiEdit) showEditPanels();
}

/** A filtered result came back: keep only selected models it has, and the details only if shown. */
export function syncSelectionWithModels(models: GridModel[]) {
  const shown = new Set(models.filter((m) => m?.filePath).map((m) => normalizePath(m.filePath)));
  selection.retain((path) => shown.has(normalizePath(path)));
  if (multiEdit) return showEditPanels();
  const paths = [detailsPath, document.getElementById('path-tree-container')?.getAttribute('data-file-path')].filter((p): p is string => !!p);
  if (!paths.length && selection.size === 0) return;
  const stillShown = paths.some((p) => shown.has(normalizePath(p))) || selection.values().some((p) => shown.has(normalizePath(p)));
  if (!stillShown) clearDetails();
}
listHooks.syncSelection = syncSelectionWithModels;
listHooks.isMultiEdit = () => multiEdit;

/** Up/Down (J/K) in the details panel: the next or previous card. False when there is none. */
export function navigateDetails(direction: 'next' | 'previous'): boolean {
  if (panel('model-details')?.classList.contains('hidden')) return false;
  const cards = [...document.querySelectorAll<HTMLElement>('.file-item')];
  if (!cards.length) return false;
  const current = normalizePath(currentModelPath() || detailsPath || '');
  let index = current ? cards.findIndex((card) => normalizePath(card.dataset.filepath) === current) : -1;
  if (index < 0) index = cards.findIndex((card) => card.classList.contains('selected'));
  if (index < 0) index = 0;
  const target = cards[direction === 'next' ? index + 1 : index - 1];
  const filePath = target?.dataset.filepath;
  if (!filePath) return false;
  selection.set([filePath]);
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showModelDetails(filePath);
  return true;
}

/** Select a model without opening its details (the server's "show this model"). */
export const highlightModel = (filePath: string) => {
  if (filePath) selection.set([filePath]);
};

// ---- Cards ----

type TapCard = HTMLElement & { _suppressTap?: boolean; _suppressTapTimer?: ReturnType<typeof setTimeout> };

/** A touch long-press is followed by a tap; ignore that tap. */
function suppressTap(card: TapCard, ms = 600) {
  card._suppressTap = true;
  clearTimeout(card._suppressTapTimer);
  card._suppressTapTimer = setTimeout(() => {
    card._suppressTap = false;
  }, ms);
}

function tapSuppressed(card: TapCard, event?: { preventDefault(): void; stopPropagation(): void } | null) {
  if (!card?._suppressTap) return false;
  event?.preventDefault();
  event?.stopPropagation();
  return true;
}

/** Long-press (550 ms, finger still) on a card calls onLongPress, and swallows the tap after. */
function bindLongPress(card: TapCard, onLongPress: (x: number, y: number) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let x = 0;
  let y = 0;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  card.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      ({ clientX: x, clientY: y } = e.touches[0]);
      cancel();
      timer = setTimeout(() => {
        timer = null;
        suppressTap(card);
        onLongPress(x, y);
      }, 550);
    },
    { passive: true }
  );
  card.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (timer && t && (Math.abs(t.clientX - x) > 14 || Math.abs(t.clientY - y) > 14)) cancel();
    },
    { passive: true }
  );
  const end = (e: Event) => {
    cancel();
    if (card._suppressTap) e.preventDefault();
  };
  card.addEventListener('touchend', end);
  card.addEventListener('touchcancel', end);
  card.addEventListener(
    'click',
    (e) => {
      tapSuppressed(card, e);
    },
    true
  );
}

/** The menu acts on the whole selection when the clicked model is part of it (or in multi-edit). */
function menuTarget(filePath: string): string | string[] {
  const selected = selection.values();
  if (selected.length > 1 && (selection.has(filePath) || multiEdit)) return selected;
  return filePath || selected[0];
}

/** A long press (touch screens) opens the model menu; the mouse uses the card's ⋯ button. */
export function bindCardMenu(card: TapCard, filePath: string) {
  bindLongPress(card, (clientX, clientY) => {
    suppressTap(card);
    window.contextMenu?.show(menuTarget(filePath), clientX, clientY);
  });
}

/** The card's ⋯ button: the model menu. */
export function showCardMenu(filePath: string, x: number, y: number) {
  window.contextMenu?.show(menuTarget(filePath), x, y);
}

/** A plain click: select the card and show its details (a second click unselects), or toggle it in multi-edit. */
function toggleCard(card: TapCard, filePath: string) {
  if (card?._suppressTap) return;
  if (multiEdit) {
    selection.toggle(filePath);
    return showEditPanels();
  }
  // Sidebar off: the model's page instead.
  if (!sidebarOn()) {
    selection.set([filePath]);
    navigate('model', filePath);
    return;
  }
  if (selection.size === 1 && selection.has(filePath)) {
    selection.clear();
    panel('model-details')?.classList.add('hidden');
    return;
  }
  selection.set([filePath]);
  showModelDetails(filePath);
}

// ---- Shift-click: a range of cards ----

type CardRef = { kind: 'model'; path: string } | { kind: 'group'; key: string };

/** The card clicked last: where a Shift-click range starts. */
let anchor: CardRef | null = null;

/**
 * Shift-click: choose every card from the one clicked last to this one, in the grid's order (a
 * bundle's or folder's card as its models), in Edit mode.
 */
function chooseRange(target: CardRef) {
  const records = buildDisplayRecords(shownModels(), expandedGroups, { folders: foldersAsModels() });
  const indexOf = (ref: CardRef) =>
    records.findIndex((record) =>
      ref.kind === 'model'
        ? record.type === 'model' && normalizePath(record.model.filePath) === normalizePath(ref.path)
        : record.type === 'group' && record.groupKey === ref.key
    );
  const to = indexOf(target);
  if (to < 0) return;
  const from = anchor ? indexOf(anchor) : -1;
  const [first, last] = from < 0 ? [to, to] : from < to ? [from, to] : [to, from];
  const paths: string[] = [];
  for (const record of records.slice(first, last + 1)) {
    if (record.type === 'model') {
      if (record.model.filePath) paths.push(record.model.filePath);
      continue;
    }
    const children = record.children.map((child) => child.filePath).filter((p): p is string => !!p);
    // An expanded bundle's models follow as cards of their own.
    if (!record.expanded) paths.push(...children);
  }
  window.getSelection()?.removeAllRanges();
  selection.set(paths);
  if (!multiEdit) {
    multiEdit = true;
    syncModeButton();
  }
  refreshGrid();
  showEditPanels();
}

export function cardClick(event: MouseEvent, card: TapCard, filePath: string, view: GridView) {
  if (tapSuppressed(card, event)) return;
  if (event.shiftKey) {
    event.preventDefault();
    return chooseRange({ kind: 'model', path: filePath });
  }
  anchor = { kind: 'model', path: filePath };
  if (event.ctrlKey || event.metaKey) {
    // Ctrl/Cmd-click starts multi-edit with this card, or toggles it in multi-edit.
    event.preventDefault();
    if (!multiEdit) {
      selection.set([filePath]);
      enterMultiEdit();
    } else {
      selection.toggle(filePath);
      showEditPanels();
    }
    return;
  }
  toggleCard(card, filePath);
}

/** A card's checkbox: choose or unchoose it (starting the selection, with Multi-edit for more than one). */
export function checkCard(filePath: string) {
  anchor = { kind: 'model', path: filePath };
  if (!multiEdit) {
    selection.set([filePath]);
    enterMultiEdit();
    return;
  }
  selection.toggle(filePath);
  showEditPanels();
}

/** Double-click (or the preview button): the 3D preview, also selecting the card when asked. */
export function openCardPreview(card: HTMLElement | null, filePath: string, select: boolean) {
  if (select && card) selection.set([filePath]);
  window.openPreview?.(filePath);
}

// ---- Groups ----

const expandedSet = (record: GroupRecord) => (record.groupKind === 'folder' ? expandedGroups.folders : expandedGroups.bundles);

/** Expand or collapse a group; collapsing the bundle whose panel is open closes it. */
export function toggleGroup(record: GroupRecord) {
  const expanded = expandedSet(record);
  if (expanded.has(record.groupKey)) {
    expanded.delete(record.groupKey);
    if (record.groupKind === 'bundle' && bundleGroupKey === record.groupKey) return hideBundleDetails();
  } else {
    expanded.add(record.groupKey);
  }
  refreshGrid();
}

function expandGroup(record: GroupRecord) {
  const expanded = expandedSet(record);
  if (!expanded.has(record.groupKey)) {
    expanded.add(record.groupKey);
    refreshGrid();
  }
  if (record.groupKind === 'bundle') showBundleDetails(record);
}

/**
 * Click on a bundle or folder card: a ZIP bundle expands or collapses (and shows its panel), a
 * folder (Folders as models) opens its page; in Edit mode it chooses its models.
 */
export function groupClick(record: GroupRecord, view: GridView, card: TapCard, shiftKey = false) {
  if (tapSuppressed(card)) return;
  if (shiftKey) return chooseRange({ kind: 'group', key: record.groupKey });
  anchor = { kind: 'group', key: record.groupKey };
  if (multiEdit) {
    const paths = record.children.map((child) => child.filePath).filter((p): p is string => !!p);
    if (paths.every((p) => selection.has(p))) {
      for (const p of paths) selection.delete(p);
    } else {
      for (const p of paths) selection.add(p);
    }
    refreshGrid();
    return showEditPanels();
  }
  // Folders as models: the folder's page (its arrow still expands it in the grid).
  if (record.groupKind === 'folder') {
    const folder = folderOf(record.children[0] || { filePath: '' });
    if (folder) navigate('folder', folder);
    return;
  }
  if (!expandedSet(record).has(record.groupKey)) expandGroup(record);
  else toggleGroup(record);
}

/** A bundle or folder card is drawn chosen in Edit mode when all its models are chosen. */
export const isGroupChosen = (record: GroupRecord) =>
  multiEdit && record.children.length > 0 && record.children.every((child) => !!child.filePath && selection.has(child.filePath));

/** Right-click and long-press menu for a group (Preview, and the actions for its models). */
export function bindGroupMenu(card: TapCard, record: GroupRecord) {
  card.addEventListener('contextmenu', (event) => {
    if ((event as MouseEvent & { pointerType?: string }).pointerType !== 'mouse') suppressTap(card);
    event.preventDefault();
    event.stopPropagation();
    const paths = record.children.map((c) => c?.filePath).filter((p): p is string => !!p);
    if (!paths.length) return;
    const target =
      record.groupKind === 'bundle' || paths.length > 1 ? { filePaths: paths, groupLabel: record.groupLabel || 'Group', previewAsBundle: true } : paths[0];
    window.contextMenu?.show(target, event.clientX, event.clientY);
  });
  bindLongPress(card, (clientX, clientY) => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY })));
}

// ---- The grid's background and the mode buttons ----

function isGridBackground(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('dialog, .modal, #html-context-menu, #html-context-menu-backdrop, .file-item, .parent-model-group, .list-view-header')) return false;
  if (target.closest('.sidebar, #folder-rail, #folder-tree-popover, .grid-view-selector, #model-details, #bundle-details, #multi-edit-panel')) return false;
  if (target.closest('button, a, input, select, textarea, label')) return false;
  return !!target.closest('.file-grid');
}

/** A click on empty grid space unselects (not in multi-edit, not on the scrollbar). */
function bindGridBackground() {
  const grid = document.querySelector<HTMLElement>('.file-grid');
  if (!grid) return;
  grid.addEventListener('click', (event) => {
    if (multiEdit || !isGridBackground(event.target)) return;
    const rect = grid.getBoundingClientRect();
    if (event.clientX - rect.left >= grid.clientWidth || event.clientY - rect.top >= grid.clientHeight) return;
    clearDetails();
    selection.clear();
    panel('model-details')?.classList.add('hidden');
    if (!panel('bundle-details')?.classList.contains('hidden')) hideBundleDetails();
  });
}

if (typeof document !== 'undefined') {
  bindGridBackground();
}
