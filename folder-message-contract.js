(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptPocketFolderMessageContract = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const FOLDER_ACTIONS = new Set([
    'getFolders',
    'commitFolders',
    'saveFolders',
    'addFolder',
    'savePromptDraft'
  ]);

  function sendRuntimeMessage(runtime, message, options) {
    const defaultError = options && options.defaultError || '请求失败';
    return new Promise((resolve, reject) => {
      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          reject(new Error(runtime.lastError.message || defaultError));
          return;
        }
        if (!response || !response.success) {
          reject(new Error(response && response.error || defaultError));
          return;
        }
        resolve(response);
      });
    });
  }

  function createFolderMessageHandler({
    folderStore,
    addFolder,
    savePromptDraft,
    onFoldersChanged
  }) {
    const notifyFoldersChanged = typeof onFoldersChanged === 'function'
      ? onFoldersChanged
      : () => {};

    return function handleFolderMessage(message, sender, sendResponse) {
      if (!message || !FOLDER_ACTIONS.has(message.action)) return false;

      Promise.resolve().then(async () => {
        if (message.action === 'getFolders') {
          const state = await folderStore.read();
          return {
            success: true,
            folders: state.folders,
            revision: state.revision
          };
        }

        if (message.action === 'commitFolders' || message.action === 'saveFolders') {
          const result = await folderStore.commitSnapshot(
            message.folders,
            message.expectedRevision
          );
          if (!result.conflict) notifyFoldersChanged();
          return { success: true, ...result };
        }

        if (message.action === 'addFolder') {
          const result = await addFolder(message.name);
          notifyFoldersChanged();
          return { success: true, ...result };
        }

        await savePromptDraft(message.draft);
        return { success: true };
      }).then(
        sendResponse,
        (error) => sendResponse({
          success: false,
          error: error && error.message || String(error)
        })
      );

      return true;
    };
  }

  return {
    sendRuntimeMessage,
    createFolderMessageHandler
  };
});
