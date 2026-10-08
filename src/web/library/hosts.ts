/**
 * The objects the React screens ask the library through (window.gridHost, detailsHost, …), and
 * the page globals other modules and scripts call (PrintHistory, search.ts, ManageThumbnailsDialog).
 */
import { callAction } from '../api';
import { runSearch } from '../filters/search';
import type { GridModel } from '../grid/layout';
import { selection } from '../selection';
import { syncThumbnailFromField } from '../thumbnails/cache';
import {
  bindCardMenu, bindGroupMenu, cardClick, currentModelPath, exitMultiEdit, groupClick, isBundleShown,
  isMultiEdit, navigateDetails, openCardPreview, resetSelectionAndDetails, selectAllShown, showCardMenu, showModelDetails,
  syncSelectionWithModels, toggleGroup, toggleMultiEdit, enterMultiEdit
} from './details';
import { changeGroupTags, groupImagesVersion, groupListColumns, groupPrintSummary, groupTagNames, invalidateGroupImages, loadGroupImages } from './groups';
import { isModelNew } from './match';
import { expandedGroups, mergeModel, rebuildGrid, refreshGrid, showModels, shownModels, updateModel } from './models';
import { directoryLabel, folderFilterFor, formatFileSize, parentDirectory } from './paths';
import { openSourceUrl, removeFromSelected, saveEngagement, saveModelField, saveSelectedField } from './saving';

const tagNames = (tags: unknown): string[] => (Array.isArray(tags) ? tags : [])
  .map((t) => (typeof t === 'string' ? t : (t as { name?: string })?.name || '')).filter(Boolean)
  .sort((a, b) => String(a).localeCompare(String(b)));

/** Reload the pickers that list a kind of value (after one was added, renamed or removed). */
function reloadPickers(kind?: string) {
  window.libraryFilters?.reloadOptions();
  window.detailsFields?.reloadOptions();
  window.multiEdit?.reloadOptions();
  if (kind === 'tag') {
    window.bundleDetails?.reloadOptions();
    window.reloadTagManager?.();
  }
}

/** Filter by a tag clicked on a card. */
async function filterByTag(name: string) {
  const tag = name?.trim();
  if (!tag) return;
  resetSelectionAndDetails();
  window.setTagMultiFilter?.([tag]);
  await runSearch({ force: true });
}

function filterBySelect(selectId: string, value: string) {
  window.libraryFilters?.setFromSelect(selectId, value);
  runSearch({ force: true });
}

window.gridHost = {
  models: shownModels,
  rebuild: rebuildGrid,
  expanded: () => expandedGroups,
  isSelected: (filePath) => selection.has(filePath),
  // The phone's bottom bar (0 when it is hidden: offsetHeight of a display:none element).
  bottomChrome: () => document.getElementById('jp-bottom-nav')?.offsetHeight || 0,

  // Model cards
  isNew: (model) => isModelNew(model as { isNew?: unknown }),
  directoryLabel,
  directoryFullPath: parentDirectory,
  formatSize: formatFileSize,
  cardClick,
  openPreview: openCardPreview,
  bindCardMenu,
  showCardMenu,
  filterByDirectory: (filePath) => { window.folderTree?.show(folderFilterFor(filePath)); },
  filterBySelect,
  filterByTag: (name) => { filterByTag(name); },
  saveField: (filePath, field, value) => saveModelField(field, value, filePath),
  tagNames: async (model) => {
    let id = model.id;
    if (!id && model.filePath) {
      const full = await callAction<{ id?: number; tags?: unknown[] } | null>('get-model', model.filePath);
      if (full?.tags?.length) return tagNames(full.tags);
      id = full?.id;
    }
    return id ? tagNames(await callAction<unknown[]>('get-model-tags', id)) : [];
  },
  printBadge: (element, model) => {
    window.PrintHistory?.applyBadge(element, model as never);
    window.PrintHistory?.bindBadge(element, model.filePath);
  },

  // Group cards
  groupThumbnailVersion: groupImagesVersion,
  loadGroupThumbnails: loadGroupImages,
  groupListColumns,
  groupPrintSummary,
  groupTagNames,
  groupClick,
  toggleGroup,
  bindGroupMenu,
  isBundleDetailsGroup: isBundleShown,
  openBundlePreview: (record) => { window.openBundlePreview?.(record as never); },
  saveGroupField: saveEngagement
};

window.detailsHost = {
  saveField: (filePath, field, value, base) => saveModelField(field, value, filePath, base),
  openSource: (url) => { openSourceUrl(url); },
  valuesChanged: async (kind) => reloadPickers(kind)
};

window.multiEditHost = {
  selectedPaths: () => selection.values(),
  exit: exitMultiEdit,
  selectAllVisible: selectAllShown,
  clearSelection: () => {
    selection.clear();
    window.multiEdit?.open();
  },
  saveField: (field, value) => saveSelectedField(field, value),
  removeFromSelected,
  openSource: (url) => { openSourceUrl(url); }
};

window.bundleHost = {
  openModel: (filePath) => { showModelDetails(filePath); },
  tagNames: groupTagNames,
  changeTags: changeGroupTags,
  tagCreated: async () => reloadPickers('tag')
};

window.sidebarHost = { resetSelection: resetSelectionAndDetails };

window.shortcutHost = {
  multiEdit: isMultiEdit,
  exitMultiEdit,
  navigate: navigateDetails,
  toggleMultiEdit,
  selectAll: async () => {
    await selectAllShown();
    if (!isMultiEdit() && selection.size > 0) enterMultiEdit();
    else if (isMultiEdit()) window.multiEdit?.open();
  }
};

/** Manage Thumbnails changed the default image: redraw the card, or search again when it is not shown. */
async function refreshModelThumbnails(filePath: string) {
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    const model = await callAction<GridModel & { thumbnail?: string } | null>('get-model', filePath);
    if (!model) return;
    syncThumbnailFromField(filePath, model.thumbnail);
    if (mergeModel({ ...model })) refreshGrid();
    else await runSearch();
  } catch (error) {
    console.error('Error refreshing the grid after a thumbnail change:', error);
  }
}

declare global {
  interface Window {
    updateModelElement?: (filePath: string) => Promise<void>;
    getCurrentModelFilePath?: () => string | null;
    refreshModelThumbnails?: (filePath: string) => Promise<void>;
    reloadTagManager?: () => void;
    setTagMultiFilter?: (names: string[]) => void;
  }
}

// search.ts hands results to the grid through these.
window.renderFiles = async (models) => showModels(models as GridModel[]);
window.syncSelectionWithFilteredModels = (models) => syncSelectionWithModels(models as GridModel[]);
window.updateModelElement = updateModel;
window.getCurrentModelFilePath = currentModelPath;
window.invalidateGroupThumbnailCache = () => invalidateGroupImages();
window.refreshModelThumbnails = refreshModelThumbnails;
window.refreshModelDisplay = () => runSearch({ force: true });
