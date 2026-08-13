const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'save-selection.html'), 'utf8');
const stylesheet = fs.readFileSync(path.join(root, 'save-selection.css'), 'utf8');
const script = fs.readFileSync(path.join(root, 'save-selection.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'save-selection-theme.js'), 'utf8');

assert.match(
  background,
  /popupUrl\.searchParams\.set\('theme', prepared\.theme\)/,
  '保存窗口 URL 应携带当前主题'
);
assert.match(
  html,
  /<script src="save-selection-theme\.js"><\/script>/,
  '保存页应加载首帧主题脚本'
);
assert.ok(
  html.indexOf('<script src="save-selection-theme.js"></script>') < html.indexOf('<link rel="stylesheet"'),
  '首帧主题脚本应在样式解析前执行'
);
assert.match(
  bootstrap,
  /new URLSearchParams\(location\.search\)\.get\('theme'\)/,
  '首帧主题脚本应读取 URL 中的主题'
);
assert.match(
  stylesheet,
  /html\.theme-light/,
  '浅色变量应由首帧可用的 html 主题类控制'
);
assert.match(
  script,
  /document\.documentElement\.classList\.toggle\('theme-light'/,
  '保存页应继续响应运行时主题变化'
);

console.log('save selection theme contract tests passed');
