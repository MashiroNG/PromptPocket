/* PromptPocket - content script for selection save and quick prompt input */

const FLOAT_BUTTON_ID = 'simplest-prompt-save-float';
const FLOAT_WRAP_ID = 'simplest-prompt-selection-float';
const FLOAT_COMMAND_BUTTON_ID = 'simplest-prompt-command-float';
const FLOAT_COMMAND_PANEL_ID = 'simplest-prompt-command-panel';
const QUICK_LAUNCHER_ID = 'simplest-prompt-quick-launcher';
const QUICK_PANEL_ID = 'simplest-prompt-quick-panel';
const QUICK_STYLE_ID = 'simplest-prompt-quick-style';
let floatHideTimer = null;
let extensionFeaturesActive = true;
let quickActiveEditor = null;
let quickPromptItems = [];
let quickComposerSelection = null;
let quickComposerResizeObserver = null;
let quickObservedComposerFrame = null;
let quickComposerMutationObserver = null;
let quickPositionFrame = null;
let quickRefreshToken = 0;
let quickLastLocationHref = location.href;

function hasRuntimeContext() {
  if (!extensionFeaturesActive) return false;
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    extensionFeaturesActive = false;
    return false;
  }
}

function deactivateExtensionFeatures() {
  extensionFeaturesActive = false;
  removeFloatButton();
  removeQuickPromptUi();
}

if (hasRuntimeContext()) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.action !== 'injectGemini') return;
    injectGeminiText(msg.text || '').then((ok) => {
      sendResponse({ success: !!ok });
    });
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.folders || changes.quickPromptScopeMode || changes.quickPromptScopeFolderId)) {
      refreshOpenQuickPanel();
    }
  });
}

function getSelectedText() {
  const selection = window.getSelection();
  return selection ? selection.toString().trim() : '';
}

function getSelectionRect() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
  return rects[rects.length - 1] || range.getBoundingClientRect();
}

function getWindowGeometry() {
  return {
    left: window.screenX,
    top: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  };
}

function removeFloatButton() {
  [FLOAT_WRAP_ID, FLOAT_BUTTON_ID, FLOAT_COMMAND_BUTTON_ID, FLOAT_COMMAND_PANEL_ID].forEach(id => {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
  });
  if (floatHideTimer) {
    clearTimeout(floatHideTimer);
    floatHideTimer = null;
  }
}

function closeSelectionCommandPanel() {
  const panel = document.getElementById(FLOAT_COMMAND_PANEL_ID);
  if (panel) panel.remove();
}

function showContentNotice(message) {
  const old = document.getElementById('simplest-prompt-notice');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'simplest-prompt-notice';
  el.textContent = message;
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:18px',
    'transform:translateX(-50%)',
    'z-index:2147483647',
    'max-width:min(520px,calc(100vw - 32px))',
    'padding:10px 14px',
    'border-radius:12px',
    'background:#202020',
    'color:#f8f8f8',
    'box-shadow:0 14px 34px rgba(0,0,0,.24)',
    'font:13px/1.45 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif'
  ].join(';');
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function applySelectionTemplateText(template, selectedText) {
  const base = (template || '').toString();
  return base.replace(/{{\s*text\s*}}/gi, selectedText || '');
}

function createSelectionFloatButton(id, text, isPrimary = false) {
  const button = document.createElement('button');
  button.id = id;
  button.type = 'button';
  button.textContent = text;
  button.style.cssText = [
    'height:32px',
    'padding:0 12px',
    'border-radius:999px',
    'border:1px solid rgba(248,248,248,.18)',
    isPrimary ? 'background:#202020' : 'background:linear-gradient(180deg,#2e2e2e,#131313)',
    'color:#f8f8f8',
    'box-shadow:0 10px 28px rgba(0,0,0,.32), inset 0 1px 0 rgba(248,248,248,.06)',
    'font:700 13px/1 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif',
    'cursor:pointer',
    'user-select:none',
    'white-space:nowrap'
  ].join(';');
  button.addEventListener('mousedown', event => event.preventDefault());
  return button;
}

async function loadSelectionCommands() {
  if (!hasRuntimeContext()) return [];
  const { selectionPrompts } = await chrome.storage.local.get({ selectionPrompts: [] });
  return Array.isArray(selectionPrompts) ? selectionPrompts.filter(item => item && item.template) : [];
}

async function useSelectionCommand(command) {
  const text = getSelectedText();
  if (!text) {
    removeFloatButton();
    return;
  }
  const composed = applySelectionTemplateText(command.template || '', text);
  chrome.runtime.sendMessage({ action: 'useSelectionCommand', text: composed }, response => {
    if (chrome.runtime.lastError || !response || !response.success) {
      showContentNotice(chrome.runtime.lastError && chrome.runtime.lastError.message || response && response.error || '执行快捷指令失败');
      return;
    }
    showContentNotice(response.pasted ? '已粘贴' : (response.copied ? '已复制，请按 Ctrl+V 粘贴' : '执行快捷指令失败'));
    closeSelectionCommandPanel();
  });
}

function renderSelectionCommandList(panel, commands, query = '') {
  const list = panel.querySelector('[data-sp-command-list]');
  if (!list) return;
  const q = String(query || '').trim().toLowerCase();
  const filtered = commands.filter(command => {
    const haystack = [command.name, command.template].join(' ').toLowerCase();
    return !q || haystack.includes(q);
  }).slice(0, 24);

  list.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = commands.length === 0 ? '还没有选中文本指令' : '没有匹配的指令';
    empty.style.cssText = 'padding:22px 10px;text-align:center;color:#6b6b6b;font-size:13px;border:1px dashed rgba(2,2,2,.12);border-radius:12px;background:#fff;';
    list.appendChild(empty);
    return;
  }

  filtered.forEach((command, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.style.cssText = [
      'width:100%',
      'display:grid',
      'gap:5px',
      'padding:11px 12px',
      'border-radius:14px',
      'border:1px solid rgba(2,2,2,.08)',
      'background:#fff',
      'color:#131313',
      'cursor:pointer',
      'text-align:left',
      'font:inherit',
      'box-shadow:0 2px 10px rgba(0,0,0,.04)',
      'animation:spQuickItemIn .18s cubic-bezier(.2,.85,.25,1) both',
      'animation-delay:' + Math.min(index, 8) * 18 + 'ms',
      'transition:transform .15s ease, box-shadow .15s ease, border-color .15s ease'
    ].join(';');
    const preview = (command.template || '').replace(/\s+/g, ' ').trim();
    item.innerHTML = [
      '<span style="font-weight:850;font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtmlText(command.name || '未命名指令') + '</span>',
      '<span style="color:#6b6b6b;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">选中文本指令</span>',
      '<span style="color:#989898;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtmlText(preview || '点击后套用选中的文字') + '</span>'
    ].join('');
    item.addEventListener('mouseenter', () => {
      item.style.transform = 'translateY(-1px)';
      item.style.borderColor = 'rgba(2,2,2,.18)';
      item.style.boxShadow = '0 8px 20px rgba(0,0,0,.08)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.transform = 'translateY(0)';
      item.style.borderColor = 'rgba(2,2,2,.08)';
      item.style.boxShadow = '0 2px 10px rgba(0,0,0,.04)';
    });
    item.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      useSelectionCommand(command);
    });
    list.appendChild(item);
  });
}

async function toggleSelectionCommandPanel(anchor) {
  const existing = document.getElementById(FLOAT_COMMAND_PANEL_ID);
  if (existing) {
    existing.remove();
    return;
  }

  const commands = await loadSelectionCommands();
  const panel = document.createElement('div');
  panel.id = FLOAT_COMMAND_PANEL_ID;
  panel.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'width:324px',
    'max-height:390px',
    'display:grid',
    'grid-template-rows:auto 1fr',
    'gap:10px',
    'padding:12px',
    'border-radius:18px',
    'border:1px solid rgba(2,2,2,.08)',
    'background:rgba(248,248,248,.96)',
    'color:#131313',
    'box-shadow:0 24px 60px rgba(0,0,0,.18), 0 3px 12px rgba(0,0,0,.08)',
    'backdrop-filter:blur(18px)',
    'font:14px/1.45 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif',
    'transform-origin:top right',
    'animation:spQuickPanelIn .2s cubic-bezier(.2,.85,.25,1) both'
  ].join(';');
  panel.innerHTML = [
    '<div style="display:grid;gap:10px;">',
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">',
    '<div style="display:grid;gap:2px;">',
    '<strong style="font-size:15px;line-height:1.2;color:#020202;">快捷指令</strong>',
    '<span style="font-size:12px;color:#6b6b6b;">点击后处理选中的文字</span>',
    '</div>',
    '<button type="button" data-sp-command-close aria-label="关闭" style="width:30px;height:30px;border:1px solid rgba(2,2,2,.08);border-radius:999px;background:#fff;color:#414141;cursor:pointer;font:700 17px/1 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.04);">×</button>',
    '</div>',
    '<input data-sp-command-search type="search" placeholder="搜索指令名称或内容" style="width:100%;height:38px;border:1px solid rgba(2,2,2,.1);border-radius:12px;background:#fff;color:#131313;padding:0 12px;font:13px Microsoft YaHei UI, Microsoft YaHei, sans-serif;outline:none;box-shadow:inset 0 1px 1px rgba(0,0,0,.03);">',
    '</div>',
    '<div data-sp-command-list style="display:grid;gap:8px;overflow:auto;max-height:290px;padding-right:2px;scrollbar-width:thin;scrollbar-color:rgba(2,2,2,.24) transparent;"></div>'
  ].join('');
  panel.addEventListener('mousedown', event => {
    const target = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target && event.target.parentElement;
    if (!target || !target.closest('[data-sp-command-search]')) event.preventDefault();
  });
  panel.querySelector('[data-sp-command-close]').addEventListener('click', closeSelectionCommandPanel);
  panel.querySelector('[data-sp-command-search]').addEventListener('input', event => renderSelectionCommandList(panel, commands, event.target.value || ''));

  document.documentElement.appendChild(panel);
  renderSelectionCommandList(panel, commands);
  const rect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const margin = 8;
  let left = rect.right - panelRect.width;
  let top = rect.bottom + 8;
  if (top + panelRect.height > window.innerHeight - margin) top = rect.top - panelRect.height - 8;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelRect.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - panelRect.height - margin));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function ensureFloatButton() {
  if (!hasRuntimeContext()) {
    deactivateExtensionFeatures();
    return null;
  }

  let wrap = document.getElementById(FLOAT_WRAP_ID);
  if (wrap) return wrap;

  wrap = document.createElement('div');
  wrap.id = FLOAT_WRAP_ID;
  wrap.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'display:none',
    'align-items:center',
    'gap:8px'
  ].join(';');

  const saveButton = createSelectionFloatButton(FLOAT_BUTTON_ID, '保存提示词', true);
  const commandButton = createSelectionFloatButton(FLOAT_COMMAND_BUTTON_ID, '快捷指令');

  saveButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    closeSelectionCommandPanel();
    const text = getSelectedText();
    if (!text) {
      removeFloatButton();
      return;
    }
    if (!hasRuntimeContext()) {
      deactivateExtensionFeatures();
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: 'openSaveSelection', text, geometry: getWindowGeometry() }, response => {
        if (!hasRuntimeContext()) {
          deactivateExtensionFeatures();
          return;
        }
        if (chrome.runtime.lastError || !response || !response.success) {
          showContentNotice(chrome.runtime.lastError && chrome.runtime.lastError.message || response && response.error || '保存提示词失败');
          return;
        }
        removeFloatButton();
      });
    } catch (e) {
      deactivateExtensionFeatures();
    }
  });

  commandButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (!getSelectedText()) {
      removeFloatButton();
      return;
    }
    toggleSelectionCommandPanel(commandButton).catch(error => {
      showContentNotice(error.message || '读取快捷指令失败');
    });
  });

  wrap.append(saveButton, commandButton);
  document.documentElement.appendChild(wrap);
  return wrap;
}

function positionFloatButton() {
  if (!hasRuntimeContext()) {
    deactivateExtensionFeatures();
    return;
  }

  const text = getSelectedText();
  const rect = getSelectionRect();
  if (!text || !rect) {
    removeFloatButton();
    return;
  }

  const wrap = ensureFloatButton();
  if (!wrap) return;
  wrap.style.display = 'inline-flex';
  const buttonRect = wrap.getBoundingClientRect();
  const margin = 8;
  let top = rect.bottom + margin;
  let left = rect.left + rect.width / 2 - buttonRect.width / 2;

  if (top + buttonRect.height > window.innerHeight - margin) {
    top = rect.top - buttonRect.height - margin;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - buttonRect.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - buttonRect.height - margin));

  wrap.style.left = left + 'px';
  wrap.style.top = top + 'px';
  const panel = document.getElementById(FLOAT_COMMAND_PANEL_ID);
  const commandButton = document.getElementById(FLOAT_COMMAND_BUTTON_ID);
  if (panel && commandButton) {
    panel.remove();
    toggleSelectionCommandPanel(commandButton).catch(() => {});
  }

  if (floatHideTimer) clearTimeout(floatHideTimer);
  floatHideTimer = setTimeout(() => {
    if (!getSelectedText()) removeFloatButton();
  }, 12000);
}

document.addEventListener('selectionchange', () => {
  if (!extensionFeaturesActive) return;
  setTimeout(positionFloatButton, 80);
});

document.addEventListener('mousedown', event => {
  if (!extensionFeaturesActive) return;
  const wrap = document.getElementById(FLOAT_WRAP_ID);
  const panel = document.getElementById(FLOAT_COMMAND_PANEL_ID);
  if (panel && !panel.contains(event.target) && (!wrap || !wrap.contains(event.target))) {
    closeSelectionCommandPanel();
  }
  if (wrap && event.target !== wrap && !wrap.contains(event.target) && (!panel || !panel.contains(event.target))) {
    setTimeout(() => {
      if (!getSelectedText()) removeFloatButton();
    }, 120);
  }
});

window.addEventListener('scroll', () => {
  if (!extensionFeaturesActive) return;
  if (getSelectedText()) positionFloatButton();
}, true);

window.addEventListener('resize', () => {
  if (!extensionFeaturesActive) return;
  if (getSelectedText()) positionFloatButton();
  if (quickActiveEditor) positionQuickLauncher(quickActiveEditor);
});

function isChatGptPage() {
  return /(^|\.)chatgpt\.com$/i.test(location.hostname || '') || /(^|\.)chat\.openai\.com$/i.test(location.hostname || '');
}

function isGeminiPage() {
  return /(^|\.)gemini\.google\.com$/i.test(location.hostname || '');
}

function isQuickPromptPage() {
  return isChatGptPage() || isGeminiPage();
}

function pageTextMatches(selectors, pattern) {
  const nodes = document.querySelectorAll(selectors);
  for (const node of nodes) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text && pattern.test(text)) return true;
  }
  return false;
}

function isChatGptPlanPage() {
  if (!isChatGptPage()) return false;
  if (/\/(?:pricing|plans|upgrade|settings\/subscription)/i.test(location.pathname || '')) return true;
  return pageTextMatches('main h1, main h2, main h3, [role="main"] h1, [role="main"] h2, [role="main"] h3, h1, h2', /升级套餐|升级至\s*Pro|Upgrade plan|Upgrade to Pro|Plans/i);
}

function isChatGptConversationPage() {
  if (!isChatGptPage()) return false;
  if (isChatGptPlanPage()) return false;
  const path = location.pathname || '/';
  if (/^\/(?:c|g|gpts|project|projects)\//i.test(path)) return true;
  if (path === '/' || path === '') return true;
  return false;
}

function isQuickPromptConversationPage() {
  return isChatGptConversationPage() || isGeminiPage();
}

function isTextInput(el) {
  if (!el || el.tagName !== 'INPUT') return false;
  const type = (el.type || 'text').toLowerCase();
  return !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden)$/i.test(type);
}

function isEditable(el) {
  return !!(el && (el.tagName === 'TEXTAREA' || isTextInput(el) || el.isContentEditable));
}

function findEditableFromTarget(target) {
  const start = target && target.nodeType === Node.ELEMENT_NODE ? target : target && target.parentElement;
  if (!start || !start.closest) return null;
  const geminiRichTextarea = start.closest('rich-textarea');
  if (geminiRichTextarea) {
    const geminiEditor = geminiRichTextarea.querySelector('.ql-editor[contenteditable="true"], .ql-editor, [contenteditable="true"]');
    if (isEditable(geminiEditor)) return geminiEditor;
  }
  const editable = start.closest('#prompt-textarea, [data-testid="composer-input"], textarea, input, .ql-editor, [contenteditable="true"]');
  return isEditable(editable) ? editable : null;
}

function isLikelyComposerForm(form) {
  if (!form || !form.querySelector) return false;
  const editable = form.querySelector('textarea, [contenteditable="true"]');
  if (!editable) return false;
  const sendButton = Array.from(form.querySelectorAll('button')).some(button => {
    const text = [
      button.getAttribute('aria-label') || '',
      button.getAttribute('title') || '',
      button.getAttribute('data-testid') || '',
      button.textContent || ''
    ].join(' ').toLowerCase();
    return /send|submit|发送|提交|send-button|composer-submit/.test(text);
  });
  return sendButton;
}

function looksLikeChatComposer(el) {
  if (!isChatGptConversationPage() || !isEditable(el)) return false;
  const blocker = el.closest && el.closest('article, [data-message-author-role], [data-testid^="conversation-turn"], [role="dialog"]');
  const explicitComposerContainer = el.closest && el.closest('[data-testid="composer-input-container"]');
  if (blocker && !explicitComposerContainer) return false;
  if (el.id === 'prompt-textarea') return true;
  if (el.matches && el.matches('[data-testid="composer-input"]')) return true;
  if (explicitComposerContainer && explicitComposerContainer.contains(el)) return true;

  const container = el.closest && el.closest('form');
  if (!container || container.closest('article, [data-message-author-role], [data-testid^="conversation-turn"], [role="dialog"]')) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 180 && rect.height > 20 && isLikelyComposerForm(container);
}

function looksLikeGeminiComposer(el) {
  if (!isGeminiPage() || !isEditable(el) || !isVisible(el)) return false;
  if (el.closest && el.closest('[role="dialog"], message-content, .model-response, .response-container')) return false;
  const richTextarea = el.closest && el.closest('rich-textarea');
  if (richTextarea && richTextarea.contains(el)) return true;
  if (el.matches && el.matches('.ql-editor[contenteditable="true"], .ql-editor')) return true;
  const rect = el.getBoundingClientRect();
  return !!(el.isContentEditable && rect.width > 180 && rect.height > 20 && el.getAttribute('role') === 'textbox');
}

function looksLikeQuickComposer(el) {
  return looksLikeChatComposer(el) || looksLikeGeminiComposer(el);
}

function findCurrentChatComposer() {
  const active = document.activeElement;
  if (looksLikeChatComposer(active)) return active;
  const selectors = [
    '#prompt-textarea',
    '[data-testid="composer-input"]',
    '[data-testid="composer-input-container"] [contenteditable="true"]',
    'form textarea',
    'form [contenteditable="true"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (looksLikeChatComposer(el)) return el;
  }
  return null;
}

function findCurrentGeminiComposer() {
  const active = document.activeElement;
  if (looksLikeGeminiComposer(active)) return active;
  const editor = findGeminiEditor();
  return looksLikeGeminiComposer(editor) ? editor : null;
}

function findCurrentQuickComposer() {
  return findCurrentChatComposer() || findCurrentGeminiComposer();
}

function ensureQuickLauncherForCurrentComposer() {
  if (!extensionFeaturesActive || !isQuickPromptConversationPage()) return;
  const launcher = document.getElementById(QUICK_LAUNCHER_ID);
  const panel = document.getElementById(QUICK_PANEL_ID);
  if ((launcher && document.activeElement && launcher.contains(document.activeElement)) ||
      (panel && document.activeElement && panel.contains(document.activeElement))) {
    return;
  }

  const editor = findCurrentQuickComposer();
  if (!editor) return;
  const shouldShow = document.activeElement === editor ||
    (editor.contains && editor.contains(document.activeElement)) ||
    quickActiveEditor === editor ||
    !launcher;
  if (shouldShow) scheduleQuickLauncherPosition(editor);
}

function getComposerFrame(editor) {
  if (!editor || !editor.closest) return editor;
  if (looksLikeGeminiComposer(editor)) return getGeminiComposerFrame(editor);
  return editor.closest('[data-testid="composer-input-container"], form') || editor;
}

function getGeminiComposerFrame(editor) {
  const editorRect = editor.getBoundingClientRect();
  let node = (editor.closest && editor.closest('rich-textarea')) || editor;
  const candidates = [];
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    const rect = node.getBoundingClientRect();
    if (rect.width > Math.max(320, editorRect.width + 80) &&
        rect.height >= 42 &&
        rect.height <= 260 &&
        rect.bottom > window.innerHeight * 0.45) {
      const hasActionButtons = !!(node.querySelectorAll && Array.from(node.querySelectorAll('button')).some(button => {
        const buttonRect = button.getBoundingClientRect();
        if (button.id === QUICK_LAUNCHER_ID) return false;
        if (buttonRect.width <= 0 || buttonRect.height <= 0) return false;
        return buttonRect.bottom > rect.bottom - 76 && buttonRect.right > rect.right - 260;
      }));
      candidates.push({ node, rect, hasActionButtons });
    }
  }
  const actionFrame = candidates
    .filter(candidate => candidate.hasActionButtons)
    .sort((a, b) => b.rect.height - a.rect.height || b.rect.width - a.rect.width)[0];
  if (actionFrame) return actionFrame.node;
  if (candidates.length > 0) {
    return candidates.sort((a, b) => b.rect.height - a.rect.height || b.rect.bottom - a.rect.bottom)[0].node;
  }
  return (editor.closest && editor.closest('rich-textarea')) || editor;
}

function getComposerRect(editor) {
  const target = getComposerFrame(editor);
  return target ? target.getBoundingClientRect() : null;
}

function getComposerActionCenterY(editor) {
  const frame = getComposerFrame(editor);
  if (!frame || !frame.querySelectorAll) return null;
  const frameRect = frame.getBoundingClientRect();
  const candidates = Array.from(frame.querySelectorAll('button')).map(button => {
    const rect = button.getBoundingClientRect();
    return { button, rect };
  }).filter(({ button, rect }) => {
    if (button.id === QUICK_LAUNCHER_ID) return false;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom < frameRect.bottom - 76) return false;
    if (rect.right < frameRect.right - 220) return false;
    return true;
  }).sort((a, b) => b.rect.right - a.rect.right);
  if (candidates.length === 0) return null;
  const rect = candidates[0].rect;
  return rect.top + rect.height / 2;
}

function scheduleQuickLauncherPosition(editor) {
  const targetEditor = editor || quickActiveEditor;
  if (!targetEditor || !looksLikeQuickComposer(targetEditor)) return;
  if (quickPositionFrame) cancelAnimationFrame(quickPositionFrame);
  quickPositionFrame = requestAnimationFrame(() => {
    quickPositionFrame = null;
    positionQuickLauncher(targetEditor);
  });
}

function observeQuickComposer(editor) {
  const frame = getComposerFrame(editor);
  if (!frame || quickObservedComposerFrame === frame) return;
  if (quickComposerResizeObserver) quickComposerResizeObserver.disconnect();
  quickObservedComposerFrame = frame;
  if (typeof ResizeObserver === 'undefined') return;
  quickComposerResizeObserver = new ResizeObserver(() => scheduleQuickLauncherPosition(editor));
  quickComposerResizeObserver.observe(frame);
}

function saveComposerSelection(editor) {
  if (!editor || !editor.isContentEditable) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
  quickComposerSelection = range.cloneRange();
}

function restoreComposerSelection(editor) {
  if (!editor || !editor.isContentEditable || !quickComposerSelection) return false;
  if (!editor.contains(quickComposerSelection.startContainer) || !editor.contains(quickComposerSelection.endContainer)) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(quickComposerSelection);
  return true;
}

function removeQuickPromptUi() {
  const launcher = document.getElementById(QUICK_LAUNCHER_ID);
  const panel = document.getElementById(QUICK_PANEL_ID);
  if (launcher) launcher.remove();
  if (panel) panel.remove();
  quickActiveEditor = null;
  quickComposerSelection = null;
  if (quickComposerResizeObserver) quickComposerResizeObserver.disconnect();
  quickComposerResizeObserver = null;
  quickObservedComposerFrame = null;
  if (quickPositionFrame) cancelAnimationFrame(quickPositionFrame);
  quickPositionFrame = null;
}

function syncQuickPromptPageState() {
  if (!extensionFeaturesActive || !isQuickPromptPage()) return;
  if (quickLastLocationHref !== location.href) {
    quickLastLocationHref = location.href;
    removeQuickPromptUi();
  }
  if (!isQuickPromptConversationPage()) {
    removeQuickPromptUi();
  }
}

function watchChatGptNavigation() {
  if (!isQuickPromptPage()) return;
  const notify = () => setTimeout(() => {
    syncQuickPromptPageState();
    ensureQuickLauncherForCurrentComposer();
  }, 120);
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
  ['pushState', 'replaceState'].forEach(name => {
    const original = history[name];
    if (typeof original !== 'function' || original.__promptPocketPatched) return;
    const patched = function(...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
    patched.__promptPocketPatched = true;
    history[name] = patched;
  });
  setInterval(() => {
    syncQuickPromptPageState();
    ensureQuickLauncherForCurrentComposer();
  }, 1000);
  if (typeof MutationObserver !== 'undefined') {
    let mutationTimer = null;
    quickComposerMutationObserver = new MutationObserver(() => {
      if (mutationTimer) clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => {
        syncQuickPromptPageState();
        ensureQuickLauncherForCurrentComposer();
      }, 120);
    });
    quickComposerMutationObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }
}

function ensureQuickAnimationStyles() {
  if (document.getElementById(QUICK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = QUICK_STYLE_ID;
  style.textContent = `
    @keyframes spQuickLauncherIn {
      from { opacity: 0; transform: translateX(-6px) scale(.92); }
      to { opacity: 1; transform: translateX(0) scale(1); }
    }
    @keyframes spQuickPanelIn {
      from { opacity: 0; transform: translateY(10px) scale(.965); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes spQuickItemIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      #${QUICK_LAUNCHER_ID}, #${QUICK_PANEL_ID}, #${QUICK_PANEL_ID} * {
        animation-duration: 1ms !important;
        transition-duration: 1ms !important;
      }
    }
    #${QUICK_PANEL_ID} [data-sp-list] {
      scrollbar-width: none;
      transition: scrollbar-color .16s ease;
    }
    #${QUICK_PANEL_ID} [data-sp-list]::-webkit-scrollbar {
      width: 0;
      height: 0;
    }
    #${QUICK_PANEL_ID} [data-sp-list].is-scrolling,
    #${QUICK_PANEL_ID} [data-sp-list]:hover {
      scrollbar-width: thin;
      scrollbar-color: rgba(2,2,2,.24) transparent;
    }
    #${QUICK_PANEL_ID} [data-sp-list].is-scrolling::-webkit-scrollbar,
    #${QUICK_PANEL_ID} [data-sp-list]:hover::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    #${QUICK_PANEL_ID} [data-sp-list].is-scrolling::-webkit-scrollbar-thumb,
    #${QUICK_PANEL_ID} [data-sp-list]:hover::-webkit-scrollbar-thumb {
      background: rgba(2,2,2,.24);
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: content-box;
    }
    #${QUICK_PANEL_ID} [data-sp-list]::-webkit-scrollbar-track {
      background: transparent;
    }
  `;
  document.documentElement.appendChild(style);
}

function attachQuickListScrollbarBehavior(list) {
  if (!list || list.dataset.spScrollBound === 'true') return;
  list.dataset.spScrollBound = 'true';
  let hideTimer = null;
  const show = () => {
    list.classList.add('is-scrolling');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => list.classList.remove('is-scrolling'), 900);
  };
  list.addEventListener('scroll', show, { passive: true });
  list.addEventListener('wheel', show, { passive: true });
  list.addEventListener('touchmove', show, { passive: true });
  list.addEventListener('mouseleave', () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => list.classList.remove('is-scrolling'), 160);
  });
}

function animateQuickPanelOut(panel) {
  if (!panel) return;
  const animation = panel.animate([
    { opacity: 1, transform: 'translateY(0) scale(1)' },
    { opacity: 0, transform: 'translateY(8px) scale(.97)' }
  ], { duration: 140, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'forwards' });
  animation.onfinish = () => panel.remove();
  animation.oncancel = () => panel.remove();
}

function ensureQuickLauncher() {
  let button = document.getElementById(QUICK_LAUNCHER_ID);
  if (button) return button;
  ensureQuickAnimationStyles();

  button = document.createElement('button');
  button.id = QUICK_LAUNCHER_ID;
  button.type = 'button';
  button.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:#f8f8f8;box-shadow:0 0 0 3px rgba(248,248,248,.12);"></span><span>提示词</span>';
  button.setAttribute('aria-label', '打开快捷提示词');
  button.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'gap:8px',
    'height:42px',
    'min-width:88px',
    'padding:0 17px',
    'border-radius:999px',
    'border:1px solid rgba(2,2,2,.1)',
    'background:linear-gradient(180deg,#2e2e2e,#131313)',
    'color:#f8f8f8',
    'box-shadow:0 16px 38px rgba(0,0,0,.22), inset 0 1px 0 rgba(248,248,248,.14)',
    'font:900 14px/1 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif',
    'letter-spacing:0',
    'cursor:pointer',
    'user-select:none',
    'animation:spQuickLauncherIn .2s cubic-bezier(.2,.85,.25,1) both',
    'transition:transform .16s ease, box-shadow .16s ease, background .16s ease'
  ].join(';');

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'translateY(-1px)';
    button.style.boxShadow = '0 20px 42px rgba(0,0,0,.26), inset 0 1px 0 rgba(248,248,248,.18)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.transform = 'translateY(0)';
    button.style.boxShadow = '0 16px 38px rgba(0,0,0,.22), inset 0 1px 0 rgba(248,248,248,.14)';
  });
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    button.animate([
      { transform: 'scale(1)' },
      { transform: 'scale(.94)' },
      { transform: 'scale(1)' }
    ], { duration: 180, easing: 'cubic-bezier(.2,.85,.25,1)' });
    toggleQuickPanel();
  });

  document.documentElement.appendChild(button);
  return button;
}

function positionQuickLauncher(editor) {
  if (!hasRuntimeContext() || !looksLikeQuickComposer(editor)) {
    removeQuickPromptUi();
    return;
  }
  quickActiveEditor = editor;
  observeQuickComposer(editor);
  const rect = getComposerRect(editor);
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  saveComposerSelection(editor);

  const button = ensureQuickLauncher();
  button.style.display = 'inline-flex';
  const buttonRect = button.getBoundingClientRect();
  const margin = 10;
  const gap = 16;
  const bottomInset = 15;
  const hasRightRoom = rect.right + gap + buttonRect.width <= window.innerWidth - margin;
  const targetLeft = hasRightRoom ? rect.right + gap : rect.right - buttonRect.width - 14;
  const left = Math.max(margin, Math.min(targetLeft, window.innerWidth - buttonRect.width - margin));
  const actionCenterY = getComposerActionCenterY(editor);
  const targetTop = Number.isFinite(actionCenterY)
    ? actionCenterY - buttonRect.height / 2
    : rect.bottom - buttonRect.height - bottomInset;
  const top = Math.max(margin, Math.min(targetTop, window.innerHeight - buttonRect.height - margin));
  button.style.left = left + 'px';
  button.style.top = top + 'px';

  const panel = document.getElementById(QUICK_PANEL_ID);
  if (panel) positionQuickPanel();
}

async function loadQuickPromptItems() {
  if (!hasRuntimeContext()) return [];
  const {
    folders,
    quickPromptScopeMode,
    quickPromptScopeFolderId
  } = await chrome.storage.local.get({
    folders: [],
    quickPromptScopeMode: 'all',
    quickPromptScopeFolderId: ''
  });
  const scopeMode = ['all', 'pinned', 'folder'].includes(quickPromptScopeMode) ? quickPromptScopeMode : 'all';
  const items = [];
  const safeFolders = Array.isArray(folders) ? folders : [];
  for (let folderIndex = 0; folderIndex < safeFolders.length; folderIndex += 1) {
    const folder = safeFolders[folderIndex];
    if (scopeMode === 'folder' && folder.id !== quickPromptScopeFolderId) continue;
    const prompts = folder.prompts || [];
    for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
      const prompt = prompts[promptIndex];
      if (!prompt || !prompt.text) continue;
      if (scopeMode === 'pinned' && !prompt.pinned) continue;
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
  if (scopeMode === 'folder') {
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

function ensureQuickPanel() {
  let panel = document.getElementById(QUICK_PANEL_ID);
  if (panel) return panel;
  ensureQuickAnimationStyles();

  panel = document.createElement('div');
  panel.id = QUICK_PANEL_ID;
  panel.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'width:324px',
    'max-height:390px',
    'display:grid',
    'grid-template-rows:auto 1fr',
    'gap:10px',
    'padding:12px',
    'border-radius:18px',
    'border:1px solid rgba(2,2,2,.08)',
    'background:rgba(248,248,248,.96)',
    'color:#131313',
    'box-shadow:0 24px 60px rgba(0,0,0,.18), 0 3px 12px rgba(0,0,0,.08)',
    'backdrop-filter:blur(18px)',
    'font:14px/1.45 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif',
    'transform-origin:top right',
    'animation:spQuickPanelIn .2s cubic-bezier(.2,.85,.25,1) both'
  ].join(';');
  panel.innerHTML = [
    '<div style="display:grid;gap:10px;">',
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">',
    '<div style="display:grid;gap:2px;">',
    '<strong style="font-size:15px;line-height:1.2;color:#020202;">快捷提示词</strong>',
    '<span style="font-size:12px;color:#6b6b6b;">点击后插入到聊天框</span>',
    '</div>',
    '<button type="button" data-sp-close aria-label="关闭" style="width:30px;height:30px;border:1px solid rgba(2,2,2,.08);border-radius:999px;background:#fff;color:#414141;cursor:pointer;font:700 17px/1 system-ui;box-shadow:0 2px 8px rgba(0,0,0,.04);">×</button>',
    '</div>',
    '<input data-sp-search type="search" placeholder="搜索标题、内容或文件夹" style="width:100%;height:38px;border:1px solid rgba(2,2,2,.1);border-radius:12px;background:#fff;color:#131313;padding:0 12px;font:13px Microsoft YaHei UI, Microsoft YaHei, sans-serif;outline:none;box-shadow:inset 0 1px 1px rgba(0,0,0,.03);">',
    '</div>',
    '<div data-sp-list style="display:grid;gap:8px;overflow:auto;max-height:290px;padding-right:2px;"></div>'
  ].join('');

  panel.addEventListener('mousedown', event => {
    const target = event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : event.target && event.target.parentElement;
    if (!target || !target.closest('[data-sp-search]')) event.preventDefault();
  });
  panel.querySelector('[data-sp-close]').addEventListener('click', () => animateQuickPanelOut(panel));
  panel.querySelector('[data-sp-search]').addEventListener('input', event => renderQuickPromptList(event.target.value || ''));
  attachQuickListScrollbarBehavior(panel.querySelector('[data-sp-list]'));

  document.documentElement.appendChild(panel);
  return panel;
}

function positionQuickPanel() {
  const panel = document.getElementById(QUICK_PANEL_ID);
  const launcher = document.getElementById(QUICK_LAUNCHER_ID);
  if (!panel || !launcher) return;

  const launcherRect = launcher.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const margin = 10;
  let left = launcherRect.right - panelRect.width;
  let top = launcherRect.bottom + 10;
  if (top + panelRect.height > window.innerHeight - margin) top = launcherRect.top - panelRect.height - 10;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelRect.width - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - panelRect.height - margin));
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}

function renderQuickPromptList(query) {
  const panel = ensureQuickPanel();
  const list = panel.querySelector('[data-sp-list]');
  const q = String(query || '').trim().toLowerCase();
  const filtered = quickPromptItems.filter(item => {
    const haystack = [item.title, item.text, item.folder].join(' ').toLowerCase();
    return !q || haystack.includes(q);
  }).slice(0, 30);

  list.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = quickPromptItems.length === 0 ? '还没有保存的提示词' : '没有匹配的提示词';
    empty.style.cssText = 'padding:22px 10px;text-align:center;color:#6b6b6b;font-size:13px;border:1px dashed rgba(2,2,2,.12);border-radius:12px;background:#fff;animation:spQuickItemIn .18s cubic-bezier(.2,.85,.25,1) both;';
    list.appendChild(empty);
    return;
  }

  for (let index = 0; index < filtered.length; index += 1) {
    const item = filtered[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = [
      'display:grid',
      'gap:4px',
      'width:100%',
      'text-align:left',
      'border:1px solid rgba(2,2,2,.08)',
      'border-radius:13px',
      'background:#fff',
      'color:#131313',
      'padding:10px 11px',
      'cursor:pointer',
      'font:inherit',
      'box-shadow:0 2px 10px rgba(0,0,0,.04)',
      'animation:spQuickItemIn .18s cubic-bezier(.2,.85,.25,1) both',
      'animation-delay:' + Math.min(index, 8) * 18 + 'ms',
      'transition:transform .14s ease, border-color .14s ease, box-shadow .14s ease'
    ].join(';');
    button.innerHTML = [
      '<span style="display:flex;align-items:center;gap:6px;min-width:0;">',
      '<span style="font-weight:800;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;">' + escapeHtmlText(item.title) + '</span>',
      item.pinned ? '<span style="flex:none;border:1px solid rgba(2,2,2,.08);border-radius:999px;padding:1px 6px;background:#202020;color:#f8f8f8;font-size:11px;font-weight:800;">置顶</span>' : '',
      '</span>',
      '<span style="color:#6b6b6b;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtmlText(item.folder) + '</span>',
      '<span style="color:#989898;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtmlText(item.text) + '</span>'
    ].join('');
    button.addEventListener('mouseenter', () => {
      button.style.transform = 'translateY(-1px)';
      button.style.borderColor = 'rgba(2,2,2,.18)';
      button.style.boxShadow = '0 8px 20px rgba(0,0,0,.08)';
    });
    button.addEventListener('mouseleave', () => {
      button.style.transform = 'translateY(0)';
      button.style.borderColor = 'rgba(2,2,2,.08)';
      button.style.boxShadow = '0 2px 10px rgba(0,0,0,.04)';
    });
    button.addEventListener('click', () => {
      insertPromptIntoComposer(item.text);
      animateQuickPanelOut(panel);
    });
    list.appendChild(button);
  }
}

function escapeHtmlText(text) {
  return String(text || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

async function toggleQuickPanel() {
  const existing = document.getElementById(QUICK_PANEL_ID);
  if (existing) {
    animateQuickPanelOut(existing);
    return;
  }
  saveComposerSelection(quickActiveEditor);
  quickPromptItems = await loadQuickPromptItems();
  const panel = ensureQuickPanel();
  const search = panel.querySelector('[data-sp-search]');
  search.value = '';
  renderQuickPromptList('');
  positionQuickPanel();
  setTimeout(() => search.focus(), 0);
}

async function refreshOpenQuickPanel() {
  const panel = document.getElementById(QUICK_PANEL_ID);
  if (!panel || !hasRuntimeContext()) return;
  const token = ++quickRefreshToken;
  const search = panel.querySelector('[data-sp-search]');
  const query = search && search.value || '';
  try {
    const items = await loadQuickPromptItems();
    if (token !== quickRefreshToken) return;
    if (!document.getElementById(QUICK_PANEL_ID)) return;
    quickPromptItems = items;
    renderQuickPromptList(query);
    positionQuickPanel();
  } catch (e) {
    if (!hasRuntimeContext()) deactivateExtensionFeatures();
  }
}

function setNativeValue(el, next) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement && window.HTMLInputElement.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, next);
  else el.value = next;
}

function insertPromptIntoComposer(text) {
  const editor = looksLikeQuickComposer(quickActiveEditor) ? quickActiveEditor : findCurrentQuickComposer();
  if (!editor) return;
  editor.focus();

  if (editor.tagName === 'TEXTAREA' || isTextInput(editor)) {
    const start = editor.selectionStart || 0;
    const end = editor.selectionEnd || 0;
    const value = editor.value || '';
    const next = value.slice(0, start) + text + value.slice(end);
    setNativeValue(editor, next);
    editor.selectionStart = editor.selectionEnd = start + text.length;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return;
  }

  try {
    restoreComposerSelection(editor);
    if (document.execCommand('insertText', false, text)) return;
  } catch (e) {}

  try {
    if (looksLikeGeminiComposer(editor)) {
      const current = editor.textContent || '';
      editor.innerHTML = '';
      const p = document.createElement('p');
      p.textContent = current + text;
      editor.appendChild(p);
      setSelectionToEnd(editor);
      dispatchEvents(editor, text);
      return;
    }
    editor.textContent = (editor.textContent || '') + text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  } catch (e) {}
}

document.addEventListener('focusin', event => {
  syncQuickPromptPageState();
  if (!extensionFeaturesActive || !isQuickPromptConversationPage()) return;
  const launcher = document.getElementById(QUICK_LAUNCHER_ID);
  const panel = document.getElementById(QUICK_PANEL_ID);
  if ((launcher && launcher.contains(event.target)) || (panel && panel.contains(event.target))) return;

  const editor = findEditableFromTarget(event.target);
  if (looksLikeQuickComposer(editor)) {
    setTimeout(() => positionQuickLauncher(editor), 60);
    return;
  }
  if (editor) removeQuickPromptUi();
}, true);

document.addEventListener('input', event => {
  syncQuickPromptPageState();
  if (!extensionFeaturesActive || !isQuickPromptConversationPage()) return;
  const editor = findEditableFromTarget(event.target);
  if (looksLikeQuickComposer(editor)) {
    quickActiveEditor = editor;
    scheduleQuickLauncherPosition(editor);
  }
}, true);

document.addEventListener('click', event => {
  syncQuickPromptPageState();
  if (!extensionFeaturesActive || !isQuickPromptConversationPage()) return;
  const launcher = document.getElementById(QUICK_LAUNCHER_ID);
  const panel = document.getElementById(QUICK_PANEL_ID);
  if ((launcher && launcher.contains(event.target)) || (panel && panel.contains(event.target))) return;

  const editor = findEditableFromTarget(event.target);
  if (looksLikeQuickComposer(editor)) {
    setTimeout(() => positionQuickLauncher(editor), 60);
    return;
  }
  if (editor) removeQuickPromptUi();
  if (panel) animateQuickPanelOut(panel);
}, true);

watchChatGptNavigation();

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function dispatchEvents(el, text) {
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  } catch (e) {}
  try {
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  } catch (e) {}
  try {
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  } catch (e) {}
}

function setSelectionToEnd(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {}
}

function findGeminiEditor() {
  const selectors = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor',
    '.ql-editor[contenteditable="true"]',
    '.ql-editor',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    for (const node of nodes) {
      if (node && isVisible(node)) return node;
    }
  }
  return null;
}

async function waitForEditor(timeoutMs) {
  const start = Date.now();
  let editor = findGeminiEditor();
  if (editor) return editor;
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      editor = findGeminiEditor();
      if (editor) {
        observer.disconnect();
        resolve(editor);
      } else if (Date.now() - start > timeoutMs) {
        observer.disconnect();
        resolve(null);
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(findGeminiEditor());
    }, timeoutMs);
  });
}

async function injectGeminiText(text) {
  const editor = await waitForEditor(15000);
  if (!editor) return false;

  try {
    editor.focus();
    editor.click();
  } catch (e) {}

  // Quill editor expects content within <p>
  try {
    editor.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = text;
    editor.appendChild(p);
    setSelectionToEnd(editor);
    dispatchEvents(editor, text);
    return true;
  } catch (e) {}

  try {
    editor.textContent = text;
    setSelectionToEnd(editor);
    dispatchEvents(editor, text);
    return true;
  } catch (e) {}

  try {
    if (document.execCommand('insertText', false, text)) return true;
  } catch (e) {}

  return false;
}
