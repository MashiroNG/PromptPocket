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

  function isObjectRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function validateSanitizedFolders(folders, sanitizedFolders, isSafeId) {
    if (!Array.isArray(sanitizedFolders) || sanitizedFolders.length !== folders.length) {
      throw new Error('Sanitized folders length does not match source folders length');
    }

    const folderIds = new Set();
    const promptIds = new Set();
    sanitizedFolders.forEach((folder, folderIndex) => {
      if (!isObjectRecord(folder)) {
        throw new Error(`Sanitized folder at index ${folderIndex} must be an object`);
      }
      if (!isSafeId(folder.id)) {
        throw new Error(`Sanitized folder at index ${folderIndex} has an invalid ID`);
      }
      if (folderIds.has(folder.id)) {
        throw new Error(`Sanitized folder at index ${folderIndex} has a duplicate ID`);
      }
      folderIds.add(folder.id);

      if (!Array.isArray(folder.prompts)) {
        throw new Error(`Sanitized folder at index ${folderIndex} must have a prompts array`);
      }
      const sourceFolder = folders[folderIndex];
      const sourcePromptCount = isObjectRecord(sourceFolder) && Array.isArray(sourceFolder.prompts)
        ? sourceFolder.prompts.length
        : 0;
      if (folder.prompts.length !== sourcePromptCount) {
        throw new Error('Sanitized prompts length does not match source prompts length');
      }

      folder.prompts.forEach((prompt, promptIndex) => {
        if (!isObjectRecord(prompt)) {
          throw new Error(
            `Sanitized prompt at folder ${folderIndex} index ${promptIndex} must be an object`
          );
        }
        if (!isSafeId(prompt.id)) {
          throw new Error(
            `Sanitized prompt at folder ${folderIndex} index ${promptIndex} has an invalid ID`
          );
        }
        if (promptIds.has(prompt.id)) {
          throw new Error(
            `Sanitized prompt at folder ${folderIndex} index ${promptIndex} has a duplicate ID`
          );
        }
        promptIds.add(prompt.id);
      });
    });
  }

  function applySanitizedIds(folders, sanitizedFolders) {
    return folders.map((folder, folderIndex) => {
      const sanitizedFolder = sanitizedFolders[folderIndex];
      if (!isObjectRecord(folder)) return sanitizedFolder;

      const nextFolder = { ...folder, id: sanitizedFolder.id };
      if (Array.isArray(folder.prompts)) {
        nextFolder.prompts = folder.prompts.map((prompt, promptIndex) => ({
          ...(isObjectRecord(prompt) ? prompt : sanitizedFolder.prompts[promptIndex]),
          id: sanitizedFolder.prompts[promptIndex].id
        }));
      }
      return nextFolder;
    });
  }

  function haveFoldersChanged(sourceFolders, folders, sanitizedFolders) {
    if (!Array.isArray(sourceFolders)) return true;
    return folders.some((folder, folderIndex) => {
      const sanitizedFolder = sanitizedFolders[folderIndex];
      if (!isObjectRecord(folder) || folder.id !== sanitizedFolder.id) return true;
      if (!Array.isArray(folder.prompts)) return false;
      return folder.prompts.some((prompt, promptIndex) => (
        !isObjectRecord(prompt) ||
        prompt.id !== sanitizedFolder.prompts[promptIndex].id
      ));
    });
  }

  function createVersionZeroMigration(sanitizeFolders, isSafeId) {
    return function migrateVersionZero(snapshot) {
      const folders = Array.isArray(snapshot.folders) ? snapshot.folders : [];
      const normalized = sanitizeFolders(folders);
      validateSanitizedFolders(folders, normalized.folders, isSafeId);
      const migratedFolders = applySanitizedIds(folders, normalized.folders);
      const foldersChanged = haveFoldersChanged(
        snapshot.folders,
        folders,
        normalized.folders
      );
      const revision = normalizeRevision(snapshot.foldersRevision);
      const revisionChanged = revision !== snapshot.foldersRevision;
      const changes = {};

      if (foldersChanged) {
        changes.folders = migratedFolders;
        changes.foldersRevision = revision + 1;
      } else if (revisionChanged) {
        changes.foldersRevision = revision;
      }
      return changes;
    };
  }

  function createStorageMigrator({
    storage,
    sanitizeFolders,
    isSafeId,
    currentVersion = CURRENT_STORAGE_SCHEMA_VERSION,
    migrations
  }) {
    let inFlight = null;
    let migrated = false;
    const migrationSteps = migrations === undefined
      ? { 0: createVersionZeroMigration(sanitizeFolders, isSafeId) }
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
