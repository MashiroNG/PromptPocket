const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('../sidepanel-logic.js');
const {
  CURRENT_STORAGE_SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION_KEY,
  createStorageMigrator,
  normalizeImportedData
} = require('../storage-migrations.js');

function createMemoryStorage(initialState, options = {}) {
  let state = structuredClone(initialState);
  let reads = 0;
  let writes = 0;
  let lastChanges;

  return {
    getAll: async () => {
      reads += 1;
      if (options.readDelay) await options.readDelay();
      return structuredClone(state);
    },
    set: async (changes) => {
      writes += 1;
      lastChanges = structuredClone(changes);
      state = { ...state, ...structuredClone(changes) };
    },
    getState: () => structuredClone(state),
    getLastChanges: () => structuredClone(lastChanges),
    getReads: () => reads,
    getWrites: () => writes
  };
}

function idFactory() {
  let index = 0;
  return () => `generated_${++index}`;
}

function createMigrator(storage, sanitizeFolders = logic.sanitizeFolders) {
  return createStorageMigrator({
    storage,
    sanitizeFolders,
    isSafeId: logic.isSafeId
  });
}

async function run() {
  assert.equal(CURRENT_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(STORAGE_SCHEMA_VERSION_KEY, 'storageSchemaVersion');

  {
    const imported = normalizeImportedData({
      data: [{
        id: 'unsafe folder',
        name: 'Legacy',
        prompts: [{
          id: 'duplicate',
          title: 'Keep',
          text: 'one'
        }, {
          id: 'duplicate',
          legacyOnly: true
        }]
      }],
      sanitizeFolders: folders => logic.sanitizeFolders(folders, idFactory()),
      isSafeId: logic.isSafeId
    });

    assert.equal(imported.storageSchemaVersion, CURRENT_STORAGE_SCHEMA_VERSION);
    assert.equal(imported.migrated, true);
    assert.equal(imported.folders[0].id, 'generated_1');
    assert.equal(imported.folders[0].prompts[0].id, 'duplicate');
    assert.equal(imported.folders[0].prompts[1].id, 'generated_2');
    assert.equal(imported.folders[0].prompts[1].text, '');
    assert.equal(imported.folders[0].prompts[1].legacyOnly, true);
  }

  {
    const imported = normalizeImportedData({
      data: {
        storageSchemaVersion: 0,
        foldersRevision: 'bad',
        folders: [{ id: 'bad id', name: 'Backup', prompts: [] }],
        unrelatedSetting: true
      },
      sanitizeFolders: folders => logic.sanitizeFolders(folders, idFactory()),
      isSafeId: logic.isSafeId
    });

    assert.equal(imported.storageSchemaVersion, CURRENT_STORAGE_SCHEMA_VERSION);
    assert.equal(imported.migrated, true);
    assert.equal(imported.snapshot.unrelatedSetting, true);
    assert.equal(imported.snapshot.foldersRevision, 1);
    assert.equal(imported.folders[0].id, 'generated_1');
  }

  {
    assert.throws(
      () => normalizeImportedData({
        data: { storageSchemaVersion: 2, folders: [] },
        sanitizeFolders: logic.sanitizeFolders,
        isSafeId: logic.isSafeId
      }),
      /newer than supported version 1/
    );
  }

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
      folders: [{
        id: 'unsafe folder id',
        name: 'Legacy',
        prompts: [{ id: 'unsafe prompt id', title: 'Prompt' }]
      }],
      foldersRevision: 4
    });
    const migrator = createMigrator(storage, () => ({
      changed: false,
      folders: [{
        id: 'safe_folder',
        name: 'Legacy',
        prompts: [{ id: 'safe_prompt', title: 'Prompt' }]
      }]
    }));

    await migrator.ensureMigrated();

    assert.deepEqual(storage.getState().folders, [{
      id: 'safe_folder',
      name: 'Legacy',
      prompts: [{ id: 'safe_prompt', title: 'Prompt' }]
    }]);
    assert.equal(storage.getState().foldersRevision, 5);
    assert.equal(storage.getState().storageSchemaVersion, 1);
  }

  {
    const storage = createMemoryStorage({
      folders: 'not-an-array',
      foldersRevision: 6
    });

    await createMigrator(storage).ensureMigrated();

    assert.deepEqual(storage.getState().folders, []);
    assert.equal(storage.getState().foldersRevision, 7);
    assert.equal(storage.getState().storageSchemaVersion, 1);
  }

  {
    const originalFolder = {
      id: 'folder_a',
      name: '',
      prompts: [
        { id: 'prompt_a', title: '', pinned: 'legacy' },
        null,
        'invalid prompt'
      ]
    };
    const storage = createMemoryStorage({
      folders: [originalFolder, null, 'invalid folder'],
      foldersRevision: 2
    });

    await createMigrator(
      storage,
      folders => logic.sanitizeFolders(folders, idFactory())
    ).ensureMigrated();

    const migratedFolders = storage.getState().folders;
    assert.deepEqual(migratedFolders[0], {
      ...originalFolder,
      prompts: [
        originalFolder.prompts[0],
        {
          id: 'generated_1',
          title: '未命名提示词',
          text: '',
          sourceUrl: '',
          sourceTitle: '',
          pinned: false,
          pinnedAt: '',
          quickAt: '',
          timestamp: migratedFolders[0].prompts[1].timestamp
        },
        {
          id: 'generated_2',
          title: '未命名提示词',
          text: '',
          sourceUrl: '',
          sourceTitle: '',
          pinned: false,
          pinnedAt: '',
          quickAt: '',
          timestamp: migratedFolders[0].prompts[2].timestamp
        }
      ]
    });
    assert.deepEqual(migratedFolders[1], {
      id: 'generated_3',
      name: '导入的文件夹',
      prompts: []
    });
    assert.deepEqual(migratedFolders[2], {
      id: 'generated_4',
      name: '导入的文件夹',
      prompts: []
    });
    assert.equal(migratedFolders.length, 3);
    assert.equal(storage.getState().foldersRevision, 3);
  }

  {
    const initialState = {
      folders: [{ id: 'folder_a', name: 'Existing', prompts: [] }],
      foldersRevision: 2
    };
    const storage = createMemoryStorage(initialState);
    const migrator = createMigrator(storage, () => ({
      changed: true,
      folders: []
    }));

    await assert.rejects(
      migrator.ensureMigrated(),
      /Sanitized folders length does not match source folders length/
    );
    assert.equal(storage.getWrites(), 0);
    assert.deepEqual(storage.getState(), initialState);
  }

  {
    const invalidSanitizedFolders = [
      {
        label: 'folder string',
        folders: ['invalid folder'],
        error: /Sanitized folder at index 0 must be an object/
      },
      {
        label: 'folder missing id',
        folders: [{ name: 'Missing ID', prompts: [] }],
        error: /Sanitized folder at index 0 has an invalid ID/
      },
      {
        label: 'prompt missing id',
        folders: [{
          id: 'folder_a',
          name: 'Folder',
          prompts: [{ title: 'Missing ID' }]
        }],
        error: /Sanitized prompt at folder 0 index 0 has an invalid ID/
      },
      {
        label: 'duplicate prompt id',
        folders: [{
          id: 'folder_a',
          name: 'Folder',
          prompts: [
            { id: 'prompt_a', title: 'First' },
            { id: 'prompt_a', title: 'Second' }
          ]
        }],
        error: /Sanitized prompt at folder 0 index 1 has a duplicate ID/
      },
      {
        label: 'unsafe prompt id',
        folders: [{
          id: 'folder_a',
          name: 'Folder',
          prompts: [{ id: 'unsafe prompt id', title: 'Unsafe' }]
        }],
        error: /Sanitized prompt at folder 0 index 0 has an invalid ID/
      }
    ];

    for (const testCase of invalidSanitizedFolders) {
      const sourcePrompts = testCase.label === 'duplicate prompt id'
        ? [{ id: 'old_a' }, { id: 'old_b' }]
        : (testCase.label.includes('prompt') ? [{ id: 'old_a' }] : []);
      const initialState = {
        folders: [{ id: 'folder_a', name: 'Existing', prompts: sourcePrompts }],
        foldersRevision: 2
      };
      const storage = createMemoryStorage(initialState);
      const migrator = createMigrator(storage, () => ({
        changed: true,
        folders: testCase.folders
      }));

      await assert.rejects(migrator.ensureMigrated(), testCase.error);
      assert.equal(storage.getWrites(), 0, testCase.label);
      assert.deepEqual(storage.getState(), initialState, testCase.label);
      assert.equal(
        storage.getState().storageSchemaVersion,
        undefined,
        testCase.label
      );
    }
  }

  {
    const initialState = {
      folders: [{
        id: 'folder_a',
        name: 'Existing',
        prompts: [{ id: 'prompt_a', title: 'Prompt', text: 'Text' }]
      }],
      foldersRevision: 2
    };
    const storage = createMemoryStorage(initialState);
    const migrator = createMigrator(storage, folders => ({
      changed: true,
      folders: [{
        ...folders[0],
        prompts: []
      }]
    }));

    await assert.rejects(
      migrator.ensureMigrated(),
      /Sanitized prompts length does not match source prompts length/
    );
    assert.equal(storage.getWrites(), 0);
    assert.deepEqual(storage.getState(), initialState);
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
    const storage = createMemoryStorage({
      storageSchemaVersion: 1,
      aiTargets: [{ id: 'target_a', name: 'Old' }],
      unknownFutureKey: { keep: true }
    });
    const migrator = createStorageMigrator({
      storage,
      currentVersion: 2,
      migrations: {
        1: (snapshot) => {
          assert.deepEqual(snapshot.aiTargets, [{ id: 'target_a', name: 'Old' }]);
          assert.deepEqual(snapshot.unknownFutureKey, { keep: true });
          return {
            aiTargets: snapshot.aiTargets.map(target => ({
              ...target,
              name: 'Migrated'
            }))
          };
        }
      }
    });

    await migrator.ensureMigrated();

    assert.equal(storage.getWrites(), 1);
    assert.deepEqual(storage.getLastChanges(), {
      aiTargets: [{ id: 'target_a', name: 'Migrated' }],
      storageSchemaVersion: 2
    });
    assert.deepEqual(storage.getState().unknownFutureKey, { keep: true });
  }

  {
    const storage = createMemoryStorage({
      folders: [],
      foldersRevision: 0
    });
    const migrator = createStorageMigrator({
      storage,
      currentVersion: 1,
      migrations: {
        0: async () => ({ asyncStep: true })
      }
    });

    await migrator.ensureMigrated();

    assert.equal(storage.getState().asyncStep, true);
    assert.deepEqual(storage.getLastChanges(), {
      asyncStep: true,
      storageSchemaVersion: 1
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
    const folders = [{
      id: 'folder_a',
      name: 'Existing',
      prompts: [{ id: 'prompt_a', title: 'Prompt', text: 'Text' }]
    }];
    const storage = createMemoryStorage({
      folders,
      foldersRevision: 'invalid'
    });

    await createMigrator(storage).ensureMigrated();

    assert.deepEqual(storage.getState().folders, folders);
    assert.equal(storage.getState().foldersRevision, 0);
    assert.equal(storage.getState().storageSchemaVersion, 1);
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
    for (const invalidVersion of ['2', null, -1, 1.5]) {
      const initialState = {
        storageSchemaVersion: invalidVersion,
        folders: [],
        foldersRevision: 0
      };
      const storage = createMemoryStorage(initialState);

      await assert.rejects(
        createMigrator(storage).ensureMigrated(),
        /Invalid storage schema version/
      );
      assert.equal(storage.getWrites(), 0);
      assert.deepEqual(storage.getState(), initialState);
    }
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
    const storage = createMemoryStorage({
      folders: [{ id: 'bad id', name: 'Legacy', prompts: [] }],
      foldersRevision: 0
    });
    let attempts = 0;
    const migrator = createMigrator(storage, (folders) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary sanitize failure');
      return logic.sanitizeFolders(folders, idFactory());
    });

    await assert.rejects(
      migrator.ensureMigrated(),
      /temporary sanitize failure/
    );
    await migrator.ensureMigrated();

    assert.equal(attempts, 2);
    assert.equal(storage.getReads(), 2);
    assert.equal(storage.getWrites(), 1);
    assert.equal(storage.getState().storageSchemaVersion, 1);
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
      /getAll:\s*\(\)\s*=>\s*chrome\.storage\.local\.get\(null\)/
    );
    assert.match(
      background,
      /const migratedStorage = \{[\s\S]*get:\s*async[\s\S]*await ensureStorageMigrated\(\);[\s\S]*rawStorage\.get/
    );
    assert.match(
      background,
      /const migratedStorage = \{[\s\S]*set:\s*async[\s\S]*await ensureStorageMigrated\(\);[\s\S]*rawStorage\.set/
    );
    assert.match(
      background,
      /const migratedStorage = \{[\s\S]*remove:\s*async[\s\S]*await ensureStorageMigrated\(\);[\s\S]*rawStorage\.remove/
    );

    const rawChromeStorageCalls = background.match(
      /chrome\.storage\.local\.(?:get|set|remove)/g
    ) || [];
    assert.equal(rawChromeStorageCalls.length, 4);
    const rawStorageStart = background.indexOf('const rawStorage = {');
    const rawStorageEnd = background.indexOf('\n};', rawStorageStart);
    const rawStorageBlock = background.slice(rawStorageStart, rawStorageEnd);
    assert.equal(
      (rawStorageBlock.match(/chrome\.storage\.local\.(?:get|set|remove)/g) || []).length,
      4
    );
    assert.doesNotMatch(
      background.slice(rawStorageEnd + 3),
      /chrome\.storage\.local\.(?:get|set|remove)/
    );

    const sidepanelHtml = fs.readFileSync(
      path.join(__dirname, '..', 'sidepanel.html'),
      'utf8'
    );
    const sidepanelLogicScript = sidepanelHtml.indexOf('sidepanel-logic.js');
    const sidepanelMigrationScript = sidepanelHtml.indexOf('storage-migrations.js');
    const sidepanelScript = sidepanelHtml.indexOf('sidepanel.js');
    assert.ok(sidepanelMigrationScript > sidepanelLogicScript);
    assert.ok(sidepanelScript > sidepanelMigrationScript);

    const sidepanel = fs.readFileSync(
      path.join(__dirname, '..', 'sidepanel.js'),
      'utf8'
    );
    assert.match(sidepanel, /PromptPocketStorageMigrations\.normalizeImportedData/);
  }

  console.log('storage migration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
