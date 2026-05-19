let currentDraft = null;
let folders = [];
const DEFAULT_FOLDER_NAME = '收件箱';

function showError(message) {
  const el = document.getElementById('errorText');
  el.textContent = message;
  el.style.display = message ? 'block' : 'none';
}

async function loadDraft() {
  const data = await chrome.storage.local.get({ pendingPromptSave: null, folders: [] });
  const { pendingPromptSave } = data;
  folders = Array.isArray(data.folders) ? data.folders : [];
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

function createId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
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

  const folder = {
    id: createId(),
    name,
    prompts: []
  };
  folders.push(folder);
  await chrome.storage.local.set({ folders });
  currentDraft.folderId = folder.id;
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

loadDraft().catch((error) => showError(error.message || '读取选中内容失败。'));
