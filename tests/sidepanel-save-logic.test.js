const assert = require('node:assert/strict');
const { reconcileFolderCommit } = require('../sidepanel-save-logic.js');

{
  const result = reconcileFolderCommit({
    folders: [{ id: 'folder_b', name: 'B', prompts: [] }],
    revision: 4,
    selectedFolderId: 'folder_a'
  });

  assert.equal(result.revision, 4);
  assert.equal(result.selectedFolderId, 'folder_b');
  assert.equal(result.folders[0].name, 'B');
}

{
  const result = reconcileFolderCommit({
    folders: [],
    revision: 2,
    selectedFolderId: 'missing'
  });

  assert.equal(result.selectedFolderId, null);
}

console.log('sidepanel save logic tests passed');
