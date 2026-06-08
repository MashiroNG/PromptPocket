const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('../sidepanel-logic.js');
const {
  CURRENT_STORAGE_SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION_KEY,
  createStorageMigrator
} = require('../storage-migrations.js');

function createMemoryStorage(initialState, options = {}) {
  let state = structuredClone(initialState);
  let reads = 0;
  let writes = 0;

  return {
    get: async (defaults) => {
      reads += 1;
      if (options.readDelay) await options.readDelay();
      return { ...structuredClone(defaults), ...structuredClone(state) };
    },
    set: async (changes) => {
      writes += 1;
      state = { ...state, ...structuredClone(changes) };
    },
    getState: () => structuredClone(state),
    getReads: () => reads,
    getWrites: () => writes
  };
}

function idFactory() {
  let index = 0;
  return () => `generated_${++index}`;
}

function createMigrator(storage, sanitizeFolders = logic.sanitizeFolders) {
  return createStorageMigrator({ storage, sanitizeFolders });
}

async function run() {
  assert.equal(CURRENT_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(STORAGE_SCHEMA_VERSION_KEY, 'storageSchemaVersion');

  {
    const originalFolders = [{
      id: 'unsafe folder id',
      name: 'Legacy',
      customFolderField: 'keep',
      prompts: [{
        id: 'duplicate',
        title: '',
        pinned: 'legacy-truthy',
        timestamp: '2019-03-04T05:06:07.000Z',
        customPromptField: 'keep'
      }, {
        id: 'duplicate',
        text: '',
        pinned: 0
      }, {
        id: 'unsafe prompt id',
        legacyOnly: true
      }]
    }, {
      id: 'folder_without_prompts',
      name: '',
      customFolderField: null
    }];
    const storage = createMemoryStorage({
      folders: originalFolders,
      foldersRevision: 4,
      unrelatedSetting: true
    });
    const migrator = createMigrator(
      storage,
      folders => logic.sanitizeFolders(folders, idFactory())
    );

    await migrator.ensureMigrated();

    const state = storage.getState();
    const expectedFolders = structuredClone(originalFolders);
    expectedFolders[0].id = 'generated_1';
    expectedFolders[0].prompts[1].id = 'generated_2';
    expectedFolders[0].prompts[2].id = 'generated_3';

    assert.equal(state.storageSchemaVersion, 1);
    assert.equal(state.foldersRevision, 5);
    assert.deepEqual(state.folders, expectedFolders);
    assert.equal(state.unrelatedSetting, true);
  }

  {
    const storage = createMemoryStorage({
      folders: [],
      foldersRevision: 0,
      original: true
    });
    const calls = [];
    const migrator = createStorageMigrator({
      storage,
      currentVersion: 2,
      migrations: {
        0: (snapshot) => {
          calls.push(`0->1@${snapshot.storageSchemaVersion}`);
          return { firstStep: true };
        },
        1: (snapshot) => {
          calls.push(`1->2@${snapshot.storageSchemaVersion}`);
          assert.equal(snapshot.firstStep, true);
          return { secondStep: true };
        }
      }
    });

    await migrator.ensureMigrated();

    assert.deepEqual(calls, ['0->1@0', '1->2@1']);
    assert.equal(storage.getWrites(), 1);
    assert.deepEqual(storage.getState(), {
      folders: [],
      foldersRevision: 0,
      original: true,
      firstStep: true,
      secondStep: true,
      storageSchemaVersion: 2
    });
  }

  {
    const initialState = {
      folders: [],
      foldersRevision: 0,
      original: true
    };
    const storage = createMemoryStorage(initialState);
    const migrator = createStorageMigrator({
      storage,
      currentVersion: 2,
      migrations: {
        0: () => ({ firstStep: true })
      }
    });

    await assert.rejects(
      migrator.ensureMigrated(),
      /Missing storage migration from version 1 to 2/
    );
    assert.equal(storage.getWrites(), 0);
    assert.deepEqual(storage.getState(), initialState);
  }

  {
    const folders = [{
      id: 'folder_a',
      name: 'Existing',
      prompts: [{ id: 'prompt_a', title: 'Prompt', text: 'Text' }]
    }];
    const storage = createMemoryStorage({ folders, foldersRevision: 7 });

    await createMigrator(storage).ensureMigrated();

    assert.equal(storage.getState().storageSchemaVersion, 1);
    assert.equal(storage.getState().foldersRevision, 7);
    assert.deepEqual(storage.getState().folders, folders);
  }

  {
    const storage = createMemoryStorage({
      folders: [{ id: 'bad id', name: 'Legacy', prompts: [] }],
      foldersRevision: 'invalid'
    });

    await createMigrator(
      storage,
      folders => logic.sanitizeFolders(folders, idFactory())
    ).ensureMigrated();

    assert.equal(storage.getState().foldersRevision, 1);
  }

  {
    let releaseRead;
    const readGate = new Promise(resolve => {
      releaseRead = resolve;
    });
    const storage = createMemoryStorage(
      { folders: [], foldersRevision: 0 },
      { readDelay: () => readGate }
    );
    const migrator = createMigrator(storage);

    const first = migrator.ensureMigrated();
    const second = migrator.ensureMigrated();

    assert.strictEqual(second, first);
    assert.equal(storage.getReads(), 1);
    releaseRead();
    await Promise.all([first, second]);
    assert.equal(storage.getReads(), 1);
    assert.equal(storage.getWrites(), 1);
  }

  {
    const storage = createMemoryStorage({ folders: [], foldersRevision: 0 });
    const migrator = createMigrator(storage);

    await migrator.ensureMigrated();
    await migrator.ensureMigrated();

    assert.equal(storage.getReads(), 1);
    assert.equal(storage.getWrites(), 1);
  }

  {
    const storage = createMemoryStorage({
      storageSchemaVersion: 2,
      folders: [],
      foldersRevision: 0
    });

    await assert.rejects(
      createMigrator(storage).ensureMigrated(),
      /newer than supported version 1/
    );
    assert.equal(storage.getWrites(), 0);
    assert.equal(storage.getState().storageSchemaVersion, 2);
  }

  {
    const storage = createMemoryStorage({
      storageSchemaVersion: 1,
      folders: [],
      foldersRevision: 3
    });

    await createMigrator(storage).ensureMigrated();

    assert.equal(storage.getReads(), 1);
    assert.equal(storage.getWrites(), 0);
  }

  {
    const storage = createMemoryStorage({
      folders: [{ id: 'bad id', name: 'Legacy', prompts: [] }],
      foldersRevision: 0
    });
    const migrator = createMigrator(storage, () => {
      throw new Error('sanitize failed');
    });

    await assert.rejects(migrator.ensureMigrated(), /sanitize failed/);
    assert.equal(storage.getWrites(), 0);
    assert.equal(storage.getState().storageSchemaVersion, undefined);
  }

  {
    const background = fs.readFileSync(
      path.join(__dirname, '..', 'background.js'),
      'utf8'
    );
    const logicImport = background.indexOf("'sidepanel-logic.js'");
    const migrationImport = background.indexOf("'storage-migrations.js'");
    const folderStoreImport = background.indexOf("'folder-store.js'");

    assert.ok(logicImport >= 0);
    assert.ok(migrationImport > logicImport);
    assert.ok(folderStoreImport > migrationImport);
    assert.match(
      background,
      /readState:\s*async\s*\(\)\s*=>\s*\{\s*await ensureStorageMigrated\(\);/
    );
    assert.match(
      background,
      /writeState:\s*async\s*\(\{ folders, revision \}\)\s*=>\s*\{\s*await ensureStorageMigrated\(\);/
    );
  }

  console.log('storage migration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
