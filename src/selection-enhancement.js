/* Selection snapshots and explicit confirmation for prompt enhancement. */
(function (root) {
  function captureSelection(doc = document) {
    const element = doc.activeElement;
    if (element && (element.tagName === 'TEXTAREA' ||
        (element.tagName === 'INPUT' && /^(text|search|url|tel|email)$/i.test(element.type)))) {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (Number.isInteger(start) && end > start) {
        return { type: 'input', element, start, end, value: element.value,
          text: element.value.slice(start, end), editable: !element.readOnly && !element.disabled };
      }
    }
    const selection = doc.getSelection();
    if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0).cloneRange();
    const text = range.toString();
    if (!text.trim()) return null;
    let parent = range.commonAncestorContainer;
    if (parent.nodeType !== 1) parent = parent.parentElement;
    let editor = parent && parent.closest('[contenteditable]');
    if (editor && editor.isContentEditable) {
      while (editor.parentElement && editor.parentElement.isContentEditable) editor = editor.parentElement;
    } else editor = null;
    return { type: 'range', range, text, element: editor,
      html: editor && editor.innerHTML, editable: !!editor };
  }

  function replaceSelection(snapshot, text) {
    if (!snapshot || !snapshot.editable || !text.trim()) throw new Error('此处不能替换，请复制增强结果后粘贴到输入框');
    const element = snapshot.element;
    if (!element.isConnected || element.readOnly || element.disabled) throw new Error('原输入框已关闭或不可编辑，请重新选择文字');
    const doc = element.ownerDocument;
    if (snapshot.type === 'input') {
      if (element.value !== snapshot.value) throw new Error('原文已变化，未替换；请重新选择文字后增强');
      element.focus();
      element.setSelectionRange(snapshot.start, snapshot.end);
      if (!doc.execCommand('insertText', false, text)) throw new Error('此编辑器不支持安全替换，请复制结果后手动粘贴');
      element.setSelectionRange(snapshot.start, snapshot.start + text.length);
      return;
    }
    if (!element.isContentEditable || element.innerHTML !== snapshot.html ||
        !element.contains(snapshot.range.startContainer) || !element.contains(snapshot.range.endContainer) ||
        snapshot.range.toString() !== snapshot.text) {
      throw new Error('原文或选区已变化，未替换；请重新选择文字后增强');
    }
    element.focus();
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(snapshot.range);
    // Use the editor's native input/undo path; never replace the whole editor as a fallback.
    if (!doc.execCommand('insertText', false, text)) throw new Error('此编辑器不支持安全替换，请复制结果后手动粘贴');
  }

  let activeDialog = null;
  function open({ runtime, notice, doc = document }) {
    if (activeDialog) return;
    const snapshot = captureSelection(doc);
    if (!snapshot || !snapshot.text.trim()) { notice('请先选中需要增强的提示词'); return; }
    if (snapshot.text.length > 16000) { notice('选中文字过长，请控制在 16000 字符内'); return; }
    const previousFocus = doc.activeElement;
    const host = doc.createElement('div');
    host.id = 'promptpocket-enhancement-preview';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; }
        dialog { box-sizing:border-box; width:min(680px,calc(100vw - 28px)); max-height:calc(100vh - 28px); margin:auto; padding:22px; border:1px solid #d9d9d9; border-radius:18px; background:#fafafa; color:#171717; box-shadow:0 24px 80px #0005; font:14px/1.5 "Microsoft YaHei UI",system-ui,sans-serif; }
        dialog::backdrop { background:#0007; }
        h2 { font-size:19px; margin:0 0 8px; }
        p { margin:8px 0; color:#555; }
        label { display:block; font-weight:700; margin:12px 0 5px; }
        textarea { box-sizing:border-box; width:100%; min-height:92px; max-height:25vh; padding:10px; resize:vertical; border:1px solid #d5d5d5; border-radius:10px; background:#fff; color:#171717; font:inherit; }
        #result { min-height:150px; }
        #status { min-height:24px; overflow-wrap:anywhere; }
        .actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; margin-top:14px; }
        button { padding:9px 13px; border:1px solid #d5d5d5; border-radius:10px; background:#fff; color:#171717; cursor:pointer; font:600 14px system-ui,sans-serif; }
        #apply { background:#111; color:#fff; }
        button:disabled { opacity:.45; cursor:default; }
        :focus-visible { outline:2px solid #555; outline-offset:2px; }
      </style>
      <dialog aria-labelledby="title" aria-describedby="explanation">
        <h2 id="title">增强提示词</h2>
        <p id="explanation">只优化表达，保留原意和原语言，不回答问题。确认前不会修改原文。</p>
        <label for="original">选中的原文</label><textarea id="original" readonly></textarea>
        <label for="result">增强结果预览</label><textarea id="result" readonly placeholder="等待模型返回增强结果"></textarea>
        <p id="status" role="status" aria-live="polite"></p>
        <div class="actions"><button id="cancel" type="button">取消</button><button id="retry" type="button">重新增强</button><button id="copy" type="button" disabled>复制结果</button><button id="apply" type="button" disabled>确认替换选中文本</button></div>
      </dialog>`;
    const dialog = shadow.querySelector('dialog');
    const original = shadow.querySelector('#original');
    const result = shadow.querySelector('#result');
    const status = shadow.querySelector('#status');
    const retry = shadow.querySelector('#retry');
    const copy = shadow.querySelector('#copy');
    const apply = shadow.querySelector('#apply');
    original.value = snapshot.text;
    activeDialog = host;
    let port = null;
    function disconnect() {
      if (!port) return;
      const connection = port;
      port = null;
      connection.disconnect();
    }
    function close() {
      if (activeDialog !== host) return;
      activeDialog = null;
      disconnect();
      doc.defaultView.removeEventListener('pagehide', close);
      dialog.close();
      host.remove();
      if (previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
    function generate() {
      if (port) return;
      retry.disabled = true;
      copy.disabled = true;
      apply.disabled = true;
      result.value = '';
      status.textContent = '正在连接模型…结果会逐段显示，取消将中止请求。';
      function failed(message) {
        result.value = '';
        status.textContent = `增强未完成：${message} 原文未修改，可手动重新增强。`;
        retry.disabled = false;
        disconnect();
      }
      try {
        const connection = runtime.connect({ name: 'promptpocket-enhancement' });
        port = connection;
        connection.onMessage.addListener(message => {
          if (activeDialog !== host || port !== connection) return;
          if (message.type === 'delta' && typeof message.text === 'string') {
            result.value += message.text;
            status.textContent = '正在生成…当前内容尚未完成，取消将中止请求。';
          } else if (message.type === 'done' && typeof message.text === 'string' && message.text.trim()) {
            result.value = message.text;
            copy.disabled = false;
            apply.disabled = !snapshot.editable;
            retry.disabled = false;
            status.textContent = snapshot.editable ? '请检查结果，确认后只替换原选区。' : '选中文字不可编辑，不能直接替换；可复制结果后粘贴到输入框。';
            disconnect();
          } else if (message.type === 'error') failed(message.error || '模型服务返回失败。');
        });
        connection.onDisconnect.addListener(() => {
          const error = runtime.lastError;
          if (activeDialog === host && port === connection) {
            port = null;
            failed(error ? '插件连接已断开，请刷新页面后重试。' : '模型连接提前结束。');
          }
        });
        connection.postMessage({ text: snapshot.text });
      } catch (_) { failed('插件连接已失效，请刷新页面后重试。'); }
    }
    shadow.querySelector('#cancel').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    retry.addEventListener('click', generate);
    copy.addEventListener('click', async () => {
      try { await doc.defaultView.navigator.clipboard.writeText(result.value); status.textContent = '已复制增强结果'; }
      catch { status.textContent = '复制失败，可在预览框内选中结果后按 Ctrl+C'; }
    });
    apply.addEventListener('click', () => {
      // A modal dialog makes the page inert; release it before editing the saved selection.
      dialog.close();
      try { replaceSelection(snapshot, result.value); close(); notice('已替换选中的提示词'); }
      catch (error) { dialog.showModal(); status.textContent = error.message; apply.disabled = true; }
    });
    doc.documentElement.appendChild(host);
    doc.defaultView.addEventListener('pagehide', close);
    dialog.showModal();
    shadow.querySelector('#cancel').focus();
    generate();
  }

  const api = { captureSelection, replaceSelection, open };
  root.PromptPocketSelectionEnhancement = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
