const assert = require('node:assert/strict');
const {
  normalizeConfig, serviceDetails, createMessageHandler, ERRORS, MAX_TEXT, MAX_RESULT
} = require('../src/shared/prompt-enhancement.js');

const config = (changes = {}) => ({ baseURL: 'https://api.example.com/v1', model: 'test-model', authMode: 'bearer', ...changes });
const panel = { id: 'test', url: 'chrome-extension://test/src/sidepanel/sidepanel.html', tab: { id: 99 } };
const content = { id: 'test', url: 'https://chatgpt.com/c/test', tab: { id: 1 }, frameId: 0 };
const secret = 'sk-test-private-secret';
const event = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const completion = (text = '更清晰的提示词', finish_reason = 'stop') => new Response(
  event({ choices: [{ delta: { content: text }, finish_reason }] }) + 'data: [DONE]\r\n\r\n',
  { headers: { 'Content-Type': 'text/event-stream' } });

function eventTarget() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), emit: value => listeners.forEach(fn => fn(value)) };
}

function harness({ local = {}, session = {}, credentials = {} } = {}) {
  const calls = [];
  const permissions = [];
  const access = [];
  let granted = true;
  let fetchImpl = async () => completion();
  const storage = state => ({
    get: async key => ({ [key]: state[key] }),
    set: async values => Object.assign(state, structuredClone(values)),
    remove: async key => { delete state[key]; }
  });
  const chrome = {
    runtime: { id: 'test', getURL: file => `chrome-extension://test/${file}` },
    storage: { local: storage(local), session: { ...storage(session), setAccessLevel: async value => { access.push(value); } } },
    permissions: { contains: async value => { permissions.push(value); return granted; } }
  };
  const keyStore = {
    get: async () => structuredClone(credentials.key),
    set: async value => { credentials.key = structuredClone(value); },
    remove: async () => { delete credentials.key; }
  };
  const makeHandler = () => createMessageHandler({
    chrome, keyStore, timeoutMs: 10,
    fetch: async (...args) => { calls.push(args); return fetchImpl(...args); }
  });
  let handler = makeHandler();
  const send = (message, sender = panel) => new Promise(resolve => {
    assert.equal(handler(message, sender, resolve), true);
  });
  function stream(text = '请优化这个提示词', sender = content, extra = {}) {
    const messages = [];
    const onMessage = eventTarget(), onDisconnect = eventTarget();
    let resolve;
    const result = new Promise(done => { resolve = done; });
    const port = { name: 'promptpocket-enhancement', sender, onMessage, onDisconnect,
      postMessage: message => {
        messages.push(message);
        if (message.type === 'done') resolve({ success: true, text: message.text });
        if (message.type === 'error') resolve({ success: false, error: message.error });
      }, disconnect() {} };
    handler.handleConnect(port);
    onMessage.emit({ text, ...extra });
    return { messages, result, cancel: () => onDisconnect.emit() };
  }
  return {
    local, session, credentials, keyStore, chrome, calls, permissions, access, send, stream,
    reopen: () => { handler = makeHandler(); },
    grant: value => { granted = value; },
    respond: fn => { fetchImpl = fn; },
    save: (changes = {}, key = secret, clearApiKey = false) => send({
      action: 'savePromptEnhancementConfig', config: config(changes), apiKey: key, clearApiKey
    }),
    enhance: (...args) => stream(...args).result
  };
}

async function run() {
  for (const baseURL of [
    'http://example.com/v1', 'file:///tmp', 'javascript:alert(1)', 'https://name:password@example.com/v1',
    'https://example.com/v1?token=x', 'https://example.com/v1?', 'https://example.com/v1#', 'https://@example.com/v1',
    'https://example.com/v1#secret', 'https://example.com\\@evil.test/v1', 'https://example.com/\npath',
    'http://localhost.evil.test/v1', 'http://127.0.0.2/v1'
  ]) assert.throws(() => normalizeConfig(config({ baseURL })), undefined, baseURL);
  for (const baseURL of ['https://example.com/v1/', 'http://localhost:1234/v1', 'http://127.0.0.1:8000']) {
    const normalized = normalizeConfig(config({ baseURL }));
    assert.equal(normalized.baseURL.endsWith('/'), false);
    assert.equal(serviceDetails(normalized).endpoint, normalized.baseURL + '/chat/completions');
  }
  assert.equal(serviceDetails(normalizeConfig(config({ baseURL: 'http://localhost:1234/v1' }))).permissionOrigin, 'http://localhost/*');
  for (const model of ['', ' ', 'a'.repeat(201), 'bad\nmodel']) assert.throws(() => normalizeConfig(config({ model })));
  assert.throws(() => normalizeConfig(config({ authMode: 'basic' })));
  assert.deepEqual(normalizeConfig({ baseURL: 'https://api.example.com/v1/', authMode: 'none' }, { requireModel: false }), { baseURL: 'https://api.example.com/v1', authMode: 'none' });
  for (const changes of [
    { temperature: -0.1 }, { temperature: 2.1 }, { temperature: '0.5' }, { temperature: NaN },
    { topP: -0.1 }, { topP: 1.1 }, { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 },
    { maxOutputTokens: 32769 }, { systemPrompt: 'x'.repeat(8001) }, { userPrompt: '没有原文占位符' }
  ]) assert.throws(() => normalizeConfig(config(changes)));
  const advanced = harness();
  const options = { systemPrompt: '只优化表达。', userPrompt: '原文：{{text}}\n再次引用：{{text}}',
    temperature: 0, topP: 0.8, maxOutputTokens: 128 };
  assert.equal((await advanced.save(options)).success, true);
  advanced.reopen();
  const restored = (await advanced.send({ action: 'getPromptEnhancementConfig' })).config;
  for (const [field, value] of Object.entries(options)) assert.equal(restored[field], value);
  assert.equal((await advanced.enhance('价格 $& / {{text}}')).success, true);
  const enhancedBody = JSON.parse(advanced.calls.at(-1)[1].body);
  assert.deepEqual(enhancedBody.messages, [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: '原文：价格 $& / {{text}}\n再次引用：价格 $& / {{text}}' }
  ]);
  assert.equal(enhancedBody.temperature, 0);
  assert.equal(enhancedBody.top_p, 0.8);
  assert.equal(enhancedBody.max_completion_tokens, 128);
  assert.equal((await advanced.send({ action: 'testPromptEnhancementConfig', config: config({ temperature: 2 }) })).success, true);
  const testedBody = JSON.parse(advanced.calls.at(-1)[1].body);
  assert.equal(testedBody.temperature, 0);
  assert.equal(testedBody.messages[0].content, options.systemPrompt);
  assert.equal(testedBody.top_p, 0.8);
  assert.equal(testedBody.max_completion_tokens, 128);
  await advanced.save({ temperature: '', topP: null, maxOutputTokens: '', systemPrompt: '', userPrompt: '' });
  await advanced.enhance('原文');
  const defaultBody = JSON.parse(advanced.calls.at(-1)[1].body);
  for (const field of ['temperature', 'top_p', 'max_completion_tokens']) assert.equal(field in defaultBody, false);
  assert.equal(defaultBody.messages[1].content, '原文');

  const h = harness();
  assert.deepEqual(await h.send({ action: 'getPromptEnhancementConfig' }), { success: true, config: null, hasApiKey: false });
  for (const sender of [content, {}, { ...panel, id: 'other' }, { ...panel, url: panel.url + '?spoof=1' }, { ...panel, url: 'chrome-extension://test/src/save-selection/save-selection.html' }]) {
    assert.equal((await h.send({ action: 'getPromptEnhancementConfig' }, sender)).error, ERRORS.forbidden);
    assert.equal((await h.send({ action: 'savePromptEnhancementConfig', config: config(), apiKey: secret }, sender)).error, ERRORS.forbidden);
    assert.equal((await h.send({ action: 'listPromptEnhancementModels', config: config(), apiKey: secret }, sender)).error, ERRORS.forbidden);
    assert.equal((await h.send({ action: 'testPromptEnhancementConfig' }, sender)).error, ERRORS.forbidden);
  }
  assert.equal((await h.send({ action: 'testPromptEnhancementConfig', config: config(), apiKey: secret })).error, ERRORS.config, 'test does not accept unsaved overrides');
  assert.equal((await h.enhance()).error, ERRORS.config);
  const saved = await h.save();
  assert.equal(saved.hasApiKey, true);
  assert.equal('apiKey' in saved, false, 'saving never returns the credential to the settings page');
  assert.deepEqual(h.access, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.equal(JSON.stringify(h.local).includes(secret), false);
  assert.deepEqual(Object.keys(h.local), ['promptEnhancementConfig']);
  assert.equal(h.credentials.key.value, secret);
  assert.equal('promptEnhancementApiKey' in h.session, false);
  const read = await h.send({ action: 'getPromptEnhancementConfig' });
  assert.equal(read.hasApiKey, true);
  assert.equal('apiKey' in read, false, 'settings receive credential availability, never its value');
  for (const key of Object.keys(h.session)) delete h.session[key];
  h.reopen();
  assert.equal((await h.send({ action: 'getPromptEnhancementConfig' })).hasApiKey, true);
  await h.enhance();
  assert.equal(h.calls.at(-1)[1].headers.Authorization, `Bearer ${secret}`, 'reopening reuses the persistent key in the background');
  assert.equal((await h.save({ baseURL: 'https://api.example.com/new-path' }, '')).hasApiKey, true);
  assert.equal((await h.save({ baseURL: 'https://other.example.com/v1' }, '')).error, ERRORS.missingKey);
  assert.equal(h.local.promptEnhancementConfig.baseURL, 'https://api.example.com/new-path', 'rejected save preserves the previous configuration');
  assert.equal((await h.save({ baseURL: 'https://other.example.com/v1', authMode: 'none' }, '')).hasApiKey, false);
  assert.equal('promptEnhancementApiKey' in h.session, false, 'new origin never reuses the prior key');
  assert.equal('key' in h.credentials, false, 'new origins delete persistent credentials');
  await h.save({ baseURL: 'http://localhost:8000/v1' });
  assert.equal((await h.save({ baseURL: 'http://localhost:8001/v1' }, '')).error, ERRORS.missingKey, 'different ports are different credential origins');
  assert.equal((await h.save({ baseURL: 'http://localhost:8001/v1', authMode: 'none' }, '')).hasApiKey, false);
  await h.save();
  assert.equal((await h.save({}, '', true)).hasApiKey, false);
  assert.equal((await h.enhance()).error, ERRORS.missingKey);
  await h.save();
  delete h.credentials.key;
  assert.equal((await h.send({ action: 'getPromptEnhancementConfig' })).hasApiKey, false, 'missing credentials do not delete non-sensitive config');
  assert.equal((await h.enhance()).error, ERRORS.missingKey);
  const migrated = harness({ local: { promptEnhancementConfig: config() }, session: { promptEnhancementApiKey: { origin: 'https://api.example.com', value: secret } } });
  assert.equal((await migrated.send({ action: 'getPromptEnhancementConfig' })).hasApiKey, true);
  assert.equal(migrated.credentials.key.value, secret);
  assert.equal('promptEnhancementApiKey' in migrated.session, false);
  migrated.reopen();
  assert.equal((await migrated.send({ action: 'getPromptEnhancementConfig' })).hasApiKey, true);
  await migrated.enhance();
  assert.equal(migrated.calls.at(-1)[1].headers.Authorization, `Bearer ${secret}`);
  const stale = harness({ local: { promptEnhancementConfig: config() }, session: { promptEnhancementApiKey: { origin: 'https://other.example.com', value: secret } } });
  assert.equal((await stale.send({ action: 'getPromptEnhancementConfig' })).hasApiKey, false);
  assert.equal('key' in stale.credentials, false);
  const failedMigration = harness({ local: { promptEnhancementConfig: config() }, session: { promptEnhancementApiKey: { origin: 'https://api.example.com', value: secret } } });
  failedMigration.keyStore.set = async () => { throw new Error(secret); };
  assert.deepEqual(await failedMigration.send({ action: 'getPromptEnhancementConfig' }), { success: false, error: ERRORS.storage });
  assert.equal(failedMigration.session.promptEnhancementApiKey.value, secret, 'failed persistence preserves the old session key for retry');
  assert.equal('key' in failedMigration.credentials, false);
  assert.equal('promptEnhancementApiKey' in stale.session, false);
  for (const key of ['has space', 'bad\r\nkey', 'x'.repeat(513)]) assert.equal((await h.save({}, key)).error, ERRORS.key);
  const failedSave = harness();
  await failedSave.save();
  const previousSettings = await failedSave.send({ action: 'getPromptEnhancementConfig' });
  const previousCredentials = structuredClone(failedSave.credentials);
  const setKey = failedSave.keyStore.set;
  failedSave.keyStore.set = async () => { throw new Error(secret); };
  assert.deepEqual(await failedSave.save({ baseURL: 'https://other.example.com/v1' }, 'replacement-key'), { success: false, error: ERRORS.storage });
  assert.deepEqual(await failedSave.send({ action: 'getPromptEnhancementConfig' }), previousSettings, 'failed key writes preserve the previous configuration and key');
  failedSave.keyStore.set = setKey;
  const removeKey = failedSave.keyStore.remove;
  failedSave.keyStore.remove = async () => { throw new Error(secret); };
  assert.deepEqual(await failedSave.save({}, '', true), { success: false, error: ERRORS.storage });
  assert.deepEqual(await failedSave.send({ action: 'getPromptEnhancementConfig' }), previousSettings, 'failed key deletion preserves the previous configuration and key');
  failedSave.keyStore.remove = removeKey;
  const setConfig = failedSave.chrome.storage.local.set;
  failedSave.chrome.storage.local.set = async () => { throw new Error(secret); };
  assert.deepEqual(await failedSave.save({ baseURL: 'https://other.example.com/v1' }, 'replacement-key'), { success: false, error: ERRORS.storage });
  assert.deepEqual(failedSave.credentials, previousCredentials, 'failed config writes roll back the origin-bound key');
  assert.deepEqual(await failedSave.send({ action: 'getPromptEnhancementConfig' }), previousSettings);
  assert.deepEqual(await failedSave.save({}, '', true), { success: false, error: ERRORS.storage });
  assert.deepEqual(await failedSave.send({ action: 'getPromptEnhancementConfig' }), previousSettings, 'failed config writes roll back credential clearing');
  failedSave.chrome.storage.local.set = setConfig;
  assert.equal((await failedSave.enhance()).success, true);
  assert.equal(failedSave.calls.at(-1)[0], 'https://api.example.com/v1/chat/completions');
  assert.equal(failedSave.calls.at(-1)[1].headers.Authorization, `Bearer ${secret}`);

  await h.save();
  const unsavedKey = 'sk-unsaved-private-key';
  const unsavedConfig = { baseURL: 'https://unsaved.example.com/v1/', authMode: 'bearer' };
  const list = (changes = {}, apiKey = unsavedKey) => h.send({ action: 'listPromptEnhancementModels', config: { ...unsavedConfig, ...changes }, apiKey });
  const unchanged = structuredClone({ local: h.local, credentials: h.credentials });
  h.respond(async () => new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'zeta' }] })));
  assert.deepEqual(await list(), { success: true, models: ['alpha', 'zeta'] });
  const [modelsURL, modelsRequest] = h.calls.at(-1);
  assert.equal(modelsURL, 'https://unsaved.example.com/v1/models');
  assert.equal(modelsRequest.method, 'GET');
  assert.equal(modelsRequest.headers.Authorization, `Bearer ${unsavedKey}`);
  assert.equal('body' in modelsRequest, false);
  assert.equal(modelsRequest.redirect, 'error');
  assert.equal(modelsRequest.credentials, 'omit');
  assert.equal(modelsRequest.referrer, '');
  assert.equal(modelsRequest.referrerPolicy, 'no-referrer');
  assert.deepEqual({ local: h.local, credentials: h.credentials }, unchanged, 'listing never saves draft configuration or credentials');
  assert.equal((await list({}, '')).error, ERRORS.missingKey, 'different origins cannot reuse saved credentials');
  assert.equal((await list({ baseURL: 'https://api.example.com/other-path' }, '')).success, true);
  assert.equal(h.calls.at(-1)[1].headers.Authorization, `Bearer ${secret}`, 'model listing reuses the same-origin key without exposing it');
  assert.equal((await h.send({ action: 'listPromptEnhancementModels', config: config(), apiKey: '', clearApiKey: true })).error, ERRORS.missingKey);
  assert.equal((await h.send({ action: 'listPromptEnhancementModels', config: config(), apiKey: '', clearApiKey: 'yes' })).error, ERRORS.key);
  assert.equal((await list({ baseURL: 'https://api.example.com/other-path' }, unsavedKey)).success, true);
  assert.equal(h.calls.at(-1)[1].headers.Authorization, `Bearer ${unsavedKey}`, 'a replacement key takes precedence without being saved');
  assert.equal((await list({}, 'bad key')).error, ERRORS.key);
  assert.equal((await list({ baseURL: 'https://name:password@example.com' })).error, ERRORS.url);
  h.grant(false);
  assert.equal((await list()).error, ERRORS.permission);
  h.grant(true);
  assert.equal((await list({ authMode: 'none' }, '')).success, true);
  assert.equal('Authorization' in h.calls.at(-1)[1].headers, false);
  for (const [respond, expected] of [
    [async () => new Response(unsavedKey, { status: 401 }), ERRORS.auth],
    [async () => new Response(unsavedKey, { status: 403 }), ERRORS.auth],
    [async () => new Response(unsavedKey, { status: 429 }), ERRORS.rate],
    ...[404, 405, 501].map(status => [async () => new Response(unsavedKey, { status }), ERRORS.modelsUnavailable]),
    [async () => new Response(unsavedKey, { status: 500 }), ERRORS.server],
    [async () => new Response(unsavedKey, { status: 400 }), ERRORS.http],
    [async () => new Response(unsavedKey), ERRORS.json],
    [async () => new Response('{}'), ERRORS.models],
    [async () => new Response('{"data":{}}'), ERRORS.models],
    [async () => new Response('{"data":[]}'), ERRORS.modelsEmpty],
    ...[null, {}, { id: 4 }, { id: '' }, { id: ' ' }, { id: 'bad\nmodel' }, { id: 'x'.repeat(201) }].map(item => [async () => new Response(JSON.stringify({ data: [item] })), ERRORS.models]),
    [async () => new Response(JSON.stringify({ data: [{ id: unsavedKey }] })), ERRORS.secret],
    [async () => new Response('x', { headers: { 'content-length': '262145' } }), ERRORS.large],
    [async () => new Response('x'.repeat(262145)), ERRORS.large],
    [async () => { throw new Error(unsavedKey); }, ERRORS.network]
  ]) {
    h.respond(respond);
    const count = h.calls.length;
    assert.deepEqual(await list(), { success: false, error: expected });
    assert.equal(h.calls.length, count + 1, 'model listing does not retry');
  }
  h.respond(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error(unsavedKey)), { once: true });
  }));
  assert.equal((await list()).error, ERRORS.timeout);

  h.respond(async () => completion('OK'));
  const tested = await h.send({ action: 'testPromptEnhancementConfig', config: { ...unsavedConfig, model: 'wrong-model' }, apiKey: unsavedKey, text: secret });
  assert.deepEqual(tested, { success: true, model: 'test-model' });
  const [testURL, testRequest] = h.calls.at(-1);
  assert.equal(testURL, 'https://api.example.com/v1/chat/completions');
  assert.equal(testRequest.method, 'POST');
  assert.equal(testRequest.headers.Authorization, `Bearer ${secret}`);
  assert.equal(JSON.parse(testRequest.body).model, 'test-model');
  assert.equal(JSON.parse(testRequest.body).stream, true);
  assert.equal(testRequest.body.includes(secret), false);
  assert.deepEqual({ local: h.local, credentials: h.credentials }, unchanged);
  h.grant(false);
  assert.equal((await h.send({ action: 'testPromptEnhancementConfig' })).error, ERRORS.permission);
  h.grant(true);
  for (const [respond, expected] of [
    [async () => new Response(secret, { status: 401 }), ERRORS.auth],
    [async () => new Response(secret, { status: 403 }), ERRORS.auth],
    [async () => new Response(secret, { status: 429 }), ERRORS.rate],
    [async () => new Response(secret, { status: 404 }), ERRORS.modelUnavailable],
    [async () => new Response(secret, { status: 500 }), ERRORS.server],
    [async () => new Response(secret, { status: 400 }), ERRORS.http],
    [async () => new Response(secret), ERRORS.json],
    [async () => new Response('{}'), ERRORS.json],
    [async () => completion(' '), ERRORS.empty],
    [async () => completion('partial', 'length'), ERRORS.truncated],
    [async () => completion('blocked', 'content_filter'), ERRORS.truncated],
    [async () => completion('x'.repeat(MAX_RESULT + 1)), ERRORS.large],
    [async () => new Response('x'.repeat(262145), { headers: { 'Content-Type': 'text/event-stream' } }), ERRORS.large],
    [async () => completion(secret), ERRORS.secret],
    [async () => { throw new Error(secret); }, ERRORS.network]
  ]) {
    h.respond(respond);
    const count = h.calls.length;
    assert.deepEqual(await h.send({ action: 'testPromptEnhancementConfig' }), { success: false, error: expected });
    assert.equal(h.calls.length, count + 1, 'saved configuration tests do not retry');
  }
  h.respond(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
  }));
  assert.equal((await h.send({ action: 'testPromptEnhancementConfig' })).error, ERRORS.timeout);
  await h.save({}, '', true);
  assert.equal((await h.send({ action: 'testPromptEnhancementConfig', apiKey: unsavedKey })).error, ERRORS.missingKey);
  await h.save();
  h.respond(async () => completion());

  await h.save();
  h.grant(false);
  assert.equal((await h.save()).error, ERRORS.permission);
  assert.equal((await h.enhance()).error, ERRORS.permission);
  h.grant(true);
  const result = await h.enhance('请保留 foo_bar()', content, { baseURL: 'https://attacker.test', apiKey: 'evil', config: config({ baseURL: 'https://attacker.test' }) });
  assert.equal(result.text, '更清晰的提示词');
  const [url, request] = h.calls.at(-1);
  assert.equal(url, 'https://api.example.com/v1/chat/completions');
  assert.equal(request.headers.Authorization, `Bearer ${secret}`);
  assert.equal(request.redirect, 'error');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.referrer, '');
  assert.equal(request.referrerPolicy, 'no-referrer');
  const body = JSON.parse(request.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, true);
  assert.equal(body.messages[1].content, '请保留 foo_bar()');
  assert.equal(request.body.includes(secret), false);
  assert.equal(h.permissions.at(-1).origins[0], 'https://api.example.com/*');
  const beforeInvalid = h.calls.length;
  for (const text of ['', ' ', null, 'x'.repeat(MAX_TEXT + 1)]) assert.equal((await h.enhance(text)).error, ERRORS.text);
  for (const sender of [panel, {}, { ...content, id: 'wrong' }, { ...content, url: 'https://evil.example.com/' }, { ...content, url: 'https://chatgpt.com.evil.example.com/' }, { ...content, frameId: -1 }]) {
    assert.equal((await h.enhance('text', sender)).error, ERRORS.forbidden);
  }
  assert.equal(h.calls.length, beforeInvalid);

  for (const [respond, expected] of [
    [async () => new Response(secret, { status: 401 }), ERRORS.auth],
    [async () => new Response(secret, { status: 403 }), ERRORS.auth],
    [async () => new Response(secret, { status: 429 }), ERRORS.rate],
    [async () => new Response(secret, { status: 404 }), ERRORS.modelUnavailable],
    [async () => new Response(secret, { status: 500 }), ERRORS.server],
    [async () => new Response(secret, { status: 400 }), ERRORS.http],
    [async () => new Response(secret), ERRORS.json],
    [async () => new Response('{}'), ERRORS.json],
    [async () => completion(' '), ERRORS.empty],
    [async () => completion('partial', 'length'), ERRORS.truncated],
    [async () => completion('blocked', 'content_filter'), ERRORS.truncated],
    [async () => completion('x'.repeat(MAX_RESULT + 1)), ERRORS.large],
    [async () => new Response('x', { headers: { 'content-length': '262145' } }), ERRORS.large],
    [async () => new Response('x'.repeat(262145), { headers: { 'Content-Type': 'text/event-stream' } }), ERRORS.large],
    [async () => completion(`leaked ${secret}`), ERRORS.secret],
    [async () => { throw new Error(secret); }, ERRORS.network]
  ]) {
    h.respond(respond);
    const count = h.calls.length;
    const response = await h.enhance();
    assert.equal(response.success, false);
    assert.equal(response.error, expected);
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(h.calls.length, count + 1, 'failed requests must not retry');
  }
  h.respond(async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error(secret)), { once: true });
  }));
  assert.equal((await h.enhance()).error, ERRORS.timeout);
  h.respond(async () => completion());
  assert.equal((await h.enhance()).success, true, 'finally releases failed/timed-out requests');

  const blockers = [];
  h.respond(() => new Promise(resolve => { blockers.push(resolve); }));
  const first = h.enhance();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.enhance()).error, ERRORS.duplicate);
  const secondFrame = h.enhance('frame text', { ...content, frameId: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(blockers.length, 2, 'independent frames are not blocked');
  blockers.forEach(resolve => resolve(completion()));
  assert.equal((await first).success, true);
  assert.equal((await secondFrame).success, true);
  await h.save({ authMode: 'none' }, '');
  h.respond(async () => completion());
  assert.equal((await h.enhance()).success, true);
  assert.equal('Authorization' in h.calls.at(-1)[1].headers, false);
  assert.deepEqual(await h.send({ action: 'testPromptEnhancementConfig' }), { success: true, model: 'test-model' });
  assert.equal('Authorization' in h.calls.at(-1)[1].headers, false);
  h.respond(async () => completion(secret));
  assert.equal((await h.enhance()).error, ERRORS.secret, 'retained keys are protected even in no-auth mode');
  assert.equal((await h.send({ action: 'testPromptEnhancementConfig' })).error, ERRORS.secret, 'test never returns provider output or retained credentials');
  assert.equal(JSON.stringify(h.local).includes(secret), false);
  assert.equal(JSON.stringify(h.session).includes(secret), false);

  await h.save();
  const encoder = new TextEncoder();
  const sse = chunks => new Response(new ReadableStream({ start(controller) {
    chunks.forEach(chunk => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const utf8 = encoder.encode(event({ choices: [{ delta: { content: '中文🙂' }, finish_reason: 'stop' }] }) + 'data: [DONE]\r\n\r\n');
  h.respond(async () => sse(Array.from(utf8, byte => new Uint8Array([byte]))));
  const split = h.stream();
  assert.deepEqual(await split.result, { success: true, text: '中文🙂' });
  assert.equal(split.messages.filter(msg => msg.type === 'delta').map(msg => msg.text).join(''), '中文🙂');
  for (const newline of ['\n', '\r', '\r\n']) {
    const wire = (event({ choices: [{ delta: { content: '换行兼容🙂' }, finish_reason: 'stop' }] }) +
      'data: [DONE]\r\n\r\n').replaceAll('\r\n', newline);
    h.respond(async () => sse(Array.from(encoder.encode(wire), byte => new Uint8Array([byte]))));
    assert.deepEqual(await h.enhance(), { success: true, text: '换行兼容🙂' }, 'single-byte chunks with ' + JSON.stringify(newline));
  }
  h.respond(async () => sse([
    event({ choices: [{ delta: { content: 'safe ' + secret.slice(0, 8) } }] }),
    event({ choices: [{ delta: { content: secret.slice(8) }, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n'
  ]));
  const leak = h.stream();
  assert.equal((await leak.result).error, ERRORS.secret);
  assert.equal(leak.messages.filter(msg => msg.type === 'delta').map(msg => msg.text).join(''), 'safe ');
  for (const raw of [event({ choices: [{ delta: { content: 'incomplete' } }] }),
    event({ choices: [{ delta: { content: 'unfinished' }, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n']) {
    h.respond(async () => sse([raw]));
    assert.equal((await h.enhance()).error, ERRORS.truncated);
  }
  let aborted = false;
  h.respond(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(event({ choices: [{ delta: { content: 'first part' } }] })));
    options.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); }, { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const cancelled = h.stream();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled.messages[0].text, 'first part', 'preview arrives before completion');
  assert.equal(cancelled.messages.some(msg => msg.type === 'done'), false);
  cancelled.cancel();
  assert.equal(aborted, true, 'disconnect immediately aborts the active fetch');
  h.respond(async () => completion('after cancellation'));
  assert.equal((await h.enhance()).text, 'after cancellation', 'cancel releases the page for another request');
  assert.equal(cancelled.messages.some(msg => msg.type === 'done'), false);
  h.respond(async (_url, options) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(event({ choices: [{ delta: { content: 'before timeout' } }] })));
    options.signal.addEventListener('abort', () => controller.error(new Error('timeout')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const timedStream = h.stream();
  assert.equal((await timedStream.result).error, ERRORS.timeout);
  assert.equal(timedStream.messages.some(msg => msg.type === 'done'), false);
  const originalGet = h.chrome.storage.local.get;
  let releaseConfig;
  h.chrome.storage.local.get = () => new Promise(resolve => { releaseConfig = resolve; });
  const beforeCancel = h.calls.length;
  const earlyCancel = h.stream();
  await new Promise(resolve => setImmediate(resolve));
  earlyCancel.cancel();
  h.chrome.storage.local.get = originalGet;
  releaseConfig({ promptEnhancementConfig: config() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, beforeCancel, 'cancelling during configuration read never starts fetch');
  h.respond(async () => sse([event({ error: { message: secret } })]));
  assert.equal((await h.enhance()).error, ERRORS.server);
  console.log('prompt enhancement behavior and security tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
