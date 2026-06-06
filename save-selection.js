let currentDraft = null;
let folders = [];
const DEFAULT_FOLDER_NAME = '收件箱';

function sendFolderMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || '请求失败'));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response && response.error || '请求失败'));
        return;
      }
      resolve(response);
    });
  });
}

function applyTheme(theme) {
  document.body.classList.toggle('theme-light', theme === 'light');
}

async function loadTheme() {
  const { sidepanelTheme } = await chrome.storage.local.get({ sidepanelTheme: 'dark' });
  applyTheme(sidepanelTheme);
}

function showError(message) {
  const el = document.getElementById('errorText');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

function formatStorageError(error) {
  const message = error && (error.message || String(error)) || '未知错误';
  const quotaHint = /quota|exceed|storage/i.test(message)
    ? ' 可能是本地存储空间不足，请先导出备份并清理重复或空内容。'
    : '';
  return message + quotaHint;
}

async function loadDraft() {
  const [data, folderState] = await Promise.all([
    chrome.storage.local.get({ pendingPromptSave: null }),
    sendFolderMessage({ action: 'getFolders' })
  ]);
  const { pendingPromptSave } = data;
  folders = Array.isArray(folderState.folders) ? folderState.folders : [];
  currentDraft = pendingPromptSave || {};
  renderFolderOptions();
  document.getElementById('promptTitle').value = currentDraft.title || '';
  document.getElementById('promptText').value = currentDraft.text || '';
  document.getElementById('promptPinned').checked = !!currentDraft.pinned;
  document.getElementById('promptTitle').focus();
}

function renderFolderOptions() {
  const select = document.getElementById('folderSelect');
  select.innerHTML = '';

  const safeFolders = folders.length > 0
    ? folders
    : [{ id: '', name: DEFAULT_FOLDER_NAME, prompts: [] }];

  for (const folder of safeFolders) {
    const option = document.createElement('option');
    option.value = folder.id || '';
    option.textContent = folder.name || '未命名文件夹';
    select.appendChild(option);
  }

  const inbox = safeFolders.find(folder => folder.name === DEFAULT_FOLDER_NAME) || safeFolders[0];
  select.value = currentDraft.folderId || (inbox && inbox.id) || '';
}

function openNewFolderRow() {
  showError('');
  document.getElementById('newFolderRow').classList.add('open');
  document.getElementById('newFolderName').value = '';
  document.getElementById('newFolderName').focus();
}

function closeNewFolderRow() {
  document.getElementById('newFolderRow').classList.remove('open');
  document.getElementById('newFolderName').value = '';
}

async function addFolder() {
  const name = document.getElementById('newFolderName').value.trim();
  if (!name) {
    showError('请输入文件夹名称。');
    return;
  }

  try {
    const response = await sendFolderMessage({ action: 'addFolder', name });
    folders = Array.isArray(response.folders) ? response.folders : folders;
    currentDraft.folderId = response.folder && response.folder.id || '';
  } catch (error) {
    showError('新建文件夹失败：' + formatStorageError(error));
    return;
  }
  renderFolderOptions();
  closeNewFolderRow();
  showError('');
}

async function saveDraft() {
  const title = document.getElementById('promptTitle').value.trim();
  const text = document.getElementById('promptText').value.trim();
  const pinned = document.getElementById('promptPinned').checked;
  const folderId = document.getElementById('folderSelect').value;

  if (!text) {
    showError('提示词内容不能为空。');
    return;
  }

  const draft = {
    ...currentDraft,
    title,
    text,
    pinned,
    folderId
  };

  chrome.runtime.sendMessage({ action: 'savePromptDraft', draft }, (response) => {
    if (chrome.runtime.lastError) {
      showError(chrome.runtime.lastError.message || '保存失败。');
      return;
    }
    if (!response || !response.success) {
      showError(response && response.error || '保存失败。');
      return;
    }
    window.close();
  });
}

document.getElementById('saveBtn').addEventListener('click', saveDraft);
document.getElementById('cancelBtn').addEventListener('click', () => window.close());
document.getElementById('newFolderBtn').addEventListener('click', openNewFolderRow);
document.getElementById('confirmFolderBtn').addEventListener('click', () => {
  addFolder().catch((error) => showError(error.message || '新建文件夹失败。'));
});
document.getElementById('cancelFolderBtn').addEventListener('click', closeNewFolderRow);
document.getElementById('newFolderName').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addFolder().catch((error) => showError(error.message || '新建文件夹失败。'));
  }
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') saveDraft();
  if (event.key === 'Escape') window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sidepanelTheme) {
    applyTheme(changes.sidepanelTheme.newValue);
  }
});

loadTheme().catch(() => {});
loadDraft().catch((error) => showError(error.message || '读取选中内容失败。'));
