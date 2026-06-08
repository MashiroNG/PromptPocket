const assert = require('node:assert/strict');
const { createFolderStore } = require('../folder-store.js');
const {
  sendRuntimeMessage,
  createFolderMessageHandler
} = require('../folder-message-contract.js');

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

function createRuntimeChannel(handler) {
  const runtime = {
    lastError: null,
    sendMessage(message, callback) {
      const handled = handler(message, {}, callback);
      if (handled === false) callback(undefined);
    }
  };
  return runtime;
}

function createFixture(initialState) {
  const memory = createMemoryState(initialState);
  const folderStore = createFolderStore(memory);
  let nextId = 1;
  const savedDrafts = [];
  let foldersChanged = 0;

  const handler = createFolderMessageHandler({
    folderStore,
    addFolder: async (name) => {
      const result = await folderStore.mutate((folders) => {
        const folder = { id: `folder_${nextId++}`, name, prompts: [] };
        folders.push(folder);
        return folder;
      });
      return {
        folder: result.result,
        folders: result.folders,
        revision: result.revision
      };
    },
    savePromptDraft: async (draft) => {
      savedDrafts.push(structuredClone(draft));
      await folderStore.mutate((folders) => {
        folders[0].prompts.unshift({
          id: `prompt_${nextId++}`,
          title: draft.title,
          text: draft.text
        });
      });
    },
    onFoldersChanged: () => {
      foldersChanged += 1;
    }
  });

  return {
    memory,
    runtime: createRuntimeChannel(handler),
    handler,
    savedDrafts,
    getFoldersChanged: () => foldersChanged
  };
}

async function run() {
  {
    const fixture = createFixture({
      folders: [{ id: 'folder_a', name: 'A', prompts: [] }],
      revision: 4
    });
    const response = await sendRuntimeMessage(fixture.runtime, {
      action: 'getFolders'
    });

    assert.deepEqual(response, {
      success: true,
      folders: [{ id: 'folder_a', name: 'A', prompts: [] }],
      revision: 4
    });
  }

  {
    const fixture = createFixture({ folders: [], revision: 2 });
    const response = await sendRuntimeMessage(fixture.runtime, {
      action: 'commitFolders',
      folders: [{ id: 'folder_a', name: 'Committed', prompts: [] }],
      expectedRevision: 2
    });

    assert.equal(response.success, true);
    assert.equal(response.conflict, false);
    assert.equal(response.revision, 3);
    assert.equal(fixture.memory.getState().folders[0].name, 'Committed');
    assert.equal(fixture.getFoldersChanged(), 1);
  }

  {
    const fixture = createFixture({
      folders: [{ id: 'folder_a', name: 'Latest', prompts: [] }],
      revision: 3
    });
    const response = await sendRuntimeMessage(fixture.runtime, {
      action: 'saveFolders',
      folders: [{ id: 'folder_a', name: 'Stale', prompts: [] }],
      expectedRevision: 2
    });

    assert.equal(response.success, true);
    assert.equal(response.conflict, true);
    assert.equal(response.revision, 3);
    assert.equal(response.folders[0].name, 'Latest');
    assert.equal(fixture.memory.getState().folders[0].name, 'Latest');
    assert.equal(fixture.getFoldersChanged(), 0);
  }

  {
    const fixture = createFixture({ folders: [], revision: 0 });
    const response = await sendRuntimeMessage(fixture.runtime, {
      action: 'addFolder',
      name: 'New folder'
    });

    assert.equal(response.success, true);
    assert.equal(response.folder.name, 'New folder');
    assert.equal(response.folders[0].name, 'New folder');
    assert.equal(response.revision, 1);
    assert.equal(fixture.getFoldersChanged(), 1);
  }

  {
    const fixture = createFixture({
      folders: [{ id: 'folder_a', name: 'A', prompts: [] }],
      revision: 0
    });
    const draft = {
      folderId: 'folder_a',
      title: 'Draft title',
      text: 'Draft body'
    };
    const response = await sendRuntimeMessage(fixture.runtime, {
      action: 'savePromptDraft',
      draft
    });

    assert.deepEqual(response, { success: true });
    assert.deepEqual(fixture.savedDrafts, [draft]);
    assert.equal(fixture.memory.getState().folders[0].prompts[0].text, 'Draft body');
  }

  {
    const fixture = createFixture({ folders: [], revision: 0 });
    let responded = false;
    const handled = fixture.handler(
      { action: 'anotherBackgroundAction' },
      {},
      () => {
        responded = true;
      }
    );

    assert.equal(handled, false);
    assert.equal(responded, false);
  }

  {
    const runtime = {
      lastError: null,
      sendMessage(message, callback) {
        this.lastError = { message: 'Channel closed' };
        callback(undefined);
        this.lastError = null;
      }
    };
    await assert.rejects(
      sendRuntimeMessage(runtime, { action: 'getFolders' }),
      /Channel closed/
    );
  }

  {
    const runtime = {
      lastError: null,
      sendMessage(message, callback) {
        callback({ success: false, error: 'Storage failed' });
      }
    };
    await assert.rejects(
      sendRuntimeMessage(runtime, { action: 'getFolders' }),
      /Storage failed/
    );
  }

  {
    const runtime = {
      lastError: null,
      sendMessage(message, callback) {
        callback(undefined);
      }
    };
    await assert.rejects(
      sendRuntimeMessage(
        runtime,
        { action: 'savePromptDraft' },
        { defaultError: '保存失败。' }
      ),
      /保存失败。/
    );
  }

  {
    const runtime = {
      lastError: null,
      sendMessage(message, callback) {
        this.lastError = { message: '' };
        callback(undefined);
        this.lastError = null;
      }
    };
    await assert.rejects(
      sendRuntimeMessage(
        runtime,
        { action: 'savePromptDraft' },
        { defaultError: '保存失败。' }
      ),
      /保存失败。/
    );
  }

  console.log('folder message contract tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
