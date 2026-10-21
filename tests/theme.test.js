const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
  const classes = new Set();
  const saved = {};
  const context = vm.createContext({
    sidepanelTheme: 'light',
    document: {
      body: { classList: { toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      } } },
      getElementById: () => null
    },
    chrome: { storage: { local: {
      get: async defaults => ({ ...defaults, ...saved }),
      set: async values => Object.assign(saved, values)
    } } }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/sidepanel/sidepanel-runtime.js'), 'utf8'), context);

  await context.loadTheme();
  assert.equal(classes.has('theme-light'), true, '首次打开应为亮色');
  await context.toggleTheme();
  assert.equal(classes.has('theme-light'), false);
  assert.equal(saved.sidepanelTheme, 'dark');
  await context.loadTheme();
  assert.equal(classes.has('theme-light'), false, '重开应保留手动选择的深色');
  await context.toggleTheme();
  assert.equal(classes.has('theme-light'), true);
  assert.equal(saved.sidepanelTheme, 'light');

  const bootstrap = fs.readFileSync(path.join(__dirname, '../src/save-selection/save-selection-theme.js'), 'utf8');
  for (const [search, light] of [['', true], ['?theme=light', true], ['?theme=dark', false]]) {
    let actual;
    vm.runInNewContext(bootstrap, {
      URLSearchParams,
      location: { search },
      document: { documentElement: { classList: { toggle: (_name, enabled) => { actual = enabled; } } } }
    });
    assert.equal(actual, light, `保存页首帧主题 ${search || '(默认)'}`);
  }
  console.log('theme tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
