const assert = require('node:assert/strict');
const { captureSelection, replaceSelection, open } = require('../src/selection-enhancement.js');

const input = {
  value: '前缀：怎么写邮件？ 后缀', tagName: 'TEXTAREA', selectionStart: 3, selectionEnd: 9,
  isConnected: true, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
};
const doc = { activeElement: input, getSelection: () => null };
input.ownerDocument = doc;
const snapshot = captureSelection(doc);
assert.equal(snapshot.text, '怎么写邮件？');
input.value = '用户已修改';
assert.throws(() => replaceSelection(snapshot, '再次替换'), /原文已变化/);
input.readOnly = true;
assert.equal(captureSelection(doc).editable, false);
assert.throws(() => replaceSelection(captureSelection(doc), '改写'), /不能替换/);
input.readOnly = false;
input.setSelectionRange(0, 0);
let requests = 0;
let notice = '';
open({ doc, runtime: { connect: () => requests++ }, notice: text => { notice = text; } });
assert.equal(requests, 0);
assert.match(notice, /请先选中/);

let replacement = null;
const range = { commonAncestorContainer: { nodeType: 1, closest: () => null }, toString: () => '只读网页选文', cloneRange() { return this; } };
doc.getSelection = () => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range });
assert.equal(captureSelection(doc).editable, false);
assert.throws(() => replaceSelection(captureSelection(doc), '改写'), /不能替换/);
const editor = { isContentEditable: true, isConnected: true, innerHTML: '<p>原文</p>', contains: () => true, focus() {}, ownerDocument: doc };
range.commonAncestorContainer.closest = () => editor;
range.startContainer = {};
range.endContainer = {};
const richSnapshot = captureSelection(doc);
doc.getSelection = () => ({ removeAllRanges() {}, addRange(value) { replacement = value; } });
doc.execCommand = (command, _showUi, text) => { assert.equal(command, 'insertText'); assert.equal(text, '增强文本'); return true; };
replaceSelection(richSnapshot, '增强文本');
assert.equal(replacement, range);
editor.innerHTML = '<p>用户已编辑</p>';
assert.throws(() => replaceSelection(richSnapshot, '增强文本'), /原文或选区已变化/);
assert.equal(editor.innerHTML, '<p>用户已编辑</p>');
console.log('selection enhancement tests passed');
