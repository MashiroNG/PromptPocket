/* PromptPocket side panel shared runtime helpers. */

async function saveFolders() {
  try {
    await chrome.storage.local.set({ folders });
    chrome.runtime.sendMessage({ action: 'rebuildMenu' }).catch(() => {});
  } catch (error) {
    notifyStorageError('保存提示词失败', error);
    throw error;
  }
}

async function loadQuickScopeSettings() {
  const saved = await chrome.storage.local.get({
    quickPromptScopeMode: 'all',
    quickPromptScopeFolderId: ''
  });
  quickPromptScopeMode = QUICK_SCOPE_MODES.has(saved.quickPromptScopeMode) ? saved.quickPromptScopeMode : 'all';
  quickPromptScopeFolderId = typeof saved.quickPromptScopeFolderId === 'string' ? saved.quickPromptScopeFolderId : '';
}

async function saveQuickScopeSettings() {
  try {
    await chrome.storage.local.set({
      quickPromptScopeMode,
      quickPromptScopeFolderId
    });
  } catch (error) {
    notifyStorageError('保存快捷范围失败', error);
    throw error;
  }
}

async function saveAiConfig() {
  try {
    await chrome.storage.local.set({
      aiOnSelectionEnabled,
      aiTargets,
      selectionPrompts
    });
    chrome.runtime.sendMessage({ action: 'rebuildMenu' }).catch(() => {});
  } catch (error) {
    notifyStorageError('保存选中文本处理配置失败', error);
    throw error;
  }
}

function formatStorageError(error) {
  const message = error && (error.message || String(error)) || '未知错误';
  const quotaHint = /quota|exceed|storage/i.test(message)
    ? '\n\n可能是本地存储空间不足。建议先导出备份，再使用“清理数据”删除空内容或重复提示词。'
    : '';
  return message + quotaHint;
}

function notifyStorageError(title, error) {
  alert(title + '：\n' + formatStorageError(error));
}

function applyTheme(theme) {
  sidepanelTheme = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('theme-light', sidepanelTheme === 'light');
  const button = document.getElementById('themeToggle');
  if (button) {
    const nextLabel = sidepanelTheme === 'light' ? '切换为黑色主题' : '切换为白色主题';
    button.setAttribute('aria-label', nextLabel);
    button.title = nextLabel;
  }
}

async function loadTheme() {
  const { sidepanelTheme: savedTheme } = await chrome.storage.local.get({ sidepanelTheme: 'dark' });
  applyTheme(savedTheme);
}

async function toggleTheme() {
  const nextTheme = sidepanelTheme === 'light' ? 'dark' : 'light';
  applyTheme(nextTheme);
  await chrome.storage.local.set({ sidepanelTheme: nextTheme });
}

async function loadAutoPasteState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'getAutoPaste' }, (r) => {
      resolve(r && r.autoPaste);
    });
  });
}

function renderVersion() {
  const versionEl = document.getElementById('appVersion');
  if (!versionEl) return;
  const manifest = chrome.runtime.getManifest();
  const version = manifest.version_name || manifest.version || 'unknown';
  versionEl.textContent = '(' + version + ')';
}
