(function attachPromptPocketLogic(global) {
  const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
  const QUICK_SCOPE_MODES = new Set(['all', 'pinned', 'folder']);

  function defaultIdFactory() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 3 | 8);
      return v.toString(16);
    });
  }

  function normalizeSearch(s) {
    return String(s || '').trim().toLowerCase();
  }

  function getSearchTokens(query) {
    return normalizeSearch(query).split(/\s+/).filter(Boolean);
  }

  function isSafeId(value) {
    return typeof value === 'string' && SAFE_ID_PATTERN.test(value);
  }

  function makeSafeId(value, usedIds = new Set(), idFactory = defaultIdFactory) {
    if (isSafeId(value) && !usedIds.has(value)) {
      usedIds.add(value);
      return value;
    }
    let nextId = idFactory();
    while (!isSafeId(nextId) || usedIds.has(nextId)) nextId = idFactory();
    usedIds.add(nextId);
    return nextId;
  }

  function normalizePromptForStorage(prompt, usedPromptIds, idFactory = defaultIdFactory) {
    const source = prompt && typeof prompt === 'object' ? prompt : {};
    const originalId = source.id;
    const id = makeSafeId(originalId, usedPromptIds, idFactory);
    return {
      value: {
        ...source,
        id,
        title: source.title || '未命名提示词',
        text: source.text || '',
        sourceUrl: source.sourceUrl || '',
        sourceTitle: source.sourceTitle || '',
        pinned: !!source.pinned,
        pinnedAt: source.pinned ? (source.pinnedAt || source.timestamp || new Date().toISOString()) : '',
        quickAt: source.quickAt || '',
        timestamp: source.timestamp || new Date().toISOString()
      },
      changed: id !== originalId
    };
  }

  function sanitizeFolders(folderList, idFactory = defaultIdFactory) {
    const usedFolderIds = new Set();
    const usedPromptIds = new Set();
    let changed = false;
    const safeFolders = (folderList || []).map((folder) => {
      const source = folder && typeof folder === 'object' ? folder : {};
      const originalFolderId = source.id;
      const folderId = makeSafeId(originalFolderId, usedFolderIds, idFactory);
      if (folderId !== originalFolderId) changed = true;
      const prompts = Array.isArray(source.prompts) ? source.prompts.map((prompt) => {
        const normalized = normalizePromptForStorage(prompt, usedPromptIds, idFactory);
        if (normalized.changed) changed = true;
        return normalized.value;
      }) : [];
      return {
        ...source,
        id: folderId,
        name: source.name || '导入的文件夹',
        prompts
      };
    });
    return { folders: safeFolders, changed };
  }

  function normalizeImportedFolders(data, idFactory = defaultIdFactory) {
    if (!Array.isArray(data)) {
      throw new Error('格式无效：需要文件夹数组 JSON。');
    }
    return sanitizeFolders(data, idFactory).folders;
  }

  function countPromptsInFolders(folderList) {
    return (folderList || []).reduce((sum, folder) => sum + ((folder.prompts || []).length), 0);
  }

  function cloneFoldersForBackup(folderList) {
    return (Array.isArray(folderList) ? folderList : []).map(folder => ({
      ...(folder && typeof folder === 'object' ? folder : {}),
      prompts: Array.isArray(folder && folder.prompts)
        ? folder.prompts.map(prompt => ({ ...(prompt && typeof prompt === 'object' ? prompt : {}) }))
        : []
    }));
  }

  function createPromptBackup(folderList, source, options = {}) {
    const folders = cloneFoldersForBackup(folderList);
    const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
    const idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultIdFactory;
    return {
      id: idFactory(),
      source: source || 'manual',
      createdAt: now(),
      folderCount: folders.length,
      promptCount: countPromptsInFolders(folders),
      folders
    };
  }

  function normalizePromptBackups(backups, options = {}) {
    const maxBackups = Number.isSafeInteger(options.maxBackups) && options.maxBackups > 0
      ? options.maxBackups
      : 20;
    return (Array.isArray(backups) ? backups : [])
      .filter(backup => (
        backup &&
        typeof backup === 'object' &&
        isSafeId(backup.id) &&
        typeof backup.createdAt === 'string' &&
        Number.isFinite(Date.parse(backup.createdAt)) &&
        Array.isArray(backup.folders)
      ))
      .map(backup => {
        const folders = cloneFoldersForBackup(backup.folders);
        return {
          ...backup,
          source: backup.source || 'manual',
          folderCount: folders.length,
          promptCount: countPromptsInFolders(folders),
          folders
        };
      })
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, maxBackups);
  }

  function addPromptBackup(backups, folderList, source, options = {}) {
    const maxBackups = Number.isSafeInteger(options.maxBackups) && options.maxBackups > 0
      ? options.maxBackups
      : 20;
    const backup = createPromptBackup(folderList, source, options);
    const next = normalizePromptBackups([backup, ...(Array.isArray(backups) ? backups : [])], { maxBackups });
    return { backup, backups: next };
  }

  function deletePromptBackup(backups, backupId, options = {}) {
    return normalizePromptBackups(backups, options).filter(backup => backup.id !== backupId);
  }

  function normalizeCleanupText(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function getCleanupReport(folderList) {
    const all = [];
    const empty = [];
    const groups = new Map();
    (folderList || []).forEach((folder, folderIndex) => {
      (folder.prompts || []).forEach((prompt, promptIndex) => {
        const ref = { folder, folderIndex, prompt, promptIndex };
        all.push(ref);
        const key = normalizeCleanupText(prompt && prompt.text);
        if (!key) {
          empty.push(ref);
          return;
        }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ref);
      });
    });
    const duplicateGroups = Array.from(groups.values()).filter(group => group.length > 1);
    const duplicateExtras = duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0);
    return {
      all,
      empty,
      duplicateGroups,
      duplicateExtras
    };
  }

  function promptMatchesSearch(prompt, folder, tokens, pinnedOnly) {
    if (pinnedOnly && !prompt.pinned) return false;
    if ((tokens || []).length === 0) return true;
    const haystack = normalizeSearch([
      prompt.title || '',
      prompt.text || '',
      folder && folder.name || ''
    ].join(' '));
    return tokens.every(token => haystack.includes(token));
  }

  function getFilteredFolders(folderList, folderFilterId = 'all') {
    if (!folderFilterId || folderFilterId === 'all') return folderList || [];
    return (folderList || []).filter(folder => folder.id === folderFilterId);
  }

  function getPromptSearchResults({ folders, folderFilterId = 'all', tokens = [], pinnedOnly = false }) {
    const results = [];
    getFilteredFolders(folders, folderFilterId).forEach((folder) => {
      getPromptDisplayItems(folder.prompts || []).forEach((prompt) => {
        if (promptMatchesSearch(prompt, folder, tokens, pinnedOnly)) {
          results.push({ folder, prompt });
        }
      });
    });
    return results;
  }

  function getPromptDisplayItems(prompts) {
    return (prompts || []).map((prompt, index) => ({ prompt, index })).sort((a, b) => {
      const aPinned = !!(a.prompt && a.prompt.pinned);
      const bPinned = !!(b.prompt && b.prompt.pinned);
      if (aPinned !== bPinned) return Number(bPinned) - Number(aPinned);
      if (aPinned && bPinned) {
        const pinnedDiff = getPinnedTime(b.prompt) - getPinnedTime(a.prompt);
        if (pinnedDiff !== 0) return pinnedDiff;
      }
      return a.index - b.index;
    }).map(entry => entry.prompt);
  }

  function getPromptInsertIndex(prompts) {
    const list = Array.isArray(prompts) ? prompts : [];
    const firstNormalIndex = list.findIndex(prompt => !prompt || !prompt.pinned);
    return firstNormalIndex >= 0 ? firstNormalIndex : list.length;
  }

  function applyPromptDisplayOrder(prompts, orderedPrompts, baseTime = Date.now()) {
    const original = Array.isArray(prompts) ? prompts : [];
    const orderedIds = new Set((orderedPrompts || []).map(prompt => prompt && prompt.id).filter(Boolean));
    const ordered = (orderedPrompts || []).filter(Boolean).concat(
      original.filter(prompt => prompt && !orderedIds.has(prompt.id))
    );
    const pinned = ordered.filter(prompt => prompt && prompt.pinned);
    const normal = ordered.filter(prompt => !prompt || !prompt.pinned);
    pinned.forEach((prompt, index) => {
      prompt.pinned = true;
      prompt.pinnedAt = new Date(baseTime - index * 1000).toISOString();
    });
    return pinned.concat(normal);
  }

  function getPinnedTime(prompt) {
    const time = Date.parse(prompt && (prompt.pinnedAt || prompt.timestamp || ''));
    return Number.isFinite(time) ? time : 0;
  }

  function getQuickTime(prompt) {
    const time = Date.parse(prompt && (prompt.quickAt || ''));
    return Number.isFinite(time) ? time : 0;
  }

  function getQuickPromptEntries(folderList) {
    const entries = [];
    (folderList || []).forEach((folder, folderIndex) => {
      (folder.prompts || []).forEach((prompt, promptIndex) => {
        if (!prompt || !prompt.text) return;
        entries.push({
          folder,
          prompt,
          fallbackOrder: folderIndex * 100000 + promptIndex
        });
      });
    });
    return entries.sort((a, b) => {
      const quickDiff = getQuickTime(b.prompt) - getQuickTime(a.prompt);
      if (quickDiff !== 0) return quickDiff;
      const aHasQuick = !!a.prompt.quickAt;
      const bHasQuick = !!b.prompt.quickAt;
      if (aHasQuick !== bHasQuick) return Number(bHasQuick) - Number(aHasQuick);
      if (a.prompt.pinned !== b.prompt.pinned) return Number(b.prompt.pinned) - Number(a.prompt.pinned);
      if (a.prompt.pinned && b.prompt.pinned) {
        const pinnedDiff = getPinnedTime(b.prompt) - getPinnedTime(a.prompt);
        if (pinnedDiff !== 0) return pinnedDiff;
      }
      return a.fallbackOrder - b.fallbackOrder;
    });
  }

  function getQuickPromptItems(folderList, scopeMode = 'all', scopeFolderId = '') {
    const safeScopeMode = QUICK_SCOPE_MODES.has(scopeMode) ? scopeMode : 'all';
    const items = [];
    const safeFolders = Array.isArray(folderList) ? folderList : [];
    for (let folderIndex = 0; folderIndex < safeFolders.length; folderIndex += 1) {
      const folder = safeFolders[folderIndex];
      if (safeScopeMode === 'folder' && folder.id !== scopeFolderId) continue;
      const prompts = folder.prompts || [];
      for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
        const prompt = prompts[promptIndex];
        if (!prompt || !prompt.text) continue;
        if (safeScopeMode === 'pinned' && !prompt.pinned) continue;
        items.push({
          id: prompt.id,
          title: prompt.title || '未命名提示词',
          text: prompt.text || '',
          folderId: folder.id || '',
          folder: folder.name || '未命名文件夹',
          pinned: !!prompt.pinned,
          pinnedAt: prompt.pinnedAt || prompt.timestamp || '',
          quickAt: prompt.quickAt || '',
          order: folderIndex * 100000 + promptIndex
        });
      }
    }
    if (safeScopeMode === 'folder') {
      return items.sort((a, b) => a.order - b.order);
    }
    return items.sort((a, b) => {
      const quickDiff = Date.parse(b.quickAt || '') - Date.parse(a.quickAt || '');
      if (Number.isFinite(quickDiff) && quickDiff !== 0) return quickDiff;
      if (!!a.quickAt !== !!b.quickAt) return Number(!!b.quickAt) - Number(!!a.quickAt);
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      if (a.pinned && b.pinned) {
        const diff = Date.parse(b.pinnedAt || '') - Date.parse(a.pinnedAt || '');
        if (Number.isFinite(diff) && diff !== 0) return diff;
      }
      return a.order - b.order;
    });
  }

  function mergeImportedFolders(currentFolders, importedFolders, idFactory = defaultIdFactory) {
    const next = (currentFolders || []).map(folder => ({
      ...folder,
      prompts: Array.isArray(folder.prompts) ? folder.prompts.map(prompt => ({ ...prompt })) : []
    }));
    const usedFolderIds = new Set(next.map(folder => folder.id).filter(Boolean));
    const usedPromptIds = new Set(next.flatMap(folder => (folder.prompts || []).map(prompt => prompt.id).filter(Boolean)));
    let addedFolders = 0;
    let addedPrompts = 0;
    let skippedPrompts = 0;

    (importedFolders || []).forEach((importedFolder) => {
      let target = next.find(folder => folder.id && importedFolder.id && folder.id === importedFolder.id);
      if (!target) {
        target = next.find(folder => normalizeSearch(folder.name) === normalizeSearch(importedFolder.name));
      }
      if (!target) {
        const folderId = makeSafeId(importedFolder.id, usedFolderIds, idFactory);
        target = {
          id: folderId,
          name: importedFolder.name,
          prompts: []
        };
        next.push(target);
        addedFolders += 1;
      }

      const existingPromptKeys = new Set((target.prompts || []).map(prompt => [
        normalizeSearch(prompt.title),
        normalizeSearch(prompt.text)
      ].join('\n')));
      (importedFolder.prompts || []).forEach((prompt) => {
        const promptKey = [normalizeSearch(prompt.title), normalizeSearch(prompt.text)].join('\n');
        if (existingPromptKeys.has(promptKey)) {
          skippedPrompts += 1;
          return;
        }
        const promptId = makeSafeId(prompt.id, usedPromptIds, idFactory);
        existingPromptKeys.add(promptKey);
        target.prompts = target.prompts || [];
        target.prompts.push({ ...prompt, id: promptId });
        addedPrompts += 1;
      });
    });

    return { folders: next, addedFolders, addedPrompts, skippedPrompts };
  }

  function getPromptPocketPlatform(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (/(^|\.)chatgpt\.com$/i.test(host) || /(^|\.)chat\.openai\.com$/i.test(host)) return 'chatgpt';
    if (/(^|\.)gemini\.google\.com$/i.test(host)) return 'gemini';
    return '';
  }

  function isChatGptPlanPath(pathname) {
    return /\/(?:pricing|plans|upgrade|settings\/subscription)(?:\/|$)/i.test(String(pathname || ''));
  }

  function isChatGptConversationContext({ hostname = '', pathname = '/', hasPlanText = false } = {}) {
    if (getPromptPocketPlatform(hostname) !== 'chatgpt') return false;
    if (hasPlanText || isChatGptPlanPath(pathname)) return false;
    const path = String(pathname || '/');
    if (/^\/(?:c|g|gpts|project|projects)\//i.test(path)) return true;
    return path === '/' || path === '';
  }

  function isGeminiConversationContext({ hostname = '' } = {}) {
    return getPromptPocketPlatform(hostname) === 'gemini';
  }

  function computeQuickLauncherPosition({
    composerRect,
    buttonRect,
    viewport,
    actionCenterY,
    margin = 10,
    gap = 16,
    bottomInset = 15
  } = {}) {
    if (!composerRect || !buttonRect || !viewport) return null;
    const viewportWidth = Number(viewport.width) || 0;
    const viewportHeight = Number(viewport.height) || 0;
    const buttonWidth = Number(buttonRect.width) || 0;
    const buttonHeight = Number(buttonRect.height) || 0;
    const rectRight = Number(composerRect.right) || 0;
    const rectBottom = Number(composerRect.bottom) || 0;
    const hasRightRoom = rectRight + gap + buttonWidth <= viewportWidth - margin;
    const targetLeft = hasRightRoom ? rectRight + gap : rectRight - buttonWidth - 14;
    const y = Number(actionCenterY);
    const targetTop = Number.isFinite(y) ? y - buttonHeight / 2 : rectBottom - buttonHeight - bottomInset;
    return {
      left: Math.max(margin, Math.min(targetLeft, viewportWidth - buttonWidth - margin)),
      top: Math.max(margin, Math.min(targetTop, viewportHeight - buttonHeight - margin))
    };
  }

  const api = {
    normalizeSearch,
    getSearchTokens,
    isSafeId,
    makeSafeId,
    normalizePromptForStorage,
    sanitizeFolders,
    normalizeImportedFolders,
    countPromptsInFolders,
    createPromptBackup,
    normalizePromptBackups,
    addPromptBackup,
    deletePromptBackup,
    normalizeCleanupText,
    getCleanupReport,
    promptMatchesSearch,
    getFilteredFolders,
    getPromptSearchResults,
    getPromptDisplayItems,
    getPromptInsertIndex,
    applyPromptDisplayOrder,
    getPinnedTime,
    getQuickTime,
    getQuickPromptEntries,
    getQuickPromptItems,
    mergeImportedFolders,
    getPromptPocketPlatform,
    isChatGptPlanPath,
    isChatGptConversationContext,
    isGeminiConversationContext,
    computeQuickLauncherPosition
  };

  global.PromptPocketLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
