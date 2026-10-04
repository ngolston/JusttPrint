/**
 * Filaments on models: assignment pickers, the sidebar filter and card chips.
 * The Filament Manager (catalog and Spoolman) is React: src/web/FilamentManagerDialog.tsx.
 */
(function () {
  function formatFilamentLabel(filament) {
    const vendor = String(filament?.vendor || '').trim();
    const name = String(filament?.name || '').trim();
    const material = String(filament?.material || '').trim();
    const base = [vendor, name].filter(Boolean).join(' ') || 'Unnamed filament';
    return material ? `${base} (${material})` : base;
  }

  function normalizeColorHex(hex) {
    if (!hex) return '';
    let h = String(hex).replace(/^#/, '').trim();
    if (h.includes(',')) h = h.split(',')[0].trim();
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : '';
  }

  function colorCss(hex) {
    const n = normalizeColorHex(hex);
    return n ? `#${n}` : 'transparent';
  }

  function filamentIdOf(value) {
    if (value == null) return null;
    if (typeof value === 'object') return Number(value.id);
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** The Filament Manager (React) calls these after catalog changes and when it closes. */
  async function refreshFilamentPickers() {
    await populateFilamentSelect('filament-select', 'model-filaments');
    await populateFilamentSelect('multi-filament-select', 'multi-filaments');
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

  function currentFilamentIds(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.filament-chip'))
      .map((el) => Number(el.getAttribute('data-filament-id')))
      .filter((id) => Number.isInteger(id) && id > 0);
  }

  async function addFilamentToModel(filament, containerId, options = {}) {
    const { skipSave = false } = options;
    const tagContainer = document.getElementById(containerId);
    if (!tagContainer) return;
    const id = filamentIdOf(filament);
    if (!id) return;
    const existing = tagContainer.querySelector(`.filament-chip[data-filament-id="${id}"]`);
    if (existing) return;

    let record = filament;
    if (typeof filament !== 'object' || !filament.name) {
      try {
        const all = await window.electron.getAllFilaments();
        record = (all || []).find((f) => Number(f.id) === id) || { id, name: String(filament) };
      } catch (_) {
        record = { id, name: String(id) };
      }
    }

    const chip = document.createElement('div');
    chip.className = 'filament-chip';
    chip.setAttribute('data-filament-id', String(id));
    chip.setAttribute('title', formatFilamentLabel(record));
    chip.innerHTML = `
      <span class="filament-swatch" style="background:${colorCss(record.color_hex)}"></span>
      <span class="filament-chip-text">${escapeHtml(formatFilamentLabel(record))}</span>
      <span class="filament-chip-remove">×</span>
    `;
    chip.querySelector('.filament-chip-remove')?.addEventListener('click', async () => {
      chip.remove();
      const ids = currentFilamentIds(containerId);
      if (containerId === 'multi-filaments') {
        await autoSaveMultipleModels('filaments', ids, { replaceFilaments: true });
      } else {
        const filePath = typeof getModelFilePath === 'function' ? getModelFilePath() : null;
        if (filePath) await autoSaveModel('filaments', ids, filePath);
      }
      await window.populateFilamentSelect?.(containerId === 'multi-filaments' ? 'multi-filament-select' : 'filament-select', containerId);
    });
    tagContainer.appendChild(chip);

    if (skipSave) return;

    if (containerId === 'multi-filaments') {
      await autoSaveMultipleModels('filaments', [id]);
    } else {
      const filePath = typeof getModelFilePath === 'function' ? getModelFilePath() : null;
      if (filePath) await autoSaveModel('filaments', currentFilamentIds(containerId), filePath);
    }
    await window.populateFilamentSelect?.(containerId === 'multi-filaments' ? 'multi-filament-select' : 'filament-select', containerId);
  }

  async function loadModelFilaments(modelIdOrPath) {
    const container = document.getElementById('model-filaments');
    if (!container) return;
    container.innerHTML = '';
    try {
      const model = await window.electron.getModel(modelIdOrPath);
      if (!model || !model.id) return;
      const filaments = await window.electron.getModelFilaments(model.id);
      const list = Array.isArray(filaments) ? filaments : [];
      list.sort((a, b) => formatFilamentLabel(a).localeCompare(formatFilamentLabel(b)));
      for (const filament of list) {
        await addFilamentToModel(filament, 'model-filaments', { skipSave: true });
      }
      await window.populateFilamentSelect?.('filament-select', 'model-filaments');
    } catch (error) {
      console.error('Error loading model filaments:', error);
    }
  }

  async function populateFilamentSelect(selectId = 'filament-select', containerId = 'model-filaments') {
    const select = document.getElementById(selectId);
    if (!select) return;
    const selected = new Set(currentFilamentIds(containerId).map(String));
    select.innerHTML = '<option value="">Select a filament...</option>';
    try {
      const filaments = await window.electron.getAllFilaments();
      (filaments || [])
        .slice()
        .sort((a, b) => formatFilamentLabel(a).localeCompare(formatFilamentLabel(b)))
        .forEach((filament) => {
          if (selected.has(String(filament.id))) return;
          const option = document.createElement('option');
          option.value = String(filament.id);
          option.textContent = formatFilamentLabel(filament);
          select.appendChild(option);
        });
    } catch (error) {
      console.error('Error fetching filaments:', error);
    }
  }

  async function populateFilamentFilter() {
    const select = document.getElementById('filament-filter');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '<option value="">All Filaments</option>';
    window.filamentLabelById = window.filamentLabelById || {};
    try {
      const filaments = await window.electron.getAllFilaments();
      (filaments || [])
        .slice()
        .sort((a, b) => formatFilamentLabel(a).localeCompare(formatFilamentLabel(b)))
        .forEach((filament) => {
          const label = formatFilamentLabel(filament);
          window.filamentLabelById[String(filament.id)] = label;
          const option = document.createElement('option');
          option.value = String(filament.id);
          option.textContent = `${label} (${filament.model_count || 0})`;
          select.appendChild(option);
        });
      if (previous && Array.from(select.options).some((o) => o.value === previous)) {
        select.value = previous;
      }
    } catch (error) {
      console.error('Error populating filament filter:', error);
    }
  }

  async function populateRemoveFilamentSelect() {
    const select = document.getElementById('multi-filament-remove-select');
    if (!select) return;
    select.innerHTML = '<option value="">Select a filament to remove...</option>';
    if (typeof selectedModels === 'undefined' || selectedModels.size === 0) return;
    try {
      const filePaths = Array.from(selectedModels);
      const lists = await Promise.all(filePaths.map(async (filePath) => {
        try {
          const model = await window.electron.getModel(filePath);
          return Array.isArray(model?.filaments) ? model.filaments : [];
        } catch (_) {
          return [];
        }
      }));
      const byId = new Map();
      lists.flat().forEach((f) => {
        const id = filamentIdOf(f);
        if (id && !byId.has(id)) byId.set(id, f);
      });
      Array.from(byId.values())
        .sort((a, b) => formatFilamentLabel(a).localeCompare(formatFilamentLabel(b)))
        .forEach((filament) => {
          const option = document.createElement('option');
          option.value = String(filament.id);
          option.textContent = formatFilamentLabel(filament);
          select.appendChild(option);
        });
    } catch (error) {
      console.error('Error populating remove filament select:', error);
    }
  }

  function updateModelFilamentDisplay(existingElement) {
    if (!existingElement) return;
    existingElement.querySelectorAll('.filaments-info-column, .filaments-item').forEach((el) => el.remove());
  }

  function wireAssignmentControls() {
    const filamentSelect = document.getElementById('filament-select');
    filamentSelect?.addEventListener('change', async () => {
      const id = Number(filamentSelect.value);
      if (id) {
        await addFilamentToModel({ id }, 'model-filaments');
        filamentSelect.value = '';
      }
    });

    const multiSelect = document.getElementById('multi-filament-select');
    multiSelect?.addEventListener('change', async () => {
      const id = Number(multiSelect.value);
      if (id) {
        await addFilamentToModel({ id }, 'multi-filaments');
        multiSelect.value = '';
      }
    });

    const removeSelect = document.getElementById('multi-filament-remove-select');
    removeSelect?.addEventListener('change', async () => {
      const id = Number(removeSelect.value);
      if (!id) return;
      const chip = document.getElementById('multi-filaments')?.querySelector(`.filament-chip[data-filament-id="${id}"]`);
      chip?.remove();
      const remaining = currentFilamentIds('multi-filaments');
      await autoSaveMultipleModels('filaments', remaining, { replaceFilaments: true });
      removeSelect.value = '';
      await populateRemoveFilamentSelect();
      await populateFilamentSelect('multi-filament-select', 'multi-filaments');
    });

    document.getElementById('add-filament-button')?.addEventListener('click', () => {
      window.openFilamentManager?.();
    });
    document.querySelectorAll('.add-filament-button').forEach((button) => {
      button.addEventListener('click', () => window.openFilamentManager?.());
    });
  }

  async function initializeFilaments() {
    wireFilamentManagerEvents();
    wireAssignmentControls();
    await populateFilamentSelect('filament-select', 'model-filaments');
    await populateFilamentSelect('multi-filament-select', 'multi-filaments');
    await populateFilamentFilter();
    if (typeof populateTagFilter === 'function' && !populateTagFilter._filamentWrapped) {
      const origFilter = populateTagFilter;
      const wrappedFilter = async function () {
        await origFilter.apply(this, arguments);
        await populateFilamentFilter();
      };
      wrappedFilter._filamentWrapped = true;
      populateTagFilter = wrappedFilter;
      window.populateTagFilter = wrappedFilter;
    }
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
