/* Right-Click Prompt (Local) - side panel. No auth, no cloud. */

let folders = [];
let selectedFolderId = null;
let dragState = null;
let promptSearchQuery = '';
let promptFolderFilterId = 'all';
let promptPinnedOnly = false;
let quickPromptScopeMode = 'all';
let quickPromptScopeFolderId = '';
let pendingImportFile = null;
let pendingImportedFolders = null;
let pendingImportToken = 0;
let pendingImportError = '';
let quickManagerQuery = '';
let aiTargets = [];
let selectionPrompts = [];
let aiOnSelectionEnabled = true;
let sidepanelTheme = 'dark';
const DEFAULT_FOLDER_NAME = '收件箱';
const QUICK_SCOPE_MODES = new Set(['all', 'pinned', 'folder']);

async function closeSidePanelFromShortcut() {
  if (typeof chrome !== 'undefined' && chrome.sidePanel && typeof chrome.sidePanel.close === 'function') {
    let closeOptions = null;
    if (chrome.windows && typeof chrome.windows.getCurrent === 'function') {
      try {
        const currentWindow = await chrome.windows.getCurrent();
        if (Number.isInteger(currentWindow && currentWindow.id)) {
          closeOptions = { windowId: currentWindow.id };
        }
      } catch (error) {
        closeOptions = null;
      }
    }
    if (!closeOptions && chrome.windows && Number.isInteger(chrome.windows.WINDOW_ID_CURRENT)) {
      closeOptions = { windowId: chrome.windows.WINDOW_ID_CURRENT };
    }
    if (closeOptions) {
      try {
        await chrome.sidePanel.close(closeOptions);
        return;
      } catch (error) {
        // Older or non-Chrome environments can fail here; fall back to window.close().
      }
    }
  }
  try {
    window.close();
  } catch (error) {
    // No further fallback is available.
  }
}

async function loadFolders() {
  const { folders: f } = await chrome.storage.local.get({ folders: [] });
  folders = Array.isArray(f) ? f : [];
  if (folders.length === 0) {
    folders = [{ id: uuid(), name: DEFAULT_FOLDER_NAME, prompts: [] }];
    await saveFolders();
  }
  if (folders.length > 0 && !folders.some(f => f.id === selectedFolderId)) {
    selectedFolderId = folders[0].id;
  }
  render();
  const pinnedModal = document.getElementById('modalPinnedManager');
  if (pinnedModal && !pinnedModal.classList.contains('hidden')) renderPinnedManager();
  const quickModal = document.getElementById('modalQuickManager');
  if (quickModal && !quickModal.classList.contains('hidden')) renderQuickManager();
  const cleanupModal = document.getElementById('modalCleanup');
  if (cleanupModal && !cleanupModal.classList.contains('hidden')) renderCleanupTool();
}

async function loadAiConfig() {
  const { aiOnSelectionEnabled: enabled, aiTargets: targets, selectionPrompts: prompts } = await chrome.storage.local.get({
    aiOnSelectionEnabled: true,
    aiTargets: [],
    selectionPrompts: []
  });
  aiOnSelectionEnabled = enabled !== false;
  aiTargets = Array.isArray(targets) ? targets : [];
  selectionPrompts = Array.isArray(prompts) ? prompts : [];
  renderAiTab();
}

function render() {
  const listEl = document.getElementById('foldersList');
  listEl.innerHTML = '';
  folders.forEach((f, index) => {
    const div = document.createElement('div');
    div.className = 'folder-item' + (f.id === selectedFolderId ? ' active' : '');
    div.dataset.id = f.id;
    div.draggable = true;
    div.style.setProperty('--item-index', Math.min(index, 8));
    div.innerHTML = `
      <div class="meta">
        <span class="name">${escapeHtml(f.name || '未命名文件夹')}</span>
        <span class="count">${(f.prompts || []).length} 条</span>
      </div>
    `;
    div.addEventListener('click', () => selectFolder(f.id));
    div.addEventListener('dblclick', () => openEditFolderModal(f.id));
    div.addEventListener('dragstart', (e) => onFolderDragStart(e, f.id));
    div.addEventListener('dragover', onItemDragOver);
    div.addEventListener('dragleave', onItemDragLeave);
    div.addEventListener('drop', (e) => onFolderDrop(e, f.id));
    div.addEventListener('dragend', onItemDragEnd);
    listEl.appendChild(div);
  });
  renderPromptFilterOptions();
  renderQuickScopeSettings();
  renderPrompts();
}

function selectFolder(id) {
  selectedFolderId = id;
  render();
}

function syncSelectedFolderFromFilter() {
  if (!promptFolderFilterId || promptFolderFilterId === 'all') return;
  if (folders.some(folder => folder.id === promptFolderFilterId)) {
    selectedFolderId = promptFolderFilterId;
  }
}

function getSelectedFolder() {
  return folders.find(f => f.id === selectedFolderId);
}

function normalizeSearch(s) {
  return String(s || '').trim().toLowerCase();
}

function getSearchTokens() {
  return normalizeSearch(promptSearchQuery).split(/\s+/).filter(Boolean);
}

function promptMatchesSearch(prompt, folder, tokens, pinnedOnly) {
  if (pinnedOnly && !prompt.pinned) return false;
  if (tokens.length === 0) return true;
  const haystack = normalizeSearch([
    prompt.title || '',
    prompt.text || '',
    folder && folder.name || ''
  ].join(' '));
  return tokens.every(token => haystack.includes(token));
}

function getFilteredFolders() {
  if (!promptFolderFilterId || promptFolderFilterId === 'all') return folders;
  return folders.filter(folder => folder.id === promptFolderFilterId);
}

function getPromptLocation(promptId, folderId) {
  const folderList = folderId ? folders.filter(f => f.id === folderId) : folders;
  for (const folder of folderList) {
    const prompts = Array.isArray(folder.prompts) ? folder.prompts : [];
    const index = prompts.findIndex(p => p.id === promptId);
    if (index >= 0) return { folder, prompt: prompts[index], index };
  }
  return null;
}

function getPromptSearchResults(tokens) {
  const results = [];
  getFilteredFolders().forEach((folder) => {
    (folder.prompts || []).forEach((prompt) => {
      if (promptMatchesSearch(prompt, folder, tokens, promptPinnedOnly)) {
        results.push({ folder, prompt });
      }
    });
  });
  return results;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightMatches(text, tokens) {
  const source = String(text || '');
  const safeTokens = [...new Set(tokens || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  if (safeTokens.length === 0 || !source) return escapeHtml(source);
  const regex = new RegExp(safeTokens.map(escapeRegExp).join('|'), 'gi');
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(source)) !== null) {
    if (match[0].length === 0) continue;
    result += escapeHtml(source.slice(lastIndex, match.index));
    result += `<mark class="match-highlight">${escapeHtml(match[0])}</mark>`;
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(source.slice(lastIndex));
  return result;
}

function getPromptPreviewText(text, tokens) {
  const source = String(text || '');
  if (source.length <= 120) return source;
  const normalized = normalizeSearch(source);
  const firstMatch = (tokens || [])
    .map(token => normalized.indexOf(token))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0];
  if (!Number.isFinite(firstMatch) || firstMatch <= 60) return source.slice(0, 120) + '…';
  const start = Math.max(0, firstMatch - 42);
  return '…' + source.slice(start, start + 120) + (start + 120 < source.length ? '…' : '');
}

function createPromptCard(prompt, folder, showFolderName, tokens = [], index = 0) {
  const card = document.createElement('div');
  card.className = 'prompt-card';
  card.dataset.id = prompt.id;
  card.dataset.folderId = folder.id;
  card.draggable = true;
  card.style.setProperty('--item-index', Math.min(index, 8));
  const previewText = getPromptPreviewText(prompt.text || '', tokens);
  card.innerHTML = `
    <div class="prompt-card-head">
      <div class="title">${highlightMatches(prompt.title || '未命名提示词', tokens)}</div>
      <div class="card-tools">
        ${prompt.pinned ? '<span class="pin-badge">置顶</span>' : ''}
      </div>
    </div>
    ${showFolderName ? `<div class="folder-name">${highlightMatches(folder.name || '未命名文件夹', tokens)}</div>` : ''}
    <div class="text">${highlightMatches(previewText, tokens)}</div>
    <div class="actions compact-actions">
      <button type="button" class="btn primary-action" data-action="use" data-id="${prompt.id}">使用</button>
      <button type="button" class="btn" data-action="edit" data-id="${prompt.id}">编辑</button>
      <div class="more-wrap">
        <button type="button" class="btn more-action" data-action="more" data-id="${prompt.id}" aria-label="更多操作" title="更多操作" aria-haspopup="menu" aria-expanded="false">⋯</button>
        <div class="card-more-menu" role="menu">
          <button type="button" data-action="copy" data-id="${prompt.id}" role="menuitem">复制</button>
          <button type="button" data-action="pin" data-id="${prompt.id}" role="menuitem">${prompt.pinned ? '取消置顶' : '置顶'}</button>
        </div>
      </div>
    </div>
  `;
  card.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    editPrompt(prompt.id);
  });
  card.addEventListener('dragstart', (e) => onPromptDragStart(e, prompt.id, folder.id));
  card.addEventListener('dragover', onItemDragOver);
  card.addEventListener('dragleave', onItemDragLeave);
  card.addEventListener('drop', (e) => onPromptDrop(e, prompt.id, folder.id));
  card.addEventListener('dragend', onItemDragEnd);
  return card;
}

function getPromptFolderFilterLabel() {
  if (!promptFolderFilterId || promptFolderFilterId === 'all') return '全部文件夹';
  const folder = folders.find(item => item.id === promptFolderFilterId);
  return folder && folder.name || '全部文件夹';
}

function hasPromptFilters(tokens = getSearchTokens()) {
  return tokens.length > 0 || promptPinnedOnly || promptFolderFilterId !== 'all';
}

function renderSearchStatus(resultCount, tokens = getSearchTokens()) {
  const statusEl = document.getElementById('searchStatus');
  const textEl = document.getElementById('searchStatusText');
  if (!statusEl || !textEl) return;
  if (!hasPromptFilters(tokens)) {
    statusEl.classList.add('hidden');
    textEl.textContent = '';
    return;
  }

  const parts = [
    `已筛选 ${resultCount} 条`,
    getPromptFolderFilterLabel()
  ];
  if (promptPinnedOnly) parts.push('只看置顶');
  const keyword = String(promptSearchQuery || '').trim();
  if (keyword) parts.push(`关键词：${keyword}`);

  textEl.innerHTML = parts.map((part, index) => (
    index === 0 ? `<strong>${escapeHtml(part)}</strong>` : escapeHtml(part)
  )).join(' / ');
  statusEl.classList.remove('hidden');
}

function clearPromptFilters() {
  promptSearchQuery = '';
  promptFolderFilterId = 'all';
  promptPinnedOnly = false;
  const searchEl = document.getElementById('promptSearch');
  const pinnedEl = document.getElementById('promptPinnedOnly');
  if (searchEl) searchEl.value = '';
  if (pinnedEl) pinnedEl.checked = false;
  closePromptFolderFilter();
  renderPromptFilterOptions();
  renderPrompts();
}

function closePromptFolderFilter() {
  const root = document.getElementById('promptFolderFilter');
  const button = document.getElementById('promptFolderFilterButton');
  const menu = document.getElementById('promptFolderFilterMenu');
  if (!root || !button || !menu) return;
  root.classList.remove('open');
  menu.classList.add('hidden');
  button.setAttribute('aria-expanded', 'false');
}

function openPromptFolderFilter() {
  const root = document.getElementById('promptFolderFilter');
  const button = document.getElementById('promptFolderFilterButton');
  const menu = document.getElementById('promptFolderFilterMenu');
  if (!root || !button || !menu) return;
  root.classList.add('open');
  menu.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
}

function togglePromptFolderFilter() {
  const root = document.getElementById('promptFolderFilter');
  const button = document.getElementById('promptFolderFilterButton');
  const menu = document.getElementById('promptFolderFilterMenu');
  if (!root || !button || !menu) return;
  const willOpen = menu.classList.contains('hidden');
  if (willOpen) openPromptFolderFilter();
  else closePromptFolderFilter();
}

function renderPromptFilterOptions() {
  const root = document.getElementById('promptFolderFilter');
  const label = root && root.querySelector('[data-folder-filter-label]');
  const menu = document.getElementById('promptFolderFilterMenu');
  if (!root || !label || !menu) return;
  const exists = promptFolderFilterId === 'all' || folders.some(folder => folder.id === promptFolderFilterId);
  if (!exists) promptFolderFilterId = 'all';
  label.textContent = getPromptFolderFilterLabel();
  const options = [
    { id: 'all', name: '全部文件夹', count: folders.reduce((sum, folder) => sum + (folder.prompts || []).length, 0) },
    ...folders.map(folder => ({
      id: folder.id,
      name: folder.name || '未命名文件夹',
      count: (folder.prompts || []).length
    }))
  ];
  menu.innerHTML = options.map(option => [
    `<button type="button" class="filter-option${option.id === promptFolderFilterId ? ' selected' : ''}" data-folder-id="${escapeHtml(option.id)}">`,
    `<span class="name">${escapeHtml(option.name)}</span>`,
    `<span class="count">${option.count}</span>`,
    '</button>'
  ].join('')).join('');
}

function getFocusableMenuItems(menu) {
  return Array.from(menu.querySelectorAll('button:not([disabled])'))
    .filter(item => item.offsetParent !== null);
}

function focusMenuItem(menu, direction = 1, preferredSelector = '.selected') {
  const items = getFocusableMenuItems(menu);
  if (items.length === 0) return;
  const activeIndex = items.indexOf(document.activeElement);
  let nextIndex = activeIndex;
  if (activeIndex < 0) {
    const preferredIndex = preferredSelector ? items.findIndex(item => item.matches(preferredSelector)) : -1;
    nextIndex = preferredIndex >= 0 ? preferredIndex : (direction < 0 ? items.length - 1 : 0);
  } else {
    nextIndex = (activeIndex + direction + items.length) % items.length;
  }
  items[nextIndex].focus();
}

function focusMenuEdge(menu, toEnd = false) {
  const items = getFocusableMenuItems(menu);
  if (items.length === 0) return;
  items[toEnd ? items.length - 1 : 0].focus();
}

function handleMenuKeyboard(event, menu, closeMenu, trigger) {
  if (!menu || menu.classList.contains('hidden')) return false;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
    if (trigger) trigger.focus();
    return true;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    focusMenuItem(menu, event.key === 'ArrowDown' ? 1 : -1);
    return true;
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    focusMenuEdge(menu, event.key === 'End');
    return true;
  }
  if ((event.key === 'Enter' || event.key === ' ') && document.activeElement && menu.contains(document.activeElement)) {
    event.preventDefault();
    document.activeElement.click();
    return true;
  }
  return false;
}

function openMenuFromTrigger(event, openMenu, menu, focusDirection = 1) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter' && event.key !== ' ') return false;
  event.preventDefault();
  openMenu();
  requestAnimationFrame(() => focusMenuItem(menu, event.key === 'ArrowUp' ? -1 : focusDirection));
  return true;
}

function normalizeQuickScopeFolder() {
  if (quickPromptScopeMode !== 'folder') return false;
  if (folders.some(folder => folder.id === quickPromptScopeFolderId)) return false;
  quickPromptScopeFolderId = folders[0] && folders[0].id || '';
  return true;
}

function getQuickScopeModeLabel(mode = quickPromptScopeMode) {
  if (mode === 'pinned') return '只显示置顶';
  if (mode === 'folder') return '指定文件夹';
  return '全部提示词';
}

function getQuickScopeFolderLabel() {
  const folder = folders.find(item => item.id === quickPromptScopeFolderId);
  return folder && folder.name || '选择文件夹';
}

function closeQuickScopeMenus() {
  [
    ['quickScopeModePicker', 'quickScopeModeButton', 'quickScopeModeMenu'],
    ['quickScopeFolderPicker', 'quickScopeFolderButton', 'quickScopeFolderMenu']
  ].forEach(([pickerId, buttonId, menuId]) => {
    const picker = document.getElementById(pickerId);
    const button = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);
    if (!picker || !button || !menu) return;
    picker.classList.remove('open');
    menu.classList.add('hidden');
    button.setAttribute('aria-expanded', 'false');
  });
}

function openQuickScopeMenu(type) {
  const isFolder = type === 'folder';
  const picker = document.getElementById(isFolder ? 'quickScopeFolderPicker' : 'quickScopeModePicker');
  const button = document.getElementById(isFolder ? 'quickScopeFolderButton' : 'quickScopeModeButton');
  const menu = document.getElementById(isFolder ? 'quickScopeFolderMenu' : 'quickScopeModeMenu');
  if (!picker || !button || !menu) return;
  closeQuickScopeMenus();
  picker.classList.add('open');
  menu.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
}

function toggleQuickScopeMenu(type) {
  const isFolder = type === 'folder';
  const picker = document.getElementById(isFolder ? 'quickScopeFolderPicker' : 'quickScopeModePicker');
  const button = document.getElementById(isFolder ? 'quickScopeFolderButton' : 'quickScopeModeButton');
  const menu = document.getElementById(isFolder ? 'quickScopeFolderMenu' : 'quickScopeModeMenu');
  if (!picker || !button || !menu) return;
  const willOpen = menu.classList.contains('hidden');
  if (willOpen) openQuickScopeMenu(type);
  else closeQuickScopeMenus();
}

function renderQuickScopeSettings() {
  const root = document.querySelector('.quick-scope-settings');
  const modeLabel = document.getElementById('quickScopeModeLabel');
  const modeMenu = document.getElementById('quickScopeModeMenu');
  const folderPicker = document.getElementById('quickScopeFolderPicker');
  const folderLabel = document.getElementById('quickScopeFolderLabel');
  const folderMenu = document.getElementById('quickScopeFolderMenu');
  if (!root || !modeLabel || !modeMenu || !folderPicker || !folderLabel || !folderMenu) return;

  if (!QUICK_SCOPE_MODES.has(quickPromptScopeMode)) quickPromptScopeMode = 'all';
  const folderChanged = normalizeQuickScopeFolder();
  const useFolder = quickPromptScopeMode === 'folder';
  root.classList.toggle('with-folder', useFolder);
  modeLabel.textContent = getQuickScopeModeLabel();
  folderPicker.classList.toggle('hidden', !useFolder);
  modeMenu.innerHTML = [
    { id: 'all', name: '全部提示词' },
    { id: 'pinned', name: '只显示置顶' },
    { id: 'folder', name: '指定文件夹' }
  ].map(option => (
    `<button type="button" class="quick-scope-option${option.id === quickPromptScopeMode ? ' selected' : ''}" data-quick-scope-mode="${option.id}"><span>${escapeHtml(option.name)}</span></button>`
  )).join('');
  folderLabel.textContent = getQuickScopeFolderLabel();
  folderMenu.innerHTML = folders.map(folder => (
    `<button type="button" class="quick-scope-option${folder.id === quickPromptScopeFolderId ? ' selected' : ''}" data-quick-scope-folder="${escapeHtml(folder.id)}"><span>${escapeHtml(folder.name || '未命名文件夹')}</span><span class="count">${(folder.prompts || []).length}</span></button>`
  )).join('');
  if (folderChanged) saveQuickScopeSettings().catch(() => {});
}

function renderPrompts() {
  const emptyEl = document.getElementById('emptyState');
  const listEl = document.getElementById('promptsList');
  const folder = getSelectedFolder();
  const searchTokens = getSearchTokens();
  const hasSearchQuery = searchTokens.length > 0;
  const isFiltering = hasPromptFilters(searchTokens);

  if (isFiltering) {
    const results = getPromptSearchResults(searchTokens);
    renderSearchStatus(results.length, searchTokens);
    emptyEl.classList.add('hidden');
    listEl.classList.remove('hidden');
    listEl.innerHTML = '';

    if (results.length === 0) {
      listEl.innerHTML = '<div class="empty">没有找到匹配的提示词。</div>';
      return;
    }

    results.forEach(({ folder: resultFolder, prompt }, index) => {
      const showFolderName = hasSearchQuery && promptFolderFilterId === 'all';
      listEl.appendChild(createPromptCard(prompt, resultFolder, showFolderName, searchTokens, index));
    });
    return;
  }

  renderSearchStatus(0, searchTokens);

  if (!folder) {
    emptyEl.classList.remove('hidden');
    listEl.classList.add('hidden');
    emptyEl.textContent = folders.length === 0 ? '先添加一个文件夹。' : '选择一个文件夹，或新建文件夹。';
    return;
  }

  emptyEl.classList.add('hidden');
  listEl.classList.remove('hidden');
  const prompts = folder.prompts || [];
  listEl.innerHTML = '';

  if (prompts.length === 0) {
    listEl.innerHTML = '<div class="empty">这里还没有提示词。点击“+ 提示词”添加，或在网页中选中文字后右键保存。</div>';
    return;
  }

  prompts.forEach((p, index) => {
    listEl.appendChild(createPromptCard(p, folder, false, [], index));
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 3 | 8);
    return v.toString(16);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function applyPinnedState(prompt, pinned) {
  if (!prompt) return;
  const wasPinned = !!prompt.pinned;
  prompt.pinned = !!pinned;
  if (prompt.pinned && !wasPinned) {
    prompt.pinnedAt = nowIso();
  }
  if (!prompt.pinned) {
    delete prompt.pinnedAt;
  }
}

async function copyPrompt(promptId) {
  const location = getPromptLocation(promptId);
  if (!location) return;
  try {
    await navigator.clipboard.writeText(location.prompt.text || '');
    const btn = document.querySelector(`button[data-action="copy"][data-id="${promptId}"]`);
    if (btn) { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); }
  } catch (e) {
    console.error(e);
  }
}

async function usePrompt(promptId) {
  const location = getPromptLocation(promptId);
  if (!location) return;
  chrome.runtime.sendMessage({ action: 'usePrompt', promptId, text: location.prompt.text || '' }, (response) => {
    const btn = document.querySelector(`button[data-action="use"][data-id="${promptId}"]`);
    if (!btn) return;
    const previous = btn.textContent;
    btn.textContent = response && response.success ? '已使用' : '失败';
    setTimeout(() => { btn.textContent = previous; }, 1500);
  });
}

function togglePromptPinned(promptId) {
  const location = getPromptLocation(promptId);
  if (!location) return;
  applyPinnedState(location.prompt, !location.prompt.pinned);
  saveFolders().then(loadFolders);
}

function getPinnedTime(prompt) {
  const time = Date.parse(prompt && (prompt.pinnedAt || prompt.timestamp || ''));
  return Number.isFinite(time) ? time : 0;
}

function getPinnedPromptEntries() {
  const entries = [];
  folders.forEach((folder) => {
    (folder.prompts || []).forEach((prompt) => {
      if (prompt && prompt.pinned) entries.push({ folder, prompt });
    });
  });
  return entries.sort((a, b) => getPinnedTime(b.prompt) - getPinnedTime(a.prompt));
}

function getQuickTime(prompt) {
  const time = Date.parse(prompt && (prompt.quickAt || ''));
  return Number.isFinite(time) ? time : 0;
}

function getQuickPromptEntries() {
  const entries = [];
  folders.forEach((folder, folderIndex) => {
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

function openPinnedManager() {
  renderPinnedManager();
  document.getElementById('modalPinnedManager').classList.remove('hidden');
}

function closePinnedManager() {
  document.getElementById('modalPinnedManager').classList.add('hidden');
  clearDragIndicators('.pinned-manager-item');
  if (dragState && dragState.type === 'pinnedPrompt') dragState = null;
}

function openQuickManager() {
  const searchEl = document.getElementById('quickManagerSearch');
  if (searchEl) {
    quickManagerQuery = searchEl.value || '';
  }
  renderQuickManager();
  document.getElementById('modalQuickManager').classList.remove('hidden');
  setTimeout(() => {
    const input = document.getElementById('quickManagerSearch');
    if (input) input.focus();
  }, 0);
}

function closeQuickManager() {
  document.getElementById('modalQuickManager').classList.add('hidden');
  clearDragIndicators('.pinned-manager-item');
  if (dragState && dragState.type === 'quickPrompt') dragState = null;
}

function renderPinnedManager() {
  const listEl = document.getElementById('pinnedManagerList');
  if (!listEl) return;
  const entries = getPinnedPromptEntries();
  if (entries.length === 0) {
    listEl.innerHTML = '<div class="pinned-empty">还没有置顶提示词。可以在提示词卡片的更多菜单里置顶。</div>';
    return;
  }
  listEl.innerHTML = '';
  entries.forEach(({ folder, prompt }, index) => {
    const isFirst = index === 0;
    const isLast = index === entries.length - 1;
    const item = document.createElement('div');
    item.className = 'pinned-manager-item';
    item.dataset.id = prompt.id;
    item.draggable = true;
    item.style.setProperty('--item-index', Math.min(index, 8));
    item.innerHTML = `
      <span class="pinned-rank">${index + 1}</span>
      <span class="pinned-info">
        <span class="pinned-title">${escapeHtml(prompt.title || '未命名提示词')}</span>
        <span class="pinned-meta">${escapeHtml(folder.name || '未命名文件夹')}</span>
      </span>
      <span class="manager-actions">
        <button type="button" class="btn ghost sort-btn" data-action="move-pinned-up" data-id="${prompt.id}" title="上移" aria-label="上移"${isFirst ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn ghost sort-btn" data-action="move-pinned-down" data-id="${prompt.id}" title="下移" aria-label="下移"${isLast ? ' disabled' : ''}>↓</button>
        <button type="button" class="btn ghost" data-action="unpin-pinned" data-id="${prompt.id}">取消</button>
      </span>
    `;
    item.addEventListener('dragstart', (e) => onPinnedManagerDragStart(e, prompt.id));
    item.addEventListener('dragover', onItemDragOver);
    item.addEventListener('dragleave', onItemDragLeave);
    item.addEventListener('drop', (e) => onPinnedManagerDrop(e, prompt.id));
    item.addEventListener('dragend', onItemDragEnd);
    listEl.appendChild(item);
  });
}

function renderQuickManager() {
  const listEl = document.getElementById('quickManagerList');
  if (!listEl) return;
  const allEntries = getQuickPromptEntries();
  const tokens = getQuickManagerTokens();
  const entries = filterQuickManagerEntries(allEntries, tokens);
  const hasQuery = tokens.length > 0;
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="pinned-empty">${hasQuery ? '没有找到匹配的快捷提示词。' : '还没有可用于快捷输入的提示词。先添加一条有内容的提示词。'}</div>`;
    return;
  }
  listEl.innerHTML = '';
  entries.forEach(({ folder, prompt }, index) => {
    const isFirst = index === 0;
    const isLast = index === entries.length - 1;
    const item = document.createElement('div');
    item.className = 'pinned-manager-item';
    item.dataset.id = prompt.id;
    item.draggable = true;
    item.style.setProperty('--item-index', Math.min(index, 8));
    item.innerHTML = `
      <span class="pinned-rank">${index + 1}</span>
      <span class="pinned-info">
        <span class="pinned-title">${escapeHtml(prompt.title || '未命名提示词')}</span>
        <span class="pinned-meta">${escapeHtml(folder.name || '未命名文件夹')}</span>
      </span>
      <span class="manager-actions">
        <button type="button" class="btn ghost sort-btn" data-action="move-quick-up" data-id="${prompt.id}" title="上移" aria-label="上移"${isFirst ? ' disabled' : ''}>↑</button>
        <button type="button" class="btn ghost sort-btn" data-action="move-quick-down" data-id="${prompt.id}" title="下移" aria-label="下移"${isLast ? ' disabled' : ''}>↓</button>
        <button type="button" class="btn ghost" data-action="edit-quick" data-id="${prompt.id}">编辑</button>
      </span>
    `;
    item.addEventListener('dragstart', (e) => onQuickManagerDragStart(e, prompt.id));
    item.addEventListener('dragover', onItemDragOver);
    item.addEventListener('dragleave', onItemDragLeave);
    item.addEventListener('drop', (e) => onQuickManagerDrop(e, prompt.id));
    item.addEventListener('dragend', onItemDragEnd);
    listEl.appendChild(item);
  });
}

function getQuickManagerTokens() {
  return normalizeSearch(quickManagerQuery).split(/\s+/).filter(Boolean);
}

function filterQuickManagerEntries(entries, tokens) {
  if (!tokens || tokens.length === 0) return entries;
  return entries.filter(({ folder, prompt }) => {
    const haystack = normalizeSearch([
      prompt.title || '',
      prompt.text || '',
      folder.name || ''
    ].join(' '));
    return tokens.every(token => haystack.includes(token));
  });
}

function applyPinnedPromptOrder(entries) {
  const base = Date.now();
  entries.forEach(({ prompt }, index) => {
    prompt.pinned = true;
    prompt.pinnedAt = new Date(base - index * 1000).toISOString();
  });
}

function applyQuickPromptOrder(entries) {
  const base = Date.now();
  entries.forEach(({ prompt }, index) => {
    prompt.quickAt = new Date(base - index * 1000).toISOString();
  });
}

function onPinnedManagerDragStart(e, promptId) {
  dragState = { type: 'pinnedPrompt', id: promptId };
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onQuickManagerDragStart(e, promptId) {
  dragState = { type: 'quickPrompt', id: promptId };
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onPinnedManagerDrop(e, targetPromptId) {
  e.preventDefault();
  onItemDragLeave(e);
  if (!dragState || dragState.type !== 'pinnedPrompt') return;
  const entries = getPinnedPromptEntries();
  const sourceIndex = entries.findIndex(entry => entry.prompt.id === dragState.id);
  const targetIndex = entries.findIndex(entry => entry.prompt.id === targetPromptId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const destinationIndex = getDestinationIndex(e.currentTarget, sourceIndex, targetIndex, e.clientY);
  if (!moveArrayItem(entries, sourceIndex, destinationIndex)) return;
  applyPinnedPromptOrder(entries);
  saveFolders().then(() => {
    render();
    renderPinnedManager();
  });
}

function onQuickManagerDrop(e, targetPromptId) {
  e.preventDefault();
  onItemDragLeave(e);
  if (!dragState || dragState.type !== 'quickPrompt') return;
  const tokens = getQuickManagerTokens();
  const entries = filterQuickManagerEntries(getQuickPromptEntries(), tokens);
  const sourceIndex = entries.findIndex(entry => entry.prompt.id === dragState.id);
  const targetIndex = entries.findIndex(entry => entry.prompt.id === targetPromptId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const destinationIndex = getDestinationIndex(e.currentTarget, sourceIndex, targetIndex, e.clientY);
  if (!moveArrayItem(entries, sourceIndex, destinationIndex)) return;
  applyQuickPromptOrder(entries);
  saveFolders().then(() => {
    render();
    renderQuickManager();
  });
}

function movePinnedManagerItem(promptId, direction) {
  const entries = getPinnedPromptEntries();
  const sourceIndex = entries.findIndex(entry => entry.prompt.id === promptId);
  if (sourceIndex < 0) return;
  const targetIndex = sourceIndex + direction;
  if (!moveArrayItem(entries, sourceIndex, targetIndex)) return;
  applyPinnedPromptOrder(entries);
  saveFolders().then(() => {
    render();
    renderPinnedManager();
  });
}

function moveQuickManagerItem(promptId, direction) {
  const entries = filterQuickManagerEntries(getQuickPromptEntries(), getQuickManagerTokens());
  const sourceIndex = entries.findIndex(entry => entry.prompt.id === promptId);
  if (sourceIndex < 0) return;
  const targetIndex = sourceIndex + direction;
  if (!moveArrayItem(entries, sourceIndex, targetIndex)) return;
  applyQuickPromptOrder(entries);
  saveFolders().then(() => {
    render();
    renderQuickManager();
  });
}

function unpinFromPinnedManager(promptId) {
  const location = getPromptLocation(promptId);
  if (!location) return;
  applyPinnedState(location.prompt, false);
  saveFolders().then(() => {
    render();
    renderPinnedManager();
  });
}

function moveArrayItem(list, fromIndex, toIndex) {
  if (!Array.isArray(list)) return false;
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) return false;
  if (fromIndex === toIndex) return false;
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  return true;
}

function clearDragIndicators(selector) {
  document.querySelectorAll(selector).forEach((el) => {
    el.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
  });
}

function onFolderDragStart(e, folderId) {
  dragState = { type: 'folder', id: folderId };
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onPromptDragStart(e, promptId, folderId) {
  dragState = { type: 'prompt', id: promptId, sourceFolderId: folderId };
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onItemDragOver(e) {
  if (!dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const insertAfter = e.clientY > rect.top + rect.height / 2;
  el.classList.toggle('drag-over-top', !insertAfter);
  el.classList.toggle('drag-over-bottom', insertAfter);
}

function onItemDragLeave(e) {
  e.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
}

function onItemDragEnd() {
  dragState = null;
  clearDragIndicators('.folder-item');
  clearDragIndicators('.prompt-card');
  clearDragIndicators('.pinned-manager-item');
  clearDragIndicators('.selection-prompt-card');
}

function getDestinationIndex(currentTarget, sourceIndex, targetIndex, pointerY) {
  const rect = currentTarget.getBoundingClientRect();
  const insertAfter = pointerY > rect.top + rect.height / 2;
  let destinationIndex = targetIndex + (insertAfter ? 1 : 0);
  if (sourceIndex < destinationIndex) destinationIndex -= 1;
  return destinationIndex;
}

function onFolderDrop(e, targetFolderId) {
  e.preventDefault();
  onItemDragLeave(e);
  if (!dragState) return;

  if (dragState.type === 'prompt') {
    movePromptToFolder(dragState.id, dragState.sourceFolderId, targetFolderId);
    return;
  }

  if (dragState.type !== 'folder') return;
  const sourceIndex = folders.findIndex(f => f.id === dragState.id);
  const targetIndex = folders.findIndex(f => f.id === targetFolderId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const destinationIndex = getDestinationIndex(e.currentTarget, sourceIndex, targetIndex, e.clientY);
  if (!moveArrayItem(folders, sourceIndex, destinationIndex)) return;
  saveFolders().then(loadFolders);
}

function movePromptToFolder(promptId, sourceFolderId, targetFolderId) {
  if (sourceFolderId === targetFolderId) return;
  const sourceLocation = getPromptLocation(promptId, sourceFolderId);
  const targetFolder = folders.find(f => f.id === targetFolderId);
  if (!sourceLocation || !targetFolder) return;
  const [moved] = sourceLocation.folder.prompts.splice(sourceLocation.index, 1);
  targetFolder.prompts = targetFolder.prompts || [];
  targetFolder.prompts.push(moved);
  selectedFolderId = targetFolderId;
  saveFolders().then(loadFolders);
}

function onPromptDrop(e, targetPromptId, targetFolderId) {
  e.preventDefault();
  onItemDragLeave(e);
  if (!dragState || dragState.type !== 'prompt') return;
  if (dragState.sourceFolderId !== targetFolderId) return;
  const folder = folders.find(f => f.id === targetFolderId);
  if (!folder || !Array.isArray(folder.prompts)) return;
  const sourceIndex = folder.prompts.findIndex(p => p.id === dragState.id);
  const targetIndex = folder.prompts.findIndex(p => p.id === targetPromptId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const destinationIndex = getDestinationIndex(e.currentTarget, sourceIndex, targetIndex, e.clientY);
  if (!moveArrayItem(folder.prompts, sourceIndex, destinationIndex)) return;
  saveFolders().then(loadFolders);
}

function handlePromptActionClick(e) {
  const btn = e.target.closest('button[data-action][data-id]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const action = btn.dataset.action;
  const promptId = btn.dataset.id;
  if (!promptId) return;
  if (action === 'more') {
    togglePromptMoreMenu(btn);
    return;
  }
  closePromptMoreMenus();
  if (action === 'use') usePrompt(promptId);
  if (action === 'copy') copyPrompt(promptId);
  if (action === 'pin') togglePromptPinned(promptId);
  if (action === 'edit') editPrompt(promptId);
}

function closePromptMoreMenus(exceptWrap = null) {
  document.querySelectorAll('.more-wrap.open').forEach(el => {
    if (el === exceptWrap) return;
    el.classList.remove('open');
    const button = el.querySelector('button[data-action="more"]');
    if (button) button.setAttribute('aria-expanded', 'false');
  });
}

function togglePromptMoreMenu(button, forceOpen) {
  const wrap = button && button.closest('.more-wrap');
  if (!wrap) return;
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !wrap.classList.contains('open');
  closePromptMoreMenus(wrap);
  wrap.classList.toggle('open', shouldOpen);
  button.setAttribute('aria-expanded', String(shouldOpen));
}

function handlePinnedManagerClick(e) {
  const btn = e.target.closest('button[data-action][data-id]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if (btn.dataset.action === 'unpin-pinned') {
    unpinFromPinnedManager(btn.dataset.id);
  }
  if (btn.dataset.action === 'move-pinned-up') {
    movePinnedManagerItem(btn.dataset.id, -1);
  }
  if (btn.dataset.action === 'move-pinned-down') {
    movePinnedManagerItem(btn.dataset.id, 1);
  }
}

function handleQuickManagerClick(e) {
  const btn = e.target.closest('button[data-action][data-id]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if (btn.dataset.action === 'edit-quick') {
    closeQuickManager();
    editPrompt(btn.dataset.id);
  }
  if (btn.dataset.action === 'move-quick-up') {
    moveQuickManagerItem(btn.dataset.id, -1);
  }
  if (btn.dataset.action === 'move-quick-down') {
    moveQuickManagerItem(btn.dataset.id, 1);
  }
}

function renderAiTab() {
  const enabledEl = document.getElementById('aiSelectionEnabled');
  if (enabledEl) enabledEl.checked = !!aiOnSelectionEnabled;
  renderAiTargets();
  renderSelectionPrompts();
}

function renderAiTargets() {
  const listEl = document.getElementById('aiTargetsList');
  if (!listEl) return;
  listEl.innerHTML = '';
  listEl.classList.add('ai-card-list');
  if (aiTargets.length === 0) {
    listEl.innerHTML = '<div class="empty">还没有 AI 目标。点击“+ 目标”添加。</div>';
    return;
  }
  aiTargets.forEach((t, index) => {
    const card = document.createElement('div');
    card.className = 'list-item ai-target-card';
    card.dataset.id = t.id;
    card.style.setProperty('--item-index', Math.min(index, 8));
    const queryLabel = (t.queryParam === '' || t.queryParam == null) ? '—' : (t.queryParam || 'q=');
    const hostLabel = (() => {
      try {
        return new URL(t.baseUrl || '').hostname.replace(/^www\./, '') || '未设置网址';
      } catch (error) {
        return t.baseUrl || '未设置网址';
      }
    })();
    card.innerHTML = `
      <div class="ai-card-main">
        <div>
          <div class="title">${escapeHtml(t.name || 'AI')}</div>
          <div class="meta">${escapeHtml(hostLabel)}</div>
        </div>
        <button type="button" class="btn" data-action="edit-target" data-id="${t.id}">编辑</button>
      </div>
      <div class="ai-card-tags">
        <span>${t.usePasteFallback ? '粘贴模式' : 'URL 参数'}</span>
        <span>Query: ${escapeHtml(queryLabel)}</span>
      </div>
      <div class="meta ai-card-url">${escapeHtml(t.baseUrl || '')}</div>
    `;
    card.addEventListener('dblclick', () => openEditAiTargetModal(t.id));
    listEl.appendChild(card);
  });
}

function renderSelectionPrompts() {
  const listEl = document.getElementById('selectionPromptsList');
  if (!listEl) return;
  listEl.innerHTML = '';
  listEl.classList.add('ai-card-list');
  if (selectionPrompts.length === 0) {
    listEl.innerHTML = '<div class="empty">还没有选中文本指令。点击“+ 指令”添加。</div>';
    return;
  }
  selectionPrompts.forEach((p, index) => {
    const card = document.createElement('div');
    card.className = 'list-item selection-prompt-card';
    card.dataset.id = p.id;
    card.draggable = true;
    card.style.setProperty('--item-index', Math.min(index, 8));
    const preview = (p.template || '').slice(0, 120);
    card.innerHTML = `
      <div class="ai-card-main">
        <div>
          <div class="title">${escapeHtml(p.name || '未命名指令')}</div>
          <div class="meta">右键选中文字时使用</div>
        </div>
        <button type="button" class="btn" data-action="edit-selection" data-id="${p.id}">编辑</button>
      </div>
      <div class="meta ai-template-preview">${escapeHtml(preview)}${(p.template || '').length > 120 ? '…' : ''}</div>
    `;
    card.addEventListener('dblclick', () => openEditSelectionPromptModal(p.id));
    card.addEventListener('dragstart', (e) => onSelectionPromptDragStart(e, p.id));
    card.addEventListener('dragover', onItemDragOver);
    card.addEventListener('dragleave', onItemDragLeave);
    card.addEventListener('drop', (e) => onSelectionPromptDrop(e, p.id));
    card.addEventListener('dragend', onItemDragEnd);
    listEl.appendChild(card);
  });
}

function editPrompt(promptId) {
  const location = getPromptLocation(promptId);
  if (!location) return;
  document.getElementById('modalPromptTitle').textContent = '编辑提示词';
  document.getElementById('promptTitle').value = location.prompt.title || '';
  document.getElementById('promptText').value = location.prompt.text || '';
  document.getElementById('promptPinned').checked = !!location.prompt.pinned;
  document.getElementById('savePrompt').dataset.editId = promptId;
  document.getElementById('savePrompt').dataset.editFolderId = location.folder.id;
  document.getElementById('deletePrompt').classList.remove('hidden');
  document.getElementById('modalPrompt').classList.remove('hidden');
}

function openAddAiTargetModal() {
  document.getElementById('modalAiTargetTitle').textContent = '新建 AI 目标';
  document.getElementById('aiTargetName').value = '';
  document.getElementById('aiTargetBaseUrl').value = '';
  document.getElementById('aiTargetQueryParam').value = 'q=';
  document.getElementById('aiTargetUsePaste').checked = false;
  document.getElementById('saveAiTarget').dataset.editId = '';
  document.getElementById('deleteAiTarget').classList.add('hidden');
  document.getElementById('modalAiTarget').classList.remove('hidden');
}

function openEditAiTargetModal(targetId) {
  const target = aiTargets.find(t => t.id === targetId);
  if (!target) return;
  document.getElementById('modalAiTargetTitle').textContent = '编辑 AI 目标';
  document.getElementById('aiTargetName').value = target.name || '';
  document.getElementById('aiTargetBaseUrl').value = target.baseUrl || '';
  document.getElementById('aiTargetQueryParam').value = target.queryParam != null ? target.queryParam : 'q=';
  document.getElementById('aiTargetUsePaste').checked = !!target.usePasteFallback;
  document.getElementById('saveAiTarget').dataset.editId = target.id;
  document.getElementById('deleteAiTarget').classList.remove('hidden');
  document.getElementById('modalAiTarget').classList.remove('hidden');
}

function openAddSelectionPromptModal() {
  document.getElementById('modalSelectionPromptTitle').textContent = '新建选中文本指令';
  document.getElementById('selectionPromptName').value = '';
  document.getElementById('selectionPromptTemplate').value = '';
  document.getElementById('saveSelectionPrompt').dataset.editId = '';
  document.getElementById('deleteSelectionPrompt').classList.add('hidden');
  document.getElementById('modalSelectionPrompt').classList.remove('hidden');
}

function openEditSelectionPromptModal(promptId) {
  const prompt = selectionPrompts.find(p => p.id === promptId);
  if (!prompt) return;
  document.getElementById('modalSelectionPromptTitle').textContent = '编辑选中文本指令';
  document.getElementById('selectionPromptName').value = prompt.name || '';
  document.getElementById('selectionPromptTemplate').value = prompt.template || '';
  document.getElementById('saveSelectionPrompt').dataset.editId = prompt.id;
  document.getElementById('deleteSelectionPrompt').classList.remove('hidden');
  document.getElementById('modalSelectionPrompt').classList.remove('hidden');
}

function openAddFolderModal() {
  document.getElementById('modalFolderTitle').textContent = '新建文件夹';
  document.getElementById('folderName').value = '';
  document.getElementById('saveFolder').dataset.editFolderId = '';
  document.getElementById('deleteFolder').classList.add('hidden');
  document.getElementById('modalFolder').classList.remove('hidden');
}

function openEditFolderModal(folderId) {
  const folder = folders.find(f => f.id === folderId);
  if (!folder) return;
  document.getElementById('modalFolderTitle').textContent = '编辑文件夹';
  document.getElementById('folderName').value = folder.name || '';
  document.getElementById('saveFolder').dataset.editFolderId = folder.id;
  document.getElementById('deleteFolder').classList.remove('hidden');
  document.getElementById('modalFolder').classList.remove('hidden');
}

function openAddPromptModal() {
  if (!getSelectedFolder()) {
    alert('请先选择一个文件夹。');
    return;
  }
  document.getElementById('modalPromptTitle').textContent = '新建提示词';
  document.getElementById('promptTitle').value = '';
  document.getElementById('promptText').value = '';
  document.getElementById('promptPinned').checked = false;
  document.getElementById('savePrompt').dataset.editId = '';
  document.getElementById('savePrompt').dataset.editFolderId = '';
  document.getElementById('deletePrompt').classList.add('hidden');
  document.getElementById('modalPrompt').classList.remove('hidden');
}

function saveFolderFromModal() {
  const name = document.getElementById('folderName').value.trim() || '未命名文件夹';
  const editFolderId = document.getElementById('saveFolder').dataset.editFolderId;
  if (!name) return;
  if (editFolderId) {
    const folder = folders.find(f => f.id === editFolderId);
    if (!folder) return;
    folder.name = name;
  } else {
    folders.push({
      id: uuid(),
      name,
      prompts: []
    });
  }
  saveFolders().then(() => {
    document.getElementById('saveFolder').dataset.editFolderId = '';
    document.getElementById('deleteFolder').classList.add('hidden');
    document.getElementById('modalFolder').classList.add('hidden');
    loadFolders();
  });
}

function saveAiTargetFromModal() {
  const name = document.getElementById('aiTargetName').value.trim() || 'AI 目标';
  const baseUrl = document.getElementById('aiTargetBaseUrl').value.trim();
  const queryParam = document.getElementById('aiTargetQueryParam').value.trim();
  const usePasteFallback = document.getElementById('aiTargetUsePaste').checked;
  const editId = document.getElementById('saveAiTarget').dataset.editId;

  if (editId) {
    const target = aiTargets.find(t => t.id === editId);
    if (target) {
      target.name = name;
      target.baseUrl = baseUrl;
      target.queryParam = queryParam;
      target.usePasteFallback = usePasteFallback;
    }
  } else {
    aiTargets.push({
      id: uuid(),
      name,
      baseUrl,
      queryParam,
      usePasteFallback
    });
  }

  document.getElementById('saveAiTarget').dataset.editId = '';
  document.getElementById('deleteAiTarget').classList.add('hidden');
  document.getElementById('modalAiTarget').classList.add('hidden');
  saveAiConfig().then(loadAiConfig);
}

function savePromptFromModal() {
  const editId = document.getElementById('savePrompt').dataset.editId;
  const editFolderId = document.getElementById('savePrompt').dataset.editFolderId;
  const folder = editId && editFolderId ? folders.find(f => f.id === editFolderId) : getSelectedFolder();
  if (!folder) return;
  const title = document.getElementById('promptTitle').value.trim() || '未命名提示词';
  const text = document.getElementById('promptText').value.trim();
  const pinned = document.getElementById('promptPinned').checked;

  if (editId) {
    const p = (folder.prompts || []).find(x => x.id === editId);
    if (p) {
      p.title = title;
      p.text = text;
      applyPinnedState(p, pinned);
    }
  } else {
    const createdAt = nowIso();
    folder.prompts = folder.prompts || [];
    folder.prompts.push({
      id: uuid(),
      title,
      text,
      pinned,
      pinnedAt: pinned ? createdAt : '',
      quickAt: createdAt,
      timestamp: createdAt
    });
  }
  document.getElementById('savePrompt').dataset.editId = '';
  document.getElementById('savePrompt').dataset.editFolderId = '';
  document.getElementById('promptPinned').checked = false;
  document.getElementById('deletePrompt').classList.add('hidden');
  document.getElementById('modalPrompt').classList.add('hidden');
  saveFolders().then(loadFolders);
}

function saveSelectionPromptFromModal() {
  const name = document.getElementById('selectionPromptName').value.trim() || '选中文本指令';
  const template = document.getElementById('selectionPromptTemplate').value.trim();
  const editId = document.getElementById('saveSelectionPrompt').dataset.editId;

  if (editId) {
    const prompt = selectionPrompts.find(p => p.id === editId);
    if (prompt) {
      prompt.name = name;
      prompt.template = template;
    }
  } else {
    selectionPrompts.push({
      id: uuid(),
      name,
      template,
      timestamp: new Date().toISOString()
    });
  }

  document.getElementById('saveSelectionPrompt').dataset.editId = '';
  document.getElementById('deleteSelectionPrompt').classList.add('hidden');
  document.getElementById('modalSelectionPrompt').classList.add('hidden');
  saveAiConfig().then(loadAiConfig);
}

function deleteFolderFromModal() {
  const editFolderId = document.getElementById('saveFolder').dataset.editFolderId;
  if (!editFolderId) return;
  folders = folders.filter(f => f.id !== editFolderId);
  if (selectedFolderId === editFolderId) selectedFolderId = null;
  document.getElementById('saveFolder').dataset.editFolderId = '';
  document.getElementById('deleteFolder').classList.add('hidden');
  document.getElementById('modalFolder').classList.add('hidden');
  saveFolders().then(loadFolders);
}

function deleteAiTargetFromModal() {
  const editId = document.getElementById('saveAiTarget').dataset.editId;
  if (!editId) return;
  aiTargets = aiTargets.filter(t => t.id !== editId);
  document.getElementById('saveAiTarget').dataset.editId = '';
  document.getElementById('deleteAiTarget').classList.add('hidden');
  document.getElementById('modalAiTarget').classList.add('hidden');
  saveAiConfig().then(loadAiConfig);
}

function deletePromptFromModal() {
  const promptId = document.getElementById('savePrompt').dataset.editId;
  const editFolderId = document.getElementById('savePrompt').dataset.editFolderId;
  if (!promptId) return;
  const folder = editFolderId ? folders.find(f => f.id === editFolderId) : getSelectedFolder();
  if (!folder) return;
  folder.prompts = (folder.prompts || []).filter(p => p.id !== promptId);
  document.getElementById('savePrompt').dataset.editId = '';
  document.getElementById('savePrompt').dataset.editFolderId = '';
  document.getElementById('deletePrompt').classList.add('hidden');
  document.getElementById('modalPrompt').classList.add('hidden');
  saveFolders().then(loadFolders);
}

function deleteSelectionPromptFromModal() {
  const editId = document.getElementById('saveSelectionPrompt').dataset.editId;
  if (!editId) return;
  selectionPrompts = selectionPrompts.filter(p => p.id !== editId);
  document.getElementById('saveSelectionPrompt').dataset.editId = '';
  document.getElementById('deleteSelectionPrompt').classList.add('hidden');
  document.getElementById('modalSelectionPrompt').classList.add('hidden');
  saveAiConfig().then(loadAiConfig);
}

function downloadJson(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatBackupTime() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('-') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function exportToJson() {
  downloadJson(folders, 'PromptPocket-' + new Date().toISOString().slice(0, 10) + '.json');
}

function backupBeforeImport() {
  downloadJson(folders, 'PromptPocket-导入前备份-' + formatBackupTime() + '.json');
}

function backupBeforeCleanup() {
  downloadJson(folders, 'PromptPocket-清理前备份-' + formatBackupTime() + '.json');
}

function normalizeImportedFolders(data) {
  if (!Array.isArray(data)) {
    throw new Error('格式无效：需要文件夹数组 JSON。');
  }
  return data.map(f => ({
    id: f.id || uuid(),
    name: f.name || '导入的文件夹',
    prompts: Array.isArray(f.prompts) ? f.prompts.map(p => ({
      id: p.id || uuid(),
      title: p.title || '未命名提示词',
      text: p.text || '',
      sourceUrl: p.sourceUrl || '',
      sourceTitle: p.sourceTitle || '',
      pinned: !!p.pinned,
      pinnedAt: p.pinned ? (p.pinnedAt || p.timestamp || new Date().toISOString()) : '',
      quickAt: p.quickAt || '',
      timestamp: p.timestamp || new Date().toISOString()
    })) : []
  }));
}

function countPromptsInFolders(folderList) {
  return (folderList || []).reduce((sum, folder) => sum + ((folder.prompts || []).length), 0);
}

function normalizeCleanupText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function getCleanupReport() {
  const all = [];
  const empty = [];
  const groups = new Map();
  folders.forEach((folder, folderIndex) => {
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

function openCleanupTool() {
  renderCleanupTool();
  document.getElementById('modalCleanup').classList.remove('hidden');
}

function closeCleanupTool() {
  document.getElementById('modalCleanup').classList.add('hidden');
}

function renderCleanupTool() {
  const summaryEl = document.getElementById('cleanupSummary');
  const listEl = document.getElementById('cleanupList');
  const emptyBtn = document.getElementById('cleanupEmpty');
  const duplicateBtn = document.getElementById('cleanupDuplicates');
  if (!summaryEl || !listEl) return;
  const report = getCleanupReport();
  summaryEl.innerHTML = [
    `<div class="cleanup-stat"><strong>${report.all.length}</strong>全部提示词</div>`,
    `<div class="cleanup-stat"><strong>${report.empty.length}</strong>空内容</div>`,
    `<div class="cleanup-stat"><strong>${report.duplicateGroups.length}</strong>重复分组</div>`,
    `<div class="cleanup-stat"><strong>${report.duplicateExtras}</strong>可清理重复项</div>`
  ].join('');
  if (emptyBtn) emptyBtn.disabled = report.empty.length === 0;
  if (duplicateBtn) duplicateBtn.disabled = report.duplicateExtras === 0;

  if (report.empty.length === 0 && report.duplicateExtras === 0) {
    listEl.innerHTML = '<div class="pinned-empty">数据很干净，没有发现空内容或重复提示词。</div>';
    return;
  }

  const parts = [];
  if (report.empty.length > 0) {
    const sample = report.empty.slice(0, 4).map(({ folder, prompt }) => (
      `${escapeHtml(prompt.title || '未命名提示词')} · ${escapeHtml(folder.name || '未命名文件夹')}`
    )).join('<br>');
    parts.push(`
      <div class="cleanup-group">
        <div class="cleanup-group-title">空内容提示词</div>
        <div class="cleanup-group-meta">共 ${report.empty.length} 条。${sample ? '<br>' + sample : ''}</div>
      </div>
    `);
  }

  report.duplicateGroups.slice(0, 6).forEach((group, index) => {
    const keeper = group[0];
    const locations = group.slice(0, 4).map(({ folder, prompt }, itemIndex) => (
      `${itemIndex === 0 ? '保留' : '删除'}：${escapeHtml(prompt.title || '未命名提示词')} · ${escapeHtml(folder.name || '未命名文件夹')}`
    )).join('<br>');
    parts.push(`
      <div class="cleanup-group">
        <div class="cleanup-group-title">重复组 ${index + 1}：${escapeHtml(keeper.prompt.title || '未命名提示词')}</div>
        <div class="cleanup-group-meta">共 ${group.length} 条，清理后保留 1 条。<br>${locations}${group.length > 4 ? '<br>...' : ''}</div>
      </div>
    `);
  });
  if (report.duplicateGroups.length > 6) {
    parts.push(`<div class="cleanup-group"><div class="cleanup-group-meta">还有 ${report.duplicateGroups.length - 6} 个重复分组未展示，清理时会一并处理。</div></div>`);
  }
  listEl.innerHTML = parts.join('');
}

function cleanupEmptyPrompts() {
  const report = getCleanupReport();
  if (report.empty.length === 0) return;
  if (!confirm('确定删除 ' + report.empty.length + ' 条空内容提示词吗？清理前会自动下载备份。')) return;
  backupBeforeCleanup();
  const deletePrompts = new Set(report.empty.map(({ prompt }) => prompt));
  folders.forEach(folder => {
    folder.prompts = (folder.prompts || []).filter(prompt => !deletePrompts.has(prompt));
  });
  saveFolders().then(() => {
    render();
    renderCleanupTool();
    alert('已清理 ' + deletePrompts.size + ' 条空内容提示词，并已下载清理前备份。');
  });
}

function cleanupDuplicatePrompts() {
  const report = getCleanupReport();
  if (report.duplicateExtras === 0) return;
  if (!confirm('确定删除 ' + report.duplicateExtras + ' 条重复提示词吗？每组会保留第一条，清理前会自动下载备份。')) return;
  backupBeforeCleanup();
  const deletePrompts = new Set();
  report.duplicateGroups.forEach(group => {
    group.slice(1).forEach(({ prompt }) => deletePrompts.add(prompt));
  });
  folders.forEach(folder => {
    folder.prompts = (folder.prompts || []).filter(prompt => !deletePrompts.has(prompt));
  });
  saveFolders().then(() => {
    render();
    renderCleanupTool();
    alert('已清理 ' + deletePrompts.size + ' 条重复提示词，并已下载清理前备份。');
  });
}

function readJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        resolve(JSON.parse(e.target.result));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('无法读取文件'));
    reader.readAsText(file);
  });
}

function mergeImportedFolders(currentFolders, importedFolders) {
  const next = currentFolders.map(folder => ({
    ...folder,
    prompts: Array.isArray(folder.prompts) ? folder.prompts.map(prompt => ({ ...prompt })) : []
  }));
  const usedFolderIds = new Set(next.map(folder => folder.id).filter(Boolean));
  const usedPromptIds = new Set(next.flatMap(folder => (folder.prompts || []).map(prompt => prompt.id).filter(Boolean)));
  let addedFolders = 0;
  let addedPrompts = 0;
  let skippedPrompts = 0;

  importedFolders.forEach((importedFolder) => {
    let target = next.find(folder => folder.id && importedFolder.id && folder.id === importedFolder.id);
    if (!target) {
      target = next.find(folder => normalizeSearch(folder.name) === normalizeSearch(importedFolder.name));
    }
    if (!target) {
      const folderId = usedFolderIds.has(importedFolder.id) ? uuid() : importedFolder.id;
      usedFolderIds.add(folderId);
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
      const sameId = (target.prompts || []).some(item => item.id && prompt.id && item.id === prompt.id);
      if (sameId || existingPromptKeys.has(promptKey)) {
        skippedPrompts += 1;
        return;
      }
      const promptId = usedPromptIds.has(prompt.id) ? uuid() : prompt.id;
      usedPromptIds.add(promptId);
      existingPromptKeys.add(promptKey);
      target.prompts = target.prompts || [];
      target.prompts.push({ ...prompt, id: promptId });
      addedPrompts += 1;
    });
  });

  return { folders: next, addedFolders, addedPrompts, skippedPrompts };
}

function formatImportFileSize(file) {
  if (!file || !Number.isFinite(file.size)) return '';
  if (file.size < 1024) return file.size + ' B';
  if (file.size < 1024 * 1024) return Math.round(file.size / 1024) + ' KB';
  return (file.size / 1024 / 1024).toFixed(1) + ' MB';
}

function updateImportDropState(file = null) {
  const dropZone = document.getElementById('importDropZone');
  const fileName = document.getElementById('importFileName');
  if (dropZone) {
    dropZone.classList.toggle('has-file', !!file);
    dropZone.classList.remove('drag-over');
  }
  if (fileName) {
    fileName.textContent = file ? `${file.name} · ${formatImportFileSize(file)}` : '也可以点击选择文件';
  }
}

function chooseImportFile(file) {
  if (!file) return;
  pendingImportFile = file;
  pendingImportedFolders = null;
  pendingImportError = '';
  updateImportDropState(file);
  renderImportPreview({ loading: true });
  setImportBusy(false);
  prepareImportPreview(file);
}

function openImportModal(file = null) {
  pendingImportFile = null;
  pendingImportedFolders = null;
  pendingImportError = '';
  const mergeOption = document.querySelector('input[name="importMode"][value="merge"]');
  if (mergeOption) mergeOption.checked = true;
  updateImportDropState();
  renderImportPreview();
  setImportBusy(false);
  document.getElementById('modalImport').classList.remove('hidden');
  if (file) chooseImportFile(file);
}

function closeImportModal() {
  pendingImportFile = null;
  pendingImportedFolders = null;
  pendingImportError = '';
  pendingImportToken += 1;
  document.getElementById('modalImport').classList.add('hidden');
  document.getElementById('importFile').value = '';
  updateImportDropState();
  renderImportPreview();
  setImportBusy(false);
}

function setImportBusy(isBusy) {
  const button = document.getElementById('confirmImport');
  if (!button) return;
  button.disabled = !!isBusy || !pendingImportedFolders;
  button.textContent = isBusy ? '导入中...' : '确认导入';
}

function confirmImportFromModal() {
  if (!pendingImportedFolders) return;
  const modeEl = document.querySelector('input[name="importMode"]:checked');
  setImportBusy(true);
  importNormalizedFolders(pendingImportedFolders, modeEl && modeEl.value === 'replace' ? 'replace' : 'merge');
}

async function prepareImportPreview(file) {
  if (!file) return;
  const token = ++pendingImportToken;
  try {
    const data = await readJsonFile(file);
    const imported = normalizeImportedFolders(data);
    if (token !== pendingImportToken) return;
    pendingImportedFolders = imported;
    pendingImportError = '';
    renderImportPreview();
    setImportBusy(false);
  } catch (err) {
    if (token !== pendingImportToken) return;
    pendingImportedFolders = null;
    pendingImportError = err.message || String(err);
    renderImportPreview();
    setImportBusy(false);
  }
}

function renderImportPreview(state = {}) {
  const previewEl = document.getElementById('importPreview');
  if (!previewEl) return;
  if (state.loading) {
    previewEl.innerHTML = '<div class="import-preview-card"><div class="import-preview-title">正在读取导入文件...</div><div class="import-preview-message">解析完成后会显示导入影响预览。</div></div>';
    return;
  }
  const error = state.error || pendingImportError;
  if (error) {
    previewEl.innerHTML = `<div class="import-preview-card import-preview-error"><div class="import-preview-title">导入文件无法解析</div><div class="import-preview-message">${escapeHtml(error)}</div></div>`;
    return;
  }
  if (!pendingImportedFolders) {
    previewEl.innerHTML = '';
    return;
  }

  const mode = getSelectedImportMode();
  const currentFolders = folders.length;
  const currentPrompts = countPromptsInFolders(folders);
  const importedFolders = pendingImportedFolders.length;
  const importedPrompts = countPromptsInFolders(pendingImportedFolders);
  const mergeStats = mergeImportedFolders(folders, pendingImportedFolders);
  const modeTitle = mode === 'replace' ? '覆盖导入预览' : '合并导入预览';
  const modeMessage = mode === 'replace'
    ? `当前 ${currentFolders} 个文件夹、${currentPrompts} 条提示词会被导入文件替换。`
    : `预计新增 ${mergeStats.addedFolders} 个文件夹、${mergeStats.addedPrompts} 条提示词，跳过 ${mergeStats.skippedPrompts} 条重复提示词。`;

  previewEl.innerHTML = `
    <div class="import-preview-card">
      <div class="import-preview-title">${modeTitle}</div>
      <div class="import-preview-grid">
        <div class="import-stat"><strong>${currentFolders}</strong>当前文件夹</div>
        <div class="import-stat"><strong>${currentPrompts}</strong>当前提示词</div>
        <div class="import-stat"><strong>${importedFolders}</strong>导入文件夹</div>
        <div class="import-stat"><strong>${importedPrompts}</strong>导入提示词</div>
      </div>
      <div class="import-preview-message">${escapeHtml(modeMessage)}</div>
    </div>
  `;
}

function getSelectedImportMode() {
  const modeEl = document.querySelector('input[name="importMode"]:checked');
  return modeEl && modeEl.value === 'replace' ? 'replace' : 'merge';
}

async function importNormalizedFolders(imported, mode = 'merge') {
  try {
    backupBeforeImport();
    let message = '';
    if (mode === 'replace') {
      folders = imported;
      message = '覆盖导入完成，共载入 ' + imported.length + ' 个文件夹、' + countPromptsInFolders(imported) + ' 条提示词。';
    } else {
      const result = mergeImportedFolders(folders, imported);
      folders = result.folders;
      message = '合并导入完成：新增 ' + result.addedFolders + ' 个文件夹、' + result.addedPrompts + ' 条提示词。';
      if (result.skippedPrompts > 0) message += ' 已跳过 ' + result.skippedPrompts + ' 条重复提示词。';
    }
    await saveFolders();
    closeImportModal();
    loadFolders();
    alert(message + '\n已自动下载导入前备份。');
  } catch (err) {
    alert('导入失败：' + (err.message || err));
  } finally {
    setImportBusy(false);
  }
}

function onSelectionPromptDragStart(e, promptId) {
  dragState = { type: 'selectionPrompt', id: promptId };
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('dragging');
}

function onSelectionPromptDrop(e, targetPromptId) {
  e.preventDefault();
  onItemDragLeave(e);
  if (!dragState || dragState.type !== 'selectionPrompt') return;
  const sourceIndex = selectionPrompts.findIndex(p => p.id === dragState.id);
  const targetIndex = selectionPrompts.findIndex(p => p.id === targetPromptId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const destinationIndex = getDestinationIndex(e.currentTarget, sourceIndex, targetIndex, e.clientY);
  if (!moveArrayItem(selectionPrompts, sourceIndex, destinationIndex)) return;
  saveAiConfig().then(loadAiConfig);
}

function handleAiListActionClick(e) {
  const btn = e.target.closest('button[data-action][data-id]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (!id) return;
  if (action === 'edit-target') openEditAiTargetModal(id);
  if (action === 'edit-selection') openEditSelectionPromptModal(id);
}

function setActiveTab(tab) {
  const promptsTab = document.getElementById('tabPrompts');
  const aiTab = document.getElementById('tabAi');
  const mainTabs = document.getElementById('mainTabs');
  const btnPrompts = document.getElementById('tabPromptsBtn');
  const btnAi = document.getElementById('tabAiBtn');
  const showPrompts = tab === 'prompts';
  promptsTab.classList.toggle('hidden', !showPrompts);
  aiTab.classList.toggle('hidden', showPrompts);
  if (mainTabs) mainTabs.classList.toggle('ai-active', !showPrompts);
  btnPrompts.classList.toggle('active', showPrompts);
  btnAi.classList.toggle('active', !showPrompts);
}

function loadDefaults() {
  aiOnSelectionEnabled = true;
  aiTargets = [
    { id: uuid(), name: 'Grok', baseUrl: 'https://grok.com/', queryParam: 'q=', usePasteFallback: false },
    { id: uuid(), name: 'ChatGPT', baseUrl: 'https://chatgpt.com/', queryParam: 'q=', usePasteFallback: false },
    { id: uuid(), name: 'Claude', baseUrl: 'https://claude.ai/new', queryParam: 'q=', usePasteFallback: false },
    { id: uuid(), name: 'Gemini', baseUrl: 'https://gemini.google.com/app', queryParam: '', usePasteFallback: true },
    { id: uuid(), name: 'Perplexity', baseUrl: 'https://www.perplexity.ai/', queryParam: 'q=', usePasteFallback: false }
  ];
  selectionPrompts = [
    { id: uuid(), name: '翻译为中文', template: '请将以下内容翻译为中文，保留原文的语气和重点：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '翻译为英文', template: '请将以下内容翻译为英文，保留原文的语气和重点：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '总结要点', template: '请用 5 条以内的要点总结以下内容：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '提取行动项', template: '请从以下内容中提取关键结论和行动项：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '改写得更清楚', template: '请在不改变原意的前提下，把以下内容改写得更清楚：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '压缩成一段', template: '请把以下内容压缩成一段简洁文字：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '优缺点分析', template: '请分析以下内容的优点和缺点：\n\n{{text}}', timestamp: new Date().toISOString() },
    { id: uuid(), name: '生成追问', template: '请基于以下内容生成 5 个值得继续追问的问题：\n\n{{text}}', timestamp: new Date().toISOString() }
  ];
  saveAiConfig().then(loadAiConfig);
}

function exportAiConfig() {
  const data = JSON.stringify({
    aiOnSelectionEnabled,
    aiTargets,
    selectionPrompts
  }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '选中文本处理-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importAiConfig(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const raw = e.target.result;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') {
        alert('格式无效：需要一个 JSON 对象。');
        return;
      }
      const nextEnabled = data.aiOnSelectionEnabled !== false;
      const nextTargets = Array.isArray(data.aiTargets) ? data.aiTargets.map(t => ({
        id: t.id || uuid(),
        name: t.name || 'AI',
        baseUrl: t.baseUrl || '',
        queryParam: t.queryParam != null ? t.queryParam : 'q=',
        usePasteFallback: !!t.usePasteFallback
      })) : [];
      const nextPrompts = Array.isArray(data.selectionPrompts) ? data.selectionPrompts.map(p => ({
        id: p.id || uuid(),
        name: p.name || '选中文本指令',
        template: p.template || '',
        timestamp: p.timestamp || new Date().toISOString()
      })) : [];
      aiOnSelectionEnabled = nextEnabled;
      aiTargets = nextTargets;
      selectionPrompts = nextPrompts;
      await saveAiConfig();
      loadAiConfig();
      document.getElementById('aiImportFile').value = '';
      alert('导入完成，共载入 ' + nextTargets.length + ' 个 AI 目标、' + nextPrompts.length + ' 个选中文本指令。');
    } catch (err) {
      alert('JSON 或格式无效：' + (err.message || err));
    }
  };
  reader.readAsText(file);
}

document.getElementById('addFolder').addEventListener('click', openAddFolderModal);
document.getElementById('addPrompt').addEventListener('click', openAddPromptModal);
document.getElementById('cancelFolder').addEventListener('click', () => {
  document.getElementById('deleteFolder').classList.add('hidden');
  document.getElementById('modalFolder').classList.add('hidden');
});
document.getElementById('saveFolder').addEventListener('click', saveFolderFromModal);
document.getElementById('deleteFolder').addEventListener('click', deleteFolderFromModal);
document.getElementById('cancelPrompt').addEventListener('click', () => {
  document.getElementById('savePrompt').dataset.editId = '';
  document.getElementById('savePrompt').dataset.editFolderId = '';
  document.getElementById('deletePrompt').classList.add('hidden');
  document.getElementById('modalPrompt').classList.add('hidden');
});
document.getElementById('savePrompt').addEventListener('click', savePromptFromModal);
document.getElementById('deletePrompt').addEventListener('click', deletePromptFromModal);

document.getElementById('addAiTarget').addEventListener('click', openAddAiTargetModal);
document.getElementById('addSelectionPrompt').addEventListener('click', openAddSelectionPromptModal);
document.getElementById('cancelAiTarget').addEventListener('click', () => {
  document.getElementById('deleteAiTarget').classList.add('hidden');
  document.getElementById('modalAiTarget').classList.add('hidden');
});
document.getElementById('saveAiTarget').addEventListener('click', saveAiTargetFromModal);
document.getElementById('deleteAiTarget').addEventListener('click', deleteAiTargetFromModal);
document.getElementById('cancelSelectionPrompt').addEventListener('click', () => {
  document.getElementById('deleteSelectionPrompt').classList.add('hidden');
  document.getElementById('modalSelectionPrompt').classList.add('hidden');
});
document.getElementById('saveSelectionPrompt').addEventListener('click', saveSelectionPromptFromModal);
document.getElementById('deleteSelectionPrompt').addEventListener('click', deleteSelectionPromptFromModal);

document.getElementById('exportBtn').addEventListener('click', exportToJson);
document.getElementById('importBtn').addEventListener('click', () => openImportModal());
document.getElementById('managePinned').addEventListener('click', openPinnedManager);
document.getElementById('manageQuick').addEventListener('click', openQuickManager);
document.getElementById('cleanupData').addEventListener('click', openCleanupTool);
document.getElementById('chooseImportFile').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('importFile').click();
});
document.getElementById('importDropZone').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importDropZone').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  document.getElementById('importFile').click();
});
document.getElementById('importDropZone').addEventListener('dragenter', (e) => {
  e.preventDefault();
  e.currentTarget.classList.add('drag-over');
});
document.getElementById('importDropZone').addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  e.currentTarget.classList.add('drag-over');
});
document.getElementById('importDropZone').addEventListener('dragleave', (e) => {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drag-over');
  }
});
document.getElementById('importDropZone').addEventListener('drop', (e) => {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) chooseImportFile(file);
});
document.getElementById('cancelImport').addEventListener('click', closeImportModal);
document.getElementById('confirmImport').addEventListener('click', confirmImportFromModal);
document.querySelectorAll('input[name="importMode"]').forEach(input => {
  input.addEventListener('change', () => renderImportPreview());
});
document.getElementById('closePinnedManager').addEventListener('click', closePinnedManager);
document.getElementById('pinnedManagerList').addEventListener('click', handlePinnedManagerClick);
document.getElementById('closeQuickManager').addEventListener('click', closeQuickManager);
document.getElementById('quickManagerList').addEventListener('click', handleQuickManagerClick);
document.getElementById('quickManagerSearch').addEventListener('input', (e) => {
  quickManagerQuery = e.target.value || '';
  renderQuickManager();
});
document.getElementById('closeCleanup').addEventListener('click', closeCleanupTool);
document.getElementById('rescanCleanup').addEventListener('click', renderCleanupTool);
document.getElementById('cleanupEmpty').addEventListener('click', cleanupEmptyPrompts);
document.getElementById('cleanupDuplicates').addEventListener('click', cleanupDuplicatePrompts);
document.getElementById('promptsList').addEventListener('click', handlePromptActionClick);
document.getElementById('promptsList').addEventListener('keydown', (e) => {
  const moreButton = e.target.closest('button[data-action="more"]');
  if (moreButton && openMenuFromTrigger(e, () => togglePromptMoreMenu(moreButton, true), moreButton.closest('.more-wrap').querySelector('.card-more-menu'))) return;
  const menu = e.target.closest('.card-more-menu');
  if (!menu) return;
  const wrap = menu.closest('.more-wrap');
  const trigger = wrap && wrap.querySelector('button[data-action="more"]');
  handleMenuKeyboard(e, menu, () => closePromptMoreMenus(), trigger);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.more-wrap')) {
    closePromptMoreMenus();
  }
});
document.getElementById('promptSearch').addEventListener('input', (e) => {
  promptSearchQuery = e.target.value;
  renderPrompts();
});
document.getElementById('promptFolderFilterButton').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  togglePromptFolderFilter();
});
document.getElementById('promptFolderFilterButton').addEventListener('keydown', (e) => {
  const menu = document.getElementById('promptFolderFilterMenu');
  openMenuFromTrigger(e, openPromptFolderFilter, menu);
});
document.getElementById('promptFolderFilterMenu').addEventListener('click', (e) => {
  const option = e.target.closest('[data-folder-id]');
  if (!option) return;
  promptFolderFilterId = option.dataset.folderId || 'all';
  syncSelectedFolderFromFilter();
  closePromptFolderFilter();
  render();
});
document.getElementById('promptFolderFilterMenu').addEventListener('keydown', (e) => {
  handleMenuKeyboard(e, e.currentTarget, closePromptFolderFilter, document.getElementById('promptFolderFilterButton'));
});
document.addEventListener('click', (e) => {
  const root = document.getElementById('promptFolderFilter');
  if (root && !root.contains(e.target)) closePromptFolderFilter();
});
document.getElementById('promptPinnedOnly').addEventListener('change', (e) => {
  promptPinnedOnly = !!e.target.checked;
  renderPrompts();
});
document.getElementById('clearSearchFilters').addEventListener('click', clearPromptFilters);
document.getElementById('quickScopeModeButton').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleQuickScopeMenu('mode');
});
document.getElementById('quickScopeModeButton').addEventListener('keydown', (e) => {
  openMenuFromTrigger(e, () => openQuickScopeMenu('mode'), document.getElementById('quickScopeModeMenu'));
});
document.getElementById('quickScopeModeMenu').addEventListener('click', (e) => {
  const option = e.target.closest('[data-quick-scope-mode]');
  if (!option) return;
  quickPromptScopeMode = QUICK_SCOPE_MODES.has(option.dataset.quickScopeMode) ? option.dataset.quickScopeMode : 'all';
  if (quickPromptScopeMode === 'folder' && !quickPromptScopeFolderId) {
    quickPromptScopeFolderId = selectedFolderId || (folders[0] && folders[0].id) || '';
  }
  closeQuickScopeMenus();
  renderQuickScopeSettings();
  saveQuickScopeSettings().catch(() => {});
});
document.getElementById('quickScopeModeMenu').addEventListener('keydown', (e) => {
  handleMenuKeyboard(e, e.currentTarget, closeQuickScopeMenus, document.getElementById('quickScopeModeButton'));
});
document.getElementById('quickScopeFolderButton').addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  toggleQuickScopeMenu('folder');
});
document.getElementById('quickScopeFolderButton').addEventListener('keydown', (e) => {
  openMenuFromTrigger(e, () => openQuickScopeMenu('folder'), document.getElementById('quickScopeFolderMenu'));
});
document.getElementById('quickScopeFolderMenu').addEventListener('click', (e) => {
  const option = e.target.closest('[data-quick-scope-folder]');
  if (!option) return;
  quickPromptScopeFolderId = option.dataset.quickScopeFolder || '';
  closeQuickScopeMenus();
  renderQuickScopeSettings();
  saveQuickScopeSettings().catch(() => {});
});
document.getElementById('quickScopeFolderMenu').addEventListener('keydown', (e) => {
  handleMenuKeyboard(e, e.currentTarget, closeQuickScopeMenus, document.getElementById('quickScopeFolderButton'));
});
document.addEventListener('click', (e) => {
  const root = document.querySelector('.quick-scope-settings');
  if (root && !root.contains(e.target)) closeQuickScopeMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  e.preventDefault();
  closePromptFolderFilter();
  closeQuickScopeMenus();
  closePromptMoreMenus();
  closeSidePanelFromShortcut();
});
document.getElementById('aiTargetsList').addEventListener('click', handleAiListActionClick);
document.getElementById('selectionPromptsList').addEventListener('click', handleAiListActionClick);
document.getElementById('importFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const importModal = document.getElementById('modalImport');
  if (importModal && importModal.classList.contains('hidden')) openImportModal(f);
  else chooseImportFile(f);
});

document.getElementById('autoPaste').addEventListener('change', (e) => {
  const on = e.target.checked;
  chrome.runtime.sendMessage({ action: on ? 'enableAutoPaste' : 'disableAutoPaste' }, (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      e.target.checked = !on;
      alert('保存粘贴设置失败：\n' + (chrome.runtime.lastError && chrome.runtime.lastError.message || response && response.error || '未知错误'));
    }
  });
});

document.getElementById('aiSelectionEnabled').addEventListener('change', (e) => {
  aiOnSelectionEnabled = e.target.checked;
  saveAiConfig().then(loadAiConfig);
});

document.getElementById('loadDefaults').addEventListener('click', loadDefaults);

document.getElementById('aiExportBtn').addEventListener('click', exportAiConfig);
document.getElementById('aiImportBtn').addEventListener('click', () => document.getElementById('aiImportFile').click());
document.getElementById('aiImportFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importAiConfig(f);
});

document.getElementById('tabPromptsBtn').addEventListener('click', () => setActiveTab('prompts'));
document.getElementById('tabAiBtn').addEventListener('click', () => setActiveTab('ai'));
document.getElementById('themeToggle').addEventListener('click', () => {
  toggleTheme().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.folders) {
    loadFolders();
  }
  if (area === 'local' && (changes.quickPromptScopeMode || changes.quickPromptScopeFolderId)) {
    loadQuickScopeSettings().then(renderQuickScopeSettings);
  }
});

(async () => {
  renderVersion();
  await loadTheme();
  await loadQuickScopeSettings();
  const autoPaste = await loadAutoPasteState();
  document.getElementById('autoPaste').checked = !!autoPaste;
  loadFolders();
  loadAiConfig();
})();
