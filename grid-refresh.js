// Grid updates while thumbnails arrive in the background.
// Loaded before search.js and renderer.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.gridRefresh = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const THUMBNAIL_REFRESH_COALESCE_MS = 3000;

  // The first progressive page is shorter than a scrolled library. Rendering it
  // collapses the grid and resets scroll, so hold until the reload catches up.
  function shouldHoldProgressiveRender(preserveScroll, modelsLength, shownCount, pageComplete) {
    return !!(preserveScroll && !pageComplete && modelsLength < shownCount);
  }

  // Off-screen virtual-grid rows share this object with the layout cache.
  function patchLoadedModel(currentModels, normalizedPath, updatedModel, normalizePath) {
    if (!Array.isArray(currentModels) || typeof normalizePath !== 'function') return false;
    const loadedModel = currentModels.find(function (model) {
      return model && normalizePath(model.filePath) === normalizedPath;
    });
    if (!loadedModel) return false;
    Object.assign(loadedModel, updatedModel);
    return true;
  }

  function shouldFocusSelectionOnViewSwitch(previousView, nextView, hasSelection) {
    if (!hasSelection) return false;
    return (
      (previousView === 'detailed' && nextView === 'preview') ||
      (previousView === 'preview' && nextView === 'detailed')
    );
  }

  // One trailing refresh per delay window. Extra calls while a timer is pending are ignored.
  function createCoalescedRefresh(delayMs, refreshFn) {
    let timer = null;
    return function scheduleCoalescedRefresh() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        Promise.resolve()
          .then(refreshFn)
          .catch(function (err) {
            console.error('Error refreshing grid after thumbnails were added:', err);
          });
      }, delayMs);
    };
  }

  return {
    THUMBNAIL_REFRESH_COALESCE_MS: THUMBNAIL_REFRESH_COALESCE_MS,
    shouldHoldProgressiveRender: shouldHoldProgressiveRender,
    shouldFocusSelectionOnViewSwitch: shouldFocusSelectionOnViewSwitch,
    patchLoadedModel: patchLoadedModel,
    createCoalescedRefresh: createCoalescedRefresh
  };
});
