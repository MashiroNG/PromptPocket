(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.promptPocketFolderStore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  function normalizeState(state) {
    return {
      folders: Array.isArray(state && state.folders) ? state.folders : [],
      revision: Number.isSafeInteger(state && state.revision) && state.revision >= 0
        ? state.revision
        : 0
    };
  }

  function cloneFolders(folders) {
    return folders.map(folder => ({
      ...folder,
      prompts: Array.isArray(folder && folder.prompts)
        ? folder.prompts.map(prompt => ({ ...prompt }))
        : []
    }));
  }

  function createFolderStore({ readState, writeState }) {
    let queue = Promise.resolve();

    function enqueue(operation) {
      const result = queue.then(operation, operation);
      queue = result.then(() => undefined, () => undefined);
      return result;
    }

    function read() {
      return enqueue(async () => {
        const state = normalizeState(await readState());
        return { folders: cloneFolders(state.folders), revision: state.revision };
      });
    }

    function mutate(mutator) {
      return enqueue(async () => {
        const current = normalizeState(await readState());
        const folders = cloneFolders(current.folders);
        const result = await mutator(folders, current.revision);
        const nextState = { folders, revision: current.revision + 1 };
        await writeState(nextState);
        return { ...nextState, result };
      });
    }

    function commitSnapshot(nextFolders, expectedRevision) {
      return enqueue(async () => {
        const current = normalizeState(await readState());
        if (current.revision !== expectedRevision) {
          return {
            conflict: true,
            folders: cloneFolders(current.folders),
            revision: current.revision
          };
        }

        const nextState = {
          folders: cloneFolders(Array.isArray(nextFolders) ? nextFolders : []),
          revision: current.revision + 1
        };
        await writeState(nextState);
        return { conflict: false, ...nextState };
      });
    }

    return { read, mutate, commitSnapshot };
  }

  return { createFolderStore };
});
