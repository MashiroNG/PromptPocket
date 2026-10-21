(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptPocketSidepanelSaveLogic = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function reconcileFolderCommit({ folders, revision, selectedFolderId }) {
    const latestFolders = Array.isArray(folders) ? folders : [];
    const latestRevision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    const selectedExists = latestFolders.some(folder => folder && folder.id === selectedFolderId);

    return {
      folders: latestFolders,
      revision: latestRevision,
      selectedFolderId: selectedExists
        ? selectedFolderId
        : (latestFolders[0] && latestFolders[0].id || null)
    };
  }

  return { reconcileFolderCommit };
});
