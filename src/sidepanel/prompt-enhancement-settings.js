/* Configuration stays behind the trusted side-panel message boundary. */
(function () {
  'use strict';
  const form = document.getElementById('promptEnhancementForm');
  const baseURL = document.getElementById('promptEnhancementBaseURL');
  const model = document.getElementById('promptEnhancementModel');
  const apiKey = document.getElementById('promptEnhancementApiKey');
  const clearApiKey = document.getElementById('promptEnhancementClearKey');
  const loadModels = document.getElementById('loadPromptEnhancementModels');
  const saveTest = document.getElementById('saveTestPromptEnhancement');
  const status = document.getElementById('promptEnhancementStatus');
  const modelsStatus = document.getElementById('promptEnhancementModelsStatus');
  const keyState = document.getElementById('promptEnhancementKeyState');
  const authInputs = Array.from(form.querySelectorAll('[name="promptEnhancementAuth"]'));
  const advanced = {
    systemPrompt: document.getElementById('promptEnhancementSystemPrompt'),
    userPrompt: document.getElementById('promptEnhancementUserPrompt'),
    temperature: document.getElementById('promptEnhancementTemperature'),
    topP: document.getElementById('promptEnhancementTopP'),
    maxOutputTokens: document.getElementById('promptEnhancementMaxTokens')
  };
  const controls = Array.from(form.querySelectorAll('input, select, button, textarea'));
  const { ERRORS } = PromptPocketEnhancement;
  advanced.systemPrompt.value = PromptPocketEnhancement.DEFAULT_SYSTEM_PROMPT;
  advanced.userPrompt.value = '{{text}}';
  let busy = false;
  let loaded = false;
  let lastOrigin = origin();
  let savedKeyOrigin = '';
  const allowedErrors = new Set(Object.values(ERRORS));
  const errorHints = new Map([
    [ERRORS.config, '请填写服务地址，并获取模型。'],
    [ERRORS.url, '服务地址格式不对，请复制服务商提供的完整地址；网上服务须以 https:// 开头。'],
    [ERRORS.model, '请先获取模型，再选择一个模型。'],
    [ERRORS.key, '密钥格式不对，请重新复制，注意不要带空格或换行。'],
    [ERRORS.missingKey, '请先粘贴访问密钥；免密服务可在高级设置中切换。'],
    [ERRORS.permission, '尚未允许访问服务，请重试，并在浏览器提示中点击“允许”。']
  ]);
  function origin() {
    try { return new URL(baseURL.value.trim()).origin; } catch (_) { return ''; }
  }
  function errorText(error) {
    return errorHints.get(error) || (allowedErrors.has(error) ? error : ERRORS.storage);
  }
  function authMode() {
    return form.querySelector('[name="promptEnhancementAuth"]:checked').value;
  }
  function setStatus(text, state = '', detail = '') {
    status.dataset.state = state;
    status.replaceChildren(document.createTextNode(text));
    if (detail) {
      const secondary = document.createElement('span');
      secondary.textContent = detail;
      status.append(secondary);
    }
  }
  function updateControls() {
    controls.forEach(control => { control.disabled = busy || !loaded; });
    apiKey.disabled = busy || !loaded || authMode() === 'none' || clearApiKey.checked;
    model.disabled = busy || !loaded || !Array.from(model.options).some(option => option.value);
  }
  function setBusy(value) {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    if (!value) {
      loadModels.textContent = '获取模型';
      saveTest.textContent = '保存设置并测试';
    }
    updateControls();
  }
  function invalidateModels() {
    model.replaceChildren(new Option('请重新获取模型', ''));
    modelsStatus.textContent = '';
    setStatus('配置已修改，尚未保存。');
    updateControls();
  }
  function fillSaved(result) {
    if (result.config) {
      baseURL.value = result.config.baseURL;
      authInputs.forEach(input => { input.checked = input.value === result.config.authMode; });
      if (!Array.from(model.options).some(option => option.value === result.config.model)) {
        model.add(new Option(result.config.model, result.config.model));
      }
      model.value = result.config.model;
      advanced.systemPrompt.value = result.config.systemPrompt || PromptPocketEnhancement.DEFAULT_SYSTEM_PROMPT;
      advanced.userPrompt.value = result.config.userPrompt || '{{text}}';
      for (const field of ['temperature', 'topP', 'maxOutputTokens']) advanced[field].value = result.config[field] ?? '';
    }
    apiKey.value = '';
    clearApiKey.checked = false;
    lastOrigin = origin();
    savedKeyOrigin = result.hasApiKey ? lastOrigin : '';
    apiKey.placeholder = result.hasApiKey ? '留空沿用已保存的密钥' : '粘贴服务商提供的密钥';
    keyState.textContent = result.hasApiKey ? '已保存。更换密钥时再填写。' : '';
    updateControls();
  }
  function readConfig(forList = false) {
    return PromptPocketEnhancement.normalizeConfig({
      baseURL: baseURL.value, model: model.value, authMode: authMode(),
      systemPrompt: advanced.systemPrompt.value, userPrompt: advanced.userPrompt.value,
      ...Object.fromEntries(['temperature', 'topP', 'maxOutputTokens'].map(field =>
        [field, advanced[field].value === '' ? undefined : Number(advanced[field].value)]))
    }, { requireModel: !forList });
  }
  function requestPermission(config) {
    // Invoke directly inside the user gesture, before awaiting messages or storage.
    return chrome.permissions.request({ origins: [PromptPocketEnhancement.serviceDetails(config).permissionOrigin] });
  }
  async function send(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result || !result.success) throw new Error(result && result.error || ERRORS.storage);
    return result;
  }
  baseURL.addEventListener('input', () => {
    const nextOrigin = origin();
    if (nextOrigin !== lastOrigin) {
      apiKey.value = '';
      apiKey.placeholder = nextOrigin === savedKeyOrigin ? '留空沿用已保存的密钥' : '粘贴服务商提供的密钥';
      keyState.textContent = nextOrigin === savedKeyOrigin ? '已保存。更换密钥时再填写。' : '服务网站或端口已改变，请重新填写密钥。';
    }
    lastOrigin = nextOrigin;
    invalidateModels();
  });
  apiKey.addEventListener('input', () => {
    keyState.textContent = apiKey.value ? '将使用新密钥，保存后替换旧密钥。' : origin() === savedKeyOrigin ? '已保存。更换密钥时再填写。' : '';
    invalidateModels();
  });
  authInputs.forEach(input => input.addEventListener('change', invalidateModels));
  clearApiKey.addEventListener('change', () => {
    if (clearApiKey.checked) apiKey.value = '';
    keyState.textContent = clearApiKey.checked ? '保存后将清除密钥。' : origin() === savedKeyOrigin ? '已保存。更换密钥时再填写。' : '';
    // Keep the selected model so an existing credential can be explicitly cleared.
    setStatus('配置已修改，尚未保存。');
    updateControls();
  });
  model.addEventListener('change', () => { setStatus('模型已修改，尚未保存。'); });
  Object.values(advanced).forEach(input => input.addEventListener('input', () => {
    setStatus('高级设置已修改，尚未保存。');
  }));

  setBusy(true);
  send({ action: 'getPromptEnhancementConfig' }).then(result => {
    loaded = true;
    fillSaved(result);
  }).catch(error => { setStatus(errorText(error.message), 'error'); })
    .finally(() => setBusy(false));

  loadModels.addEventListener('click', async () => {
    if (busy || !loaded) return;
    let config;
    try { config = readConfig(true); }
    catch (error) { modelsStatus.textContent = errorText(error.message); return; }
    const previousModel = model.value;
    setBusy(true);
    loadModels.textContent = '正在获取…';
    modelsStatus.textContent = '正在获取模型…';
    try {
      if (!(await requestPermission(config))) throw new Error(ERRORS.permission);
      const result = await send({ action: 'listPromptEnhancementModels',
        config: { baseURL: config.baseURL, authMode: config.authMode },
        apiKey: config.authMode === 'bearer' && !clearApiKey.checked ? apiKey.value : '', clearApiKey: clearApiKey.checked });
      model.replaceChildren(...result.models.map(name => new Option(name, name)));
      if (result.models.includes(previousModel)) model.value = previousModel;
      modelsStatus.textContent = `已获取 ${result.models.length} 个模型，请选择后保存。`;
      setStatus('模型列表已更新，配置尚未保存。');
    } catch (error) {
      modelsStatus.textContent = '获取模型失败：' + errorText(error.message);
    } finally { setBusy(false); }
  });

  form.addEventListener('invalid', event => {
    if (event.target.closest('details')) form.querySelector('details').open = true;
  }, true);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !loaded) return;
    let config;
    try { config = readConfig(); }
    catch (error) { setStatus(errorText(error.message), 'error'); return; }
    setBusy(true);
    saveTest.textContent = '正在保存…';
    setStatus('正在保存，请允许浏览器访问此服务…');
    let saved = false;
    try {
      if (!(await requestPermission(config))) throw new Error(ERRORS.permission);
      const result = await send({ action: 'savePromptEnhancementConfig', config,
        apiKey: config.authMode === 'bearer' ? apiKey.value : '', clearApiKey: clearApiKey.checked });
      saved = true;
      fillSaved(result);
      saveTest.textContent = '正在测试…';
      setStatus('设置已保存，正在测试连接和模型…');
      const started = performance.now();
      const tested = await send({ action: 'testPromptEnhancementConfig' });
      const elapsedMs = Math.round(performance.now() - started);
      setStatus(`测试成功 · ${elapsedMs} 毫秒`, 'success', `模型：${tested.model}`);
    } catch (error) {
      setStatus((saved ? '设置已保存，但测试失败：' : '保存失败：') + errorText(error.message), 'error');
    } finally { setBusy(false); }
  });
})();
