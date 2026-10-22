const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });

async function run() {
  const onOpened = event();
  const onClosed = event();
  const onMessage = event();
  let panels = [{ windowId: 1 }];
  const session = {};
  const sent = [];
  const background = vm.createContext({
    console, setTimeout, clearTimeout, URL, TextDecoder, AbortController,
    chrome: {
      runtime: {
        getURL: file => `chrome-extension://test/${file}`,
        getContexts: async filter => panels.filter(panel => filter.windowIds.includes(panel.windowId)),
        onInstalled: event(), onConnect: event(), onMessage
      },
      sidePanel: { onOpened, onClosed },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => session, set: async values => Object.assign(session, values), setAccessLevel: async () => {} },
        onChanged: event()
      },
      contextMenus: { onClicked: event() },
      tabs: {
        query: async ({ windowId }) => [{ id: windowId * 10 }],
        sendMessage: async (tabId, message) => { sent.push({ tabId, message }); }
      }
    }
  });
  background.importScripts = (...files) => files.forEach(file => vm.runInContext(source(`src/${file}`), background));
  vm.runInContext(source('src/background.js'), background);
  const state = windowId => new Promise(resolve => {
    const handled = onMessage.listeners.some(listener => listener({ action: 'getSidePanelState' }, { tab: { windowId } }, resolve) === true);
    assert.equal(handled, true, '后台必须响应侧边栏状态查询');
  });
  assert.equal((await state(1)).open, true, '刷新网页应识别同窗口已打开的侧边栏');
  assert.equal((await state(2)).open, false, '其他窗口不应隐藏悬浮按钮');

  let initialResponse;
  const contentMessages = event();
  const nodes = new Map();
  const content = vm.createContext({
    console, setTimeout: () => 1, setInterval: () => 1, clearTimeout,
    cancelAnimationFrame: () => {},
    location: { hostname: 'example.com', pathname: '/', href: 'https://example.com/' },
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: id => nodes.get(id) || null },
    chrome: {
      runtime: { id: 'test', onMessage: contentMessages, sendMessage: (_message, callback) => { initialResponse = callback; } },
      storage: { onChanged: event() }
    }
  });
  vm.runInContext(source('src/shared/sidepanel-logic.js'), content);
  vm.runInContext(source('src/shared/injection-routing.js'), content);
  vm.runInContext(source('src/content.js'), content);
  vm.runInContext(`
    let restored = 0;
    ensureQuickLauncherForCurrentComposer = () => { restored++; };
  `, content);
  const receive = message => contentMessages.listeners.forEach(fn => fn(message, {}, () => {}));
  const addUi = () => ['simplest-prompt-quick-launcher', 'simplest-prompt-quick-panel'].forEach(id => {
    nodes.set(id, { remove: () => nodes.delete(id) });
  });
  addUi();
  await onOpened.listeners[0]({ windowId: 1 });
  receive(sent.pop().message);
  assert.equal(nodes.size, 0, '展开侧边栏应移除悬浮按钮和已打开的快捷浮窗');
  initialResponse({ open: false });
  assert.equal(vm.runInContext('sidePanelOpen', content), true, '迟到的初始化结果不能覆盖展开事件');
  addUi();
  content.positionQuickLauncher({ isConnected: true });
  assert.equal(nodes.size, 0, '焦点、点击和尺寸变化不能重新显示按钮');

  panels = [];
  assert.equal((await state(1)).open, true, '上下文暂不可用时，刷新仍应保留展开状态');
  await onClosed.listeners[0]({ windowId: 1 });
  receive(sent.pop().message);
  assert.equal(vm.runInContext('restored', content), 1, '关闭侧边栏后应重新寻找输入框并恢复按钮');
  assert.equal((await state(1)).open, false);
  console.log('sidepanel visibility tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
