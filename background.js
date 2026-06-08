/* Right-Click Prompt (Local) - background service worker. No auth, no cloud. */

importScripts(
  'sidepanel-logic.js',
  'storage-migrations.js',
  'folder-store.js',
  'folder-message-contract.js',
  'injection-routing.js'
);

const MENU_ROOT = 'rcp_root';
const AI_MENU_ROOT = 'ai_selection_root';
const SAVE_SELECTION_ID = 'rcp_save_selection';
const PINNED_PROMPT_PREFIX = 'pin_prompt_';
const PROMPT_PREFIX = 'prompt_';
const DEFAULT_FOLDER_NAME = '收件箱';
const MAX_FOLDERS = 25;
const MAX_PROMPTS_PER_FOLDER = 30;
const MAX_PINNED_PROMPTS = 12;
const SAVE_POPUP_WIDTH = 640;
const SAVE_POPUP_HEIGHT = 760;

const storageMigrator = PromptPocketStorageMigrations.createStorageMigrator({
  storage: {
    get: defaults => chrome.storage.local.get(defaults),
    set: changes => chrome.storage.local.set(changes)
  },
  sanitizeFolders: folders => PromptPocketLogic.sanitizeFolders(folders),
  isSafeId: id => PromptPocketLogic.isSafeId(id)
});

function ensureStorageMigrated() {
  return storageMigrator.ensureMigrated();
}

ensureStorageMigrated().catch((error) => {
  console.warn('PromptPocket storage migration failed:', error);
});

const folderStore = promptPocketFolderStore.createFolderStore({
  readState: async () => {
    await ensureStorageMigrated();
    const saved = await chrome.storage.local.get({ folders: [], foldersRevision: 0 });
    return { folders: saved.folders, revision: saved.foldersRevision };
  },
  writeState: async ({ folders, revision }) => {
    await ensureStorageMigrated();
    try {
      await chrome.storage.local.set({ folders, foldersRevision: revision });
    } catch (error) {
      throw new Error(formatStorageError(error));
    }
  }
});

async function getFolderState() {
  return folderStore.read();
}

async function getFolders() {
  const state = await getFolderState();
  return state.folders;
}

async function addFolder(name) {
  const folderName = String(name || '').trim();
  if (!folderName) throw new Error('文件夹名称不能为空。');

  const state = await folderStore.mutate((folders) => {
    const folder = { id: createId(), name: folderName, prompts: [] };
    folders.push(folder);
    return folder;
  });
  return { folder: state.result, folders: state.folders, revision: state.revision };
}

function formatStorageError(error) {
  const message = error && (error.message || String(error)) || '未知错误';
  const quotaHint = /quota|exceed|storage/i.test(message)
    ? ' 可能是本地存储空间不足，请先导出备份并清理重复或空内容。'
    : '';
  return '保存失败：' + message + quotaHint;
}

function createId() {
  if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function normalizePromptText(text) {
  return String(text || '').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
}

function makePromptTitle(text) {
  const normalized = normalizePromptText(text).replace(/\s+/g, ' ');
  if (!normalized) return '未命名提示词';
  return normalized.length > 32 ? normalized.slice(0, 32) + '...' : normalized;
}

function nowIso() {
  return new Date().toISOString();
}

function getPinnedTime(prompt) {
  const time = Date.parse(prompt && (prompt.pinnedAt || prompt.timestamp || ''));
  return Number.isFinite(time) ? time : 0;
}

function getOrCreateInbox(folders) {
  let inbox = folders.find(f => f && (f.name === DEFAULT_FOLDER_NAME || f.name === 'Inbox'));
  if (!inbox) {
    inbox = { id: createId(), name: DEFAULT_FOLDER_NAME, prompts: [] };
    folders.unshift(inbox);
  }
  inbox.prompts = Array.isArray(inbox.prompts) ? inbox.prompts : [];
  return inbox;
}

async function saveSelectionAsPrompt(selectionText, tab) {
  const text = normalizePromptText(selectionText);
  if (!text) {
    showToast('没有可保存的选中文本');
    return;
  }

  await folderStore.mutate((folders) => {
    const inbox = getOrCreateInbox(folders);
    inbox.prompts.unshift({
      id: createId(),
      title: makePromptTitle(text),
      text,
      timestamp: new Date().toISOString(),
      sourceUrl: tab && tab.url || '',
      sourceTitle: tab && tab.title || ''
    });
  });

  await buildContextMenu();
  showToast('已保存到“收件箱”');
}

function applyPopupCenterFromGeometry(popupOptions, geometry) {
  if (!geometry) return false;
  const left = Number(geometry.left);
  const top = Number(geometry.top);
  const width = Number(geometry.width);
  const height = Number(geometry.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;

  popupOptions.left = Math.max(0, Math.round(left + (width - SAVE_POPUP_WIDTH) / 2));
  popupOptions.top = Math.max(0, Math.round(top + (height - SAVE_POPUP_HEIGHT) / 2));
  return true;
}

async function openSaveSelectionWindow(selectionText, tab, geometry) {
  const text = normalizePromptText(selectionText);
  if (!text) {
    showToast('没有可保存的选中文本');
    return;
  }

  try {
    await chrome.storage.local.set({
      pendingPromptSave: {
        id: createId(),
        title: makePromptTitle(text),
        text,
        sourceUrl: tab && tab.url || '',
        sourceTitle: tab && tab.title || '',
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    throw new Error(formatStorageError(error));
  }

  const popupOptions = {
    url: chrome.runtime.getURL('save-selection.html'),
    type: 'popup',
    width: SAVE_POPUP_WIDTH,
    height: SAVE_POPUP_HEIGHT,
    focused: true
  };

  if (!applyPopupCenterFromGeometry(popupOptions, geometry)) {
    try {
      const sourceWindow = tab && tab.windowId
        ? await chrome.windows.get(tab.windowId)
        : await chrome.windows.getCurrent();
      applyPopupCenterFromGeometry(popupOptions, sourceWindow);
    } catch (e) {
      // If window geometry is unavailable, Chrome will choose the default position.
    }
  }

  await chrome.windows.create(popupOptions);
}

function getFolderForDraft(folders, folderId) {
  if (folderId) {
    const folder = folders.find(f => f && f.id === folderId);
    if (folder) {
      folder.prompts = Array.isArray(folder.prompts) ? folder.prompts : [];
      return folder;
    }
  }
  return getOrCreateInbox(folders);
}

async function savePromptDraftToFolder(draft) {
  const text = normalizePromptText(draft && draft.text);
  if (!text) throw new Error('提示词内容不能为空');

  await folderStore.mutate((folders) => {
    const targetFolder = getFolderForDraft(folders, draft && draft.folderId);
    const createdAt = nowIso();
    targetFolder.prompts.unshift({
      id: createId(),
      title: String(draft.title || '').trim() || makePromptTitle(text),
      text,
      timestamp: createdAt,
      sourceUrl: draft.sourceUrl || '',
      sourceTitle: draft.sourceTitle || '',
      pinned: !!draft.pinned,
      pinnedAt: draft.pinned ? createdAt : '',
      quickAt: createdAt
    });
  });

  await chrome.storage.local.remove('pendingPromptSave');
  await buildContextMenu();
}

function getPinnedPrompts(folders) {
  const pinned = [];
  for (const folder of folders) {
    for (const prompt of folder.prompts || []) {
      if (prompt && prompt.pinned) pinned.push({ folder, prompt });
    }
  }
  return pinned
    .sort((a, b) => getPinnedTime(b.prompt) - getPinnedTime(a.prompt))
    .slice(0, MAX_PINNED_PROMPTS);
}

function findPromptById(folders, promptId) {
  for (const folder of folders) {
    const prompt = (folder.prompts || []).find(p => p.id === promptId);
    if (prompt) return { folder, prompt };
  }
  return null;
}

async function getAiSelectionConfig() {
  const { aiOnSelectionEnabled, aiTargets, selectionPrompts } = await chrome.storage.local.get({
    aiOnSelectionEnabled: true,
    aiTargets: [],
    selectionPrompts: []
  });
  return {
    aiOnSelectionEnabled: aiOnSelectionEnabled !== false,
    aiTargets: Array.isArray(aiTargets) ? aiTargets : [],
    selectionPrompts: Array.isArray(selectionPrompts) ? selectionPrompts : []
  };
}

let contextMenuBuildQueue = Promise.resolve();

function clearRuntimeError() {
  return chrome.runtime.lastError && chrome.runtime.lastError.message || '';
}

function removeAllContextMenus() {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.removeAll(() => {
        clearRuntimeError();
        resolve();
      });
    } catch (error) {
      console.warn('PromptPocket context menu remove failed:', error);
      resolve();
    }
  });
}

function createContextMenu(item) {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus.create(item, () => {
        const message = clearRuntimeError();
        if (message && !/duplicate id/i.test(message)) {
          console.warn('PromptPocket context menu create failed:', message, item && item.id);
        }
        resolve(!message);
      });
    } catch (error) {
      console.warn('PromptPocket context menu create failed:', error, item && item.id);
      resolve(false);
    }
  });
}

function buildContextMenu() {
  contextMenuBuildQueue = contextMenuBuildQueue
    .catch(() => {})
    .then(rebuildContextMenu);
  return contextMenuBuildQueue;
}

async function rebuildContextMenu() {
  await removeAllContextMenus();
  await createContextMenu({ id: MENU_ROOT, title: 'PromptPocket 提示词口袋', contexts: ['all'] });
  await createContextMenu({ id: SAVE_SELECTION_ID, parentId: MENU_ROOT, title: '保存选中内容为提示词', contexts: ['selection'] });
  await createContextMenu({ id: 'rcp_save_sep', type: 'separator', parentId: MENU_ROOT, contexts: ['selection'] });

  const folders = await getFolders();
  const pinnedPrompts = getPinnedPrompts(folders);
  for (const { prompt } of pinnedPrompts) {
    await createContextMenu({
      id: PINNED_PROMPT_PREFIX + prompt.id,
      parentId: MENU_ROOT,
      title: '★ ' + (prompt.title || '未命名提示词').substring(0, 48),
      contexts: ['all']
    });
  }
  if (pinnedPrompts.length > 0) {
    await createContextMenu({ id: 'rcp_pinned_sep', type: 'separator', parentId: MENU_ROOT, contexts: ['all'] });
  }

  const withPrompts = folders.filter(f => f.prompts && f.prompts.length > 0);

  if (withPrompts.length === 0) {
    await createContextMenu({ id: 'rcp_open_panel', parentId: MENU_ROOT, title: '打开面板添加提示词...', contexts: ['all'] });
  } else {
    const sliceFolders = withPrompts.slice(0, MAX_FOLDERS);
    for (const folder of sliceFolders) {
      await createContextMenu({
        id: 'folder_' + folder.id,
        parentId: MENU_ROOT,
        title: folder.name,
        contexts: ['all']
      });
      const prompts = (folder.prompts || []).slice(0, MAX_PROMPTS_PER_FOLDER);
      for (const p of prompts) {
        await createContextMenu({
          id: PROMPT_PREFIX + p.id,
          parentId: 'folder_' + folder.id,
          title: (p.title || '未命名提示词').substring(0, 50),
          contexts: ['all']
        });
      }
      if ((folder.prompts || []).length > MAX_PROMPTS_PER_FOLDER) {
        await createContextMenu({
          id: 'more_' + folder.id,
          parentId: 'folder_' + folder.id,
          title: '更多内容请在面板中查看',
          contexts: ['all']
        });
      }
    }
    if (withPrompts.length > MAX_FOLDERS) {
      await createContextMenu({ id: 'rcp_more_folders', parentId: MENU_ROOT, title: '更多文件夹请在面板中查看', contexts: ['all'] });
    }
  }

  await createContextMenu({ id: 'rcp_sep1', type: 'separator', parentId: MENU_ROOT, contexts: ['all'] });
  await createContextMenu({ id: 'rcp_open_panel_2', parentId: MENU_ROOT, title: '打开管理面板', contexts: ['all'] });
  await createContextMenu({ id: 'rcp_refresh', parentId: MENU_ROOT, title: '刷新菜单', contexts: ['all'] });

  await buildAiOnSelectionMenu();
}

async function buildAiOnSelectionMenu() {
  const { aiOnSelectionEnabled, aiTargets, selectionPrompts } = await getAiSelectionConfig();
  if (!aiOnSelectionEnabled) return;

  await createContextMenu({ id: AI_MENU_ROOT, title: '选中文本发送给 AI', contexts: ['selection'] });

  if (selectionPrompts.length === 0) {
    await createContextMenu({
      id: 'ai_open_panel_empty_prompts',
      parentId: AI_MENU_ROOT,
      title: '在面板中添加选中文本指令...',
      contexts: ['selection']
    });
    return;
  }

  if (aiTargets.length === 0) {
    await createContextMenu({
      id: 'ai_open_panel_empty_targets',
      parentId: AI_MENU_ROOT,
      title: '在面板中添加 AI 目标...',
      contexts: ['selection']
    });
    return;
  }

  for (const sp of selectionPrompts) {
    const promptId = 'ai_prompt_' + sp.id;
    await createContextMenu({
      id: promptId,
      parentId: AI_MENU_ROOT,
      title: (sp.name || '未命名指令').substring(0, 50),
      contexts: ['selection']
    });
    for (const target of aiTargets) {
      await createContextMenu({
        id: `ai_target__${sp.id}__${target.id}`,
        parentId: promptId,
        title: (target.name || 'AI').substring(0, 50),
        contexts: ['selection']
      });
    }
  }

  await createContextMenu({
    id: 'ai_open_panel',
    parentId: AI_MENU_ROOT,
    title: '打开管理面板',
    contexts: ['selection']
  });
}

function showToast(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    const url = tab.url || '';
    const restricted = /^(chrome|chrome-extension|devtools|edge|about):/i.test(url);
    if (restricted) {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
      return;
    }
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (msg) => {
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:10px 16px;border-radius:8px;z-index:2147483647;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 2500);
      },
      args: [message]
    }).catch(() => {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
    });
  });
}

async function copyToClipboard(text) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id && tab.url && !/^(chrome|chrome-extension|devtools|edge|about):/i.test(tab.url)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (t) => navigator.clipboard && navigator.clipboard.writeText(t),
        args: [text]
      });
      return true;
    } catch (e) {
      // fallback: try worker clipboard if permitted
    }
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText)
      await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

async function tryAutoPasteInTab(tabId, text, frameId, url) {
  if (!tabId) return false;
  const request = PromptPocketInjectionRouting.createInjectionRequest(url, text);
  if (!request) return false;
  return sendMessageWithRetry(tabId, request.message, 8, 600, frameId);
}

function applySelectionTemplate(template, selectedText) {
  const base = (template || '').toString();
  return base.replace(/{{\s*text\s*}}/gi, selectedText || '');
}

function buildTargetUrl(baseUrl, queryParam, text) {
  if (!baseUrl) return null;
  const trimmed = String(baseUrl).trim();
  const paramRaw = (queryParam || '').toString().trim();
  if (!paramRaw) return trimmed;
  try {
    const url = new URL(trimmed);
    const key = paramRaw.includes('=') ? paramRaw.split('=')[0] : paramRaw;
    if (key) {
      url.searchParams.set(key, text);
      return url.toString();
    }
  } catch (e) {
    // fallback to string concat
  }
  const joiner = trimmed.includes('?') ? (trimmed.endsWith('?') || trimmed.endsWith('&') ? '' : '&') : '?';
  const prefix = paramRaw.endsWith('=') ? paramRaw : (paramRaw + '=');
  return trimmed + joiner + prefix + encodeURIComponent(text);
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs || 12000);
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function handleAiOnSelectionClick(promptId, targetId, selectionText) {
  const { aiTargets, selectionPrompts } = await getAiSelectionConfig();
  const prompt = selectionPrompts.find(p => p.id === promptId);
  const target = aiTargets.find(t => t.id === targetId);
  if (!prompt || !target) return;

  const composed = applySelectionTemplate(prompt.template || '', selectionText || '');
  const usePasteFallback = !!target.usePasteFallback;
  const baseUrl = target.baseUrl || '';

  if (usePasteFallback) {
    await copyToClipboard(composed);
    const tab = await chrome.tabs.create({ url: baseUrl, active: true });
    if (!tab || !tab.id) return;
    await waitForTabComplete(tab.id, 15000);
    const pasted = await tryAutoPasteInTab(tab.id, composed, undefined, baseUrl);
    showToast(pasted ? '已粘贴' : '已复制，请按 Ctrl+V 粘贴');
    return;
  }

  const url = buildTargetUrl(baseUrl, target.queryParam || 'q=', composed);
  if (!url) return;
  await chrome.tabs.create({ url, active: true });
}

function sendMessageWithRetry(tabId, message, attempts, delayMs, frameId) {
  return PromptPocketInjectionRouting.sendInjectionMessageWithRetry(
    {
      tabs: chrome.tabs,
      runtime: chrome.runtime,
      schedule: setTimeout
    },
    { tabId, message, attempts, delayMs, frameId }
  );
}

async function copyPromptFallback(text, url) {
  const restricted = /^(chrome|chrome-extension|devtools|edge|about|centbrowser):/i.test(url || '');
  if (restricted) {
    showToast('浏览器内部页面不可用，请切换到普通网页');
    return false;
  }
  const ok = await copyToClipboard(text);
  showToast(ok ? '已复制，请按 Ctrl+V 粘贴' : '复制失败');
  return ok;
}

async function handlePromptCopy(promptId, text) {
  const { autoPaste } = await chrome.storage.local.get({ autoPaste: false });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab && tab.id;
  const url = tab && tab.url || '';
  const restricted = /^(chrome|chrome-extension|devtools|edge|about|centbrowser):/i.test(url);

  if (autoPaste && tabId && !restricted) {
    const pasted = await tryAutoPasteInTab(tabId, text, undefined, url);
    if (pasted) {
      showToast('已粘贴');
      return;
    }
  }
  await copyPromptFallback(text, url);
}

async function handleSelectionCommandCopy(text, tab, frameId) {
  const { autoPaste } = await chrome.storage.local.get({ autoPaste: false });
  const activeTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const tabId = activeTab && activeTab.id;
  const url = activeTab && activeTab.url || '';
  const restricted = /^(chrome|chrome-extension|devtools|edge|about|centbrowser):/i.test(url);

  if (autoPaste && tabId && !restricted) {
    const pasted = await tryAutoPasteInTab(tabId, text, frameId, url);
    if (pasted) {
      showToast('已粘贴');
      return { pasted: true };
    }
  }
  if (restricted) {
    showToast('浏览器内部页面不可用，请切换到普通网页');
    return { pasted: false, copied: false };
  }
  const ok = await copyToClipboard(text);
  showToast(ok ? '已复制，请按 Ctrl+V 粘贴' : '复制失败');
  return { pasted: false, copied: ok };
}

let debounceTimer;
function debouncedRebuild() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(buildContextMenu, 300);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const state = await getFolderState();
  if (state.folders.length === 0) {
    await folderStore.commitSnapshot(
      [{ id: createId(), name: DEFAULT_FOLDER_NAME, prompts: [] }],
      state.revision
    );
  }
  await buildContextMenu();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.folders || changes.quickAccessData || changes.aiTargets || changes.selectionPrompts || changes.aiOnSelectionEnabled))
    debouncedRebuild();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = info.menuItemId;
  if (id === 'rcp_open_panel' || id === 'rcp_open_panel_2' || id === 'rcp_more_folders') {
    if (tab && tab.id) chrome.sidePanel.open({ tabId: tab.id });
    return;
  }
  if (id === 'rcp_refresh') {
    await buildContextMenu();
    showToast('菜单已刷新');
    return;
  }
  if (id === SAVE_SELECTION_ID) {
    await openSaveSelectionWindow(info.selectionText || '', tab);
    return;
  }
  if (id === 'ai_open_panel' || id === 'ai_open_panel_empty_prompts' || id === 'ai_open_panel_empty_targets') {
    if (tab && tab.id) chrome.sidePanel.open({ tabId: tab.id });
    return;
  }
  if (id.startsWith('ai_target__')) {
    const parts = id.split('__');
    const promptId = parts[1];
    const targetId = parts[2];
    if (promptId && targetId) {
      await handleAiOnSelectionClick(promptId, targetId, info.selectionText || '');
    }
    return;
  }
  if (id.startsWith('more_')) {
    if (tab && tab.id) chrome.sidePanel.open({ tabId: tab.id });
    return;
  }
  const promptMatch = id.startsWith(PINNED_PROMPT_PREFIX)
    ? id.slice(PINNED_PROMPT_PREFIX.length)
    : (id.startsWith(PROMPT_PREFIX) && id.slice(PROMPT_PREFIX.length));
  if (promptMatch) {
    const folders = await getFolders();
    const found = findPromptById(folders, promptMatch);
    if (found) {
      const { prompt } = found;
      const { autoPaste } = await chrome.storage.local.get({ autoPaste: false });
      const url = tab && tab.url || '';
      const restricted = /^(chrome|chrome-extension|devtools|edge|about|centbrowser):/i.test(url);
      if (autoPaste && tab && tab.id && !restricted) {
        const pasted = await tryAutoPasteInTab(tab.id, prompt.text, info.frameId, url);
        if (pasted) {
          showToast('已粘贴');
          return;
        }
      }
      await copyPromptFallback(prompt.text, url);
      return;
    }
  }
});

const folderMessageHandler = PromptPocketFolderMessageContract.createFolderMessageHandler({
  folderStore,
  addFolder,
  savePromptDraft: savePromptDraftToFolder,
  onFoldersChanged: debouncedRebuild
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (folderMessageHandler(msg, sender, sendResponse)) return true;
  if (msg.action === 'openSaveSelection') {
    const tab = sender && sender.tab || null;
    openSaveSelectionWindow(msg.text || '', tab, msg.geometry).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.action === 'usePrompt') {
    handlePromptCopy(msg.promptId || '', msg.text || '').then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.action === 'useSelectionCommand') {
    const tab = sender && sender.tab || null;
    handleSelectionCommandCopy(msg.text || '', tab, sender && sender.frameId).then(result => {
      sendResponse({ success: true, pasted: !!(result && result.pasted), copied: !!(result && result.copied) });
    }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.action === 'rebuildMenu') {
    buildContextMenu().then(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.action === 'enableAutoPaste') {
    chrome.storage.local.set({ autoPaste: true }).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: formatStorageError(e) }));
    return true;
  }
  if (msg.action === 'disableAutoPaste') {
    chrome.storage.local.set({ autoPaste: false }).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: formatStorageError(e) }));
    return true;
  }
  if (msg.action === 'getAutoPaste') {
    chrome.storage.local.get({ autoPaste: false }).then(o => sendResponse({ autoPaste: o.autoPaste }));
    return true;
  }
});
