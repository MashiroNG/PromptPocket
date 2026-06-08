(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptPocketStorageMigrations = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const CURRENT_STORAGE_SCHEMA_VERSION = 1;
  const STORAGE_SCHEMA_VERSION_KEY = 'storageSchemaVersion';

  function normalizeRevision(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function normalizeSchemaVersion(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  function applySanitizedIds(folders, sanitizedFolders) {
    return folders.map((folder, folderIndex) => {
      const sanitizedFolder = sanitizedFolders[folderIndex];
      const nextFolder = { ...folder, id: sanitizedFolder.id };
      if (Array.isArray(folder && folder.prompts)) {
        nextFolder.prompts = folder.prompts.map((prompt, promptIndex) => ({
          ...prompt,
          id: sanitizedFolder.prompts[promptIndex].id
        }));
      }
      return nextFolder;
    });
  }

  function createVersionZeroMigration(sanitizeFolders) {
    return function migrateVersionZero(snapshot) {
      const normalized = sanitizeFolders(snapshot.folders);
      if (!normalized.changed) return {};
      return {
        folders: applySanitizedIds(snapshot.folders, normalized.folders),
        foldersRevision: normalizeRevision(snapshot.foldersRevision) + 1
      };
    };
  }

  function createStorageMigrator({
    storage,
    sanitizeFolders,
    currentVersion = CURRENT_STORAGE_SCHEMA_VERSION,
    migrations
  }) {
    let inFlight = null;
    let migrated = false;
    const migrationSteps = migrations === undefined
      ? { 0: createVersionZeroMigration(sanitizeFolders) }
      : migrations;

    async function migrate() {
      const saved = await storage.get({
        folders: [],
        foldersRevision: 0,
        [STORAGE_SCHEMA_VERSION_KEY]: 0
      });
      const storedVersion = normalizeSchemaVersion(saved[STORAGE_SCHEMA_VERSION_KEY]);

      if (storedVersion > currentVersion) {
        throw new Error(
          `Storage schema version ${storedVersion} is newer than supported version ${currentVersion}`
        );
      }
      if (storedVersion === currentVersion) return;

      let snapshot = saved;
      let changes = {};
      for (let version = storedVersion; version < currentVersion; version += 1) {
        const migration = migrationSteps[version];
        if (typeof migration !== 'function') {
          throw new Error(`Missing storage migration from version ${version} to ${version + 1}`);
        }
        const stepChanges = await migration(snapshot);
        changes = {
          ...changes,
          ...(stepChanges || {}),
          [STORAGE_SCHEMA_VERSION_KEY]: version + 1
        };
        snapshot = { ...snapshot, ...changes };
      }
      await storage.set(changes);
    }

    function ensureMigrated() {
      if (migrated) return Promise.resolve();
      if (inFlight) return inFlight;

      inFlight = migrate().then(
        () => {
          migrated = true;
          inFlight = null;
        },
        (error) => {
          inFlight = null;
          throw error;
        }
      );
      return inFlight;
    }

    return { ensureMigrated };
  }

  return {
    CURRENT_STORAGE_SCHEMA_VERSION,
    STORAGE_SCHEMA_VERSION_KEY,
    createStorageMigrator
  };
});
