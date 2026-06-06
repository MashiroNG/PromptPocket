const assert = require('node:assert/strict');
const { createFolderStore } = require('../folder-store.js');

function createMemoryState(initialState) {
  let state = structuredClone(initialState);
  return {
    readState: async () => structuredClone(state),
    writeState: async (nextState) => {
      state = structuredClone(nextState);
    },
    getState: () => structuredClone(state)
  };
}

async function run() {
  {
    const memory = createMemoryState({ folders: [] });
    const store = createFolderStore(memory);

    const result = await store.commitSnapshot(
      [{ id: 'folder_a', name: 'A', prompts: [] }],
      0
    );

    assert.equal(result.conflict, false);
    assert.equal(result.revision, 1);
  }

  {
    const memory = createMemoryState({
      folders: [{ id: 'folder_a', name: 'A', prompts: [] }],
      revision: 3
    });
    const store = createFolderStore(memory);

    const first = await store.commitSnapshot(
      [{ id: 'folder_a', name: 'First', prompts: [] }],
      3
    );
    const second = await store.commitSnapshot(
      [{ id: 'folder_a', name: 'Second', prompts: [] }],
      3
    );

    assert.equal(first.conflict, false);
    assert.equal(first.revision, 4);
    assert.equal(second.conflict, true);
    assert.equal(second.revision, 4);
    assert.equal(second.folders[0].name, 'First');
    assert.equal(memory.getState().folders[0].name, 'First');
  }

  {
    const memory = createMemoryState({ folders: [], revision: 0 });
    const store = createFolderStore(memory);

    const first = store.mutate(async (folders) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      folders.push({ id: 'folder_a', name: 'A', prompts: [] });
    });
    const second = store.mutate((folders) => {
      folders.push({ id: 'folder_b', name: 'B', prompts: [] });
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.revision, 1);
    assert.equal(secondResult.revision, 2);
    assert.deepEqual(
      memory.getState().folders.map(folder => folder.name),
      ['A', 'B']
    );
  }

  {
    const memory = createMemoryState({ folders: [], revision: 0 });
    const store = createFolderStore(memory);

    await assert.rejects(
      store.mutate(() => {
        throw new Error('mutator failed');
      }),
      /mutator failed/
    );
    const result = await store.mutate((folders) => {
      folders.push({ id: 'folder_a', name: 'A', prompts: [] });
    });

    assert.equal(result.revision, 1);
    assert.equal(memory.getState().folders[0].name, 'A');
  }

  {
    let state = { folders: [], revision: 0 };
    let failNextWrite = true;
    const store = createFolderStore({
      readState: async () => structuredClone(state),
      writeState: async (nextState) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error('write failed');
        }
        state = structuredClone(nextState);
      }
    });

    await assert.rejects(
      store.mutate((folders) => {
        folders.push({ id: 'failed', name: 'Failed', prompts: [] });
      }),
      /write failed/
    );
    const result = await store.mutate((folders) => {
      folders.push({ id: 'folder_b', name: 'B', prompts: [] });
    });

    assert.equal(result.revision, 1);
    assert.deepEqual(state.folders.map(folder => folder.name), ['B']);
  }

  console.log('folder store tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
