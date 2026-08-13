const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const savePage = fs.readFileSync(path.join(root, 'save-selection.js'), 'utf8');

const resources = (manifest.web_accessible_resources || [])
  .flatMap(entry => Array.isArray(entry.resources) ? entry.resources : []);

assert.ok(resources.includes('save-selection.html'), '保存页应允许嵌入支持的网站');
assert.match(content, /function openSaveSelectionModal\(/);
assert.match(content, /attachShadow\(\{ mode: 'open' \}\)/);
assert.match(content, /embedded', '1'/);
assert.match(content, /msg\.action === 'showSaveSelection'/);
assert.match(background, /async function prepareSaveSelectionDraft\(/);
assert.match(background, /action: 'showSaveSelection'/);
assert.match(background, /openSaveSelectionWindow\(/, '注入失败时应保留原生窗口降级');
assert.match(savePage, /const isEmbeddedSavePage/);
assert.match(savePage, /window\.parent\.postMessage/);

console.log('save selection overlay contract tests passed');
