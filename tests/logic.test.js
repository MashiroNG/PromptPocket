const assert = require('node:assert/strict');
const logic = require('../sidepanel-logic.js');

function idFactory(prefix = 'safe') {
  let index = 0;
  return () => `${prefix}_${++index}`;
}

function titles(entries) {
  return entries.map(entry => entry.prompt ? entry.prompt.title : entry.title);
}

{
  const imported = logic.normalizeImportedFolders([
    {
      id: 'bad id<script>',
      name: '导入文件夹',
      prompts: [
        { id: 'safe_prompt', title: '保留安全 ID', text: '内容' },
        { id: 'safe_prompt', title: '重复 ID', text: '内容 2' },
        { id: 'x"] [data-action="use', title: '', text: '' }
      ]
    }
  ], idFactory('id'));

  assert.equal(imported.length, 1);
  assert.equal(imported[0].id, 'id_1');
  assert.equal(imported[0].prompts[0].id, 'safe_prompt');
  assert.equal(imported[0].prompts[1].id, 'id_2');
  assert.equal(imported[0].prompts[2].id, 'id_3');
  assert.equal(imported[0].prompts[2].title, '未命名提示词');
}

{
  assert.throws(
    () => logic.normalizeImportedFolders({ folders: [] }, idFactory()),
    /文件夹数组/
  );
}

{
  const current = [
    {
      id: 'folder_a',
      name: '淘宝',
      prompts: [
        { id: 'prompt_a', title: '同名提示词', text: '同样内容' }
      ]
    }
  ];
  const imported = [
    {
      id: 'other_folder_id',
      name: '淘宝',
      prompts: [
        { id: 'prompt_a', title: '同名提示词', text: '同样内容' },
        { id: 'prompt_a', title: '新提示词', text: '新内容' }
      ]
    },
    {
      id: 'folder_b',
      name: '主图生成',
      prompts: [
        { id: 'prompt_b', title: '主图', text: '生成主图' }
      ]
    }
  ];

  const result = logic.mergeImportedFolders(current, imported, idFactory('merged'));
  assert.equal(result.addedFolders, 1);
  assert.equal(result.addedPrompts, 2);
  assert.equal(result.skippedPrompts, 1);
  assert.deepEqual(result.folders.map(folder => folder.name), ['淘宝', '主图生成']);
  assert.deepEqual(result.folders[0].prompts.map(prompt => prompt.id), ['prompt_a', 'merged_1']);
}

{
  const report = logic.getCleanupReport([
    {
      id: 'folder_a',
      name: '淘宝',
      prompts: [
        { id: 'p1', title: '空', text: '   ' },
        { id: 'p2', title: '重复 1', text: 'Hello   World' },
        { id: 'p3', title: '重复 2', text: 'hello world' }
      ]
    }
  ]);

  assert.equal(report.all.length, 3);
  assert.equal(report.empty.length, 1);
  assert.equal(report.duplicateGroups.length, 1);
  assert.equal(report.duplicateExtras, 1);
}

{
  const folders = [
    {
      id: 'f1',
      name: '淘宝主图',
      prompts: [
        { id: 'p1', title: '优化标题', text: '生成电商主图', pinned: true },
        { id: 'p2', title: '普通文案', text: '写详情页', pinned: false }
      ]
    },
    {
      id: 'f2',
      name: '视频',
      prompts: [
        { id: 'p3', title: '视频脚本', text: '生成主图视频脚本', pinned: true }
      ]
    }
  ];

  assert.deepEqual(
    titles(logic.getPromptSearchResults({ folders, folderFilterId: 'all', tokens: logic.getSearchTokens('生成 主图'), pinnedOnly: false })),
    ['优化标题', '视频脚本']
  );
  assert.deepEqual(
    titles(logic.getPromptSearchResults({ folders, folderFilterId: 'f1', tokens: logic.getSearchTokens('生成 主图'), pinnedOnly: false })),
    ['优化标题']
  );
  assert.deepEqual(
    titles(logic.getPromptSearchResults({ folders, folderFilterId: 'all', tokens: [], pinnedOnly: true })),
    ['优化标题', '视频脚本']
  );
}

{
  const folders = [
    {
      id: 'f1',
      name: 'A',
      prompts: [
        { id: 'a1', title: '旧快捷', text: '1', quickAt: '2026-01-01T00:00:00.000Z' },
        { id: 'a2', title: '新快捷', text: '2', quickAt: '2026-02-01T00:00:00.000Z' }
      ]
    },
    {
      id: 'f2',
      name: 'B',
      prompts: [
        { id: 'b1', title: '置顶', text: '3', pinned: true, pinnedAt: '2026-03-01T00:00:00.000Z' },
        { id: 'b2', title: '普通', text: '4' }
      ]
    }
  ];

  assert.deepEqual(
    logic.getQuickPromptItems(folders, 'all', '').map(item => item.title),
    ['新快捷', '旧快捷', '置顶', '普通']
  );
  assert.deepEqual(
    logic.getQuickPromptItems(folders, 'pinned', '').map(item => item.title),
    ['置顶']
  );
  assert.deepEqual(
    logic.getQuickPromptItems(folders, 'folder', 'f2').map(item => item.title),
    ['置顶', '普通']
  );
}

{
  assert.equal(logic.getPromptPocketPlatform('chatgpt.com'), 'chatgpt');
  assert.equal(logic.getPromptPocketPlatform('chat.openai.com'), 'chatgpt');
  assert.equal(logic.getPromptPocketPlatform('gemini.google.com'), 'gemini');
  assert.equal(logic.getPromptPocketPlatform('example.com'), '');
  assert.equal(logic.isChatGptConversationContext({ hostname: 'chatgpt.com', pathname: '/', hasPlanText: false }), true);
  assert.equal(logic.isChatGptConversationContext({ hostname: 'chatgpt.com', pathname: '/c/abc', hasPlanText: false }), true);
  assert.equal(logic.isChatGptConversationContext({ hostname: 'chatgpt.com', pathname: '/g/g-abc/c/def', hasPlanText: false }), true);
  assert.equal(logic.isChatGptConversationContext({ hostname: 'chatgpt.com', pathname: '/pricing', hasPlanText: false }), false);
  assert.equal(logic.isChatGptConversationContext({ hostname: 'chatgpt.com', pathname: '/', hasPlanText: true }), false);
  assert.equal(logic.isGeminiConversationContext({ hostname: 'gemini.google.com', pathname: '/app' }), true);
}

{
  const position = logic.computeQuickLauncherPosition({
    composerRect: { left: 88, right: 812, top: 620, bottom: 690, width: 724, height: 70 },
    buttonRect: { width: 92, height: 42 },
    viewport: { width: 1040, height: 820 },
    actionCenterY: 662
  });
  assert.equal(position.left, 828);
  assert.equal(position.top, 641);

  const fallback = logic.computeQuickLauncherPosition({
    composerRect: { left: 40, right: 960, top: 500, bottom: 650, width: 920, height: 150 },
    buttonRect: { width: 92, height: 42 },
    viewport: { width: 1000, height: 700 }
  });
  assert.equal(fallback.left, 854);
  assert.equal(fallback.top, 593);
}

console.log('logic tests passed');
