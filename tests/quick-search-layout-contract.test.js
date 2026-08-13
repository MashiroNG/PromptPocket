const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

assert.match(
  content,
  /function isPromptPocketUiTarget\(/,
  '内容脚本应能识别插件自身 UI'
);
assert.match(
  content,
  /if \(isPromptPocketUiTarget\(start\)\) return null;/,
  '平台适配器不应把快捷搜索框识别成聊天输入框'
);
assert.match(
  content,
  /'height:min\(390px,calc\(100vh - 20px\)\)'/,
  '快捷弹窗应保持稳定高度，避免筛选结果改变整体位置'
);
assert.match(
  content,
  /renderQuickPromptList\(event\.target\.value \|\| ''\);\s*positionQuickPanel\(\);/,
  '搜索重绘后应重新锚定快捷弹窗'
);

console.log('quick search layout contract tests passed');
