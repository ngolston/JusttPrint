/**
 * Filaments: the hooks that reload the filament pickers and the sidebar's filament filter.
 * The pickers are React (src/web/details/DetailsFilaments.tsx and MultiEditPanel.tsx); the
 * Filament Manager is React too (src/web/FilamentManagerDialog.tsx).
 */
(function () {
  function formatFilamentLabel(filament) {
    const vendor = String(filament?.vendor || '').trim();
    const name = String(filament?.name || '').trim();
    const material = String(filament?.material || '').trim();
    const base = [vendor, name].filter(Boolean).join(' ') || 'Unnamed filament';
    return material ? `${base} (${material})` : base;
  }

  function filamentIdOf(value) {
    if (value == null) return null;
    if (typeof value === 'object') return Number(value.id);
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /** The Filament Manager (React) calls these after catalog changes and when it closes. */
  async function refreshFilamentPickers() {
    await populateFilamentSelect();
    await populateFilamentFilter();
  }

  async function refreshAfterFilamentManagerClose() {
    try {
      await refreshFilamentPickers();
      const currentModelPath = (typeof getCurrentModelFilePath === 'function' && getCurrentModelFilePath())
        || (typeof currentModelDetailsPath !== 'undefined' ? currentModelDetailsPath : null);
      if (currentModelPath) {
        await loadModelFilaments(currentModelPath);
      }
      if (typeof window.performCombinedSearch === 'function') {
        await window.performCombinedSearch();
      }
    } catch (error) {
      console.error('Error refreshing after filament manager close:', error);
    }
  }

  function wireFilamentManagerEvents() {
    window._electronRealEventHandlers = window._electronRealEventHandlers || {};
    window._electronRealEventHandlers['open-filament-manager'] = function () {
      window.openFilamentManager?.();
    };
    if (window._electronPendingEvents?.['open-filament-manager']) {
      window._electronPendingEvents['open-filament-manager'].forEach((args) => {
        window._electronRealEventHandlers['open-filament-manager'].apply(null, args);
      });
      delete window._electronPendingEvents['open-filament-manager'];
    }
  }

  /** Add a filament to the model in the details panel. */
  async function addFilamentToModel(filament) {
    await window.detailsFilaments?.add(filamentIdOf(filament));
  }

  /** Reload the details panel's filaments from the server. */
  async function loadModelFilaments(filePath) {
    await window.detailsFilaments?.load(filePath);
  }

  /** Reload the filament pickers (the catalog changed). */
  async function populateFilamentSelect() {
    await window.detailsFilaments?.reloadOptions();
    window.multiEdit?.reloadOptions();
  }

  /** The sidebar's filament filter is React (src/web/filters/Sidebar.tsx); it loads its own options. */
  async function populateFilamentFilter() {
    window.libraryFilters?.reloadOptions();
  }


  /** The filaments on the selected models changed. */
  async function populateRemoveFilamentSelect() {
    window.multiEdit?.selectionChanged();
  }

  function updateModelFilamentDisplay(existingElement) {
    if (!existingElement) return;
    existingElement.querySelectorAll('.filaments-info-column, .filaments-item').forEach((el) => el.remove());
  }

  async function initializeFilaments() {
    wireFilamentManagerEvents();
    await populateFilamentFilter();
  }

  window.formatFilamentLabel = formatFilamentLabel;
  window.refreshFilamentPickers = refreshFilamentPickers;
  window.refreshAfterFilamentManagerClose = refreshAfterFilamentManagerClose;
  window.loadModelFilaments = loadModelFilaments;
  window.populateFilamentSelect = populateFilamentSelect;
  window.populateFilamentFilter = populateFilamentFilter;
  window.populateRemoveFilamentSelect = populateRemoveFilamentSelect;
  window.addFilamentToModel = addFilamentToModel;
  window.updateModelFilamentDisplay = updateModelFilamentDisplay;
  window.initializeFilaments = initializeFilaments;
  function boot() {
    initializeFilaments().catch((err) => console.error('Error initializing filaments:', err));
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
