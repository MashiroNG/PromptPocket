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

  function createStorageMigrator({ storage, sanitizeFolders }) {
    let inFlight = null;
    let migrated = false;

    async function migrate() {
      const saved = await storage.get({
        folders: [],
        foldersRevision: 0,
        [STORAGE_SCHEMA_VERSION_KEY]: 0
      });
      const version = normalizeSchemaVersion(saved[STORAGE_SCHEMA_VERSION_KEY]);

      if (version > CURRENT_STORAGE_SCHEMA_VERSION) {
        throw new Error(
          `Storage schema version ${version} is newer than supported version ${CURRENT_STORAGE_SCHEMA_VERSION}`
        );
      }
      if (version === CURRENT_STORAGE_SCHEMA_VERSION) return;

      const normalized = sanitizeFolders(saved.folders);
      const changes = {
        [STORAGE_SCHEMA_VERSION_KEY]: CURRENT_STORAGE_SCHEMA_VERSION
      };
      if (normalized.changed) {
        changes.folders = normalized.folders;
        changes.foldersRevision = normalizeRevision(saved.foldersRevision) + 1;
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
