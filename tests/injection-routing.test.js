const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../sidepanel-logic.js');
const routing = require('../injection-routing.js');

async function run() {
  {
    const chatgpt = routing.createInjectionRequest(
      'https://chatgpt.com/c/example',
      'ChatGPT prompt'
    );
    const gemini = routing.createInjectionRequest(
      'https://gemini.google.com/app/example',
      'Gemini prompt'
    );

    assert.equal(chatgpt.platform, 'chatgpt');
    assert.equal(chatgpt.message.action, 'injectPrompt');
    assert.equal(chatgpt.message.platform, 'chatgpt');
    assert.equal(chatgpt.message.text, 'ChatGPT prompt');
    assert.match(chatgpt.message.requestId, /\S/);

    assert.equal(gemini.platform, 'gemini');
    assert.equal(gemini.message.action, 'injectPrompt');
    assert.equal(gemini.message.platform, 'gemini');
    assert.equal(gemini.message.text, 'Gemini prompt');
    assert.match(gemini.message.requestId, /\S/);
    assert.notEqual(chatgpt.message.requestId, gemini.message.requestId);
  }

  {
    assert.equal(
      routing.createInjectionRequest('https://example.com/', 'Unsupported'),
      null
    );
    assert.equal(routing.createInjectionRequest('not a URL', 'Invalid'), null);
    assert.equal(routing.createInjectionRequest('https://chatgpt.com/', ''), null);
    assert.equal(routing.createInjectionRequest('https://gemini.google.com/', '   \n'), null);
  }

  {
    assert.deepEqual(routing.createSendMessageOptions(undefined), { frameId: 0 });
    assert.deepEqual(routing.createSendMessageOptions(-1), { frameId: 0 });
    assert.deepEqual(routing.createSendMessageOptions(0), { frameId: 0 });
    assert.deepEqual(routing.createSendMessageOptions(12), { frameId: 12 });
  }

  {
    let calls = 0;
    const handler = routing.createInjectionMessageHandler(async () => {
      calls += 1;
      return true;
    });
    const message = {
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'One request',
      requestId: 'request-1'
    };

    assert.deepEqual(await handler(message), { success: true });
    assert.deepEqual(await handler(message), { success: true });
    assert.equal(calls, 1);
  }

  {
    let calls = 0;
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const handler = routing.createInjectionMessageHandler(async () => {
      calls += 1;
      await pending;
      return true;
    });
    const message = {
      action: 'injectPrompt',
      platform: 'gemini',
      text: 'Concurrent request',
      requestId: 'request-2'
    };

    const first = handler(message);
    const second = handler(message);
    assert.equal(calls, 1);
    finish();
    assert.deepEqual(await Promise.all([first, second]), [
      { success: true },
      { success: true }
    ]);
    assert.equal(calls, 1);
  }

  {
    const rejecting = routing.createInjectionMessageHandler(() => Promise.reject(new Error('failed')));
    assert.deepEqual(await rejecting({
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'Prompt',
      requestId: 'request-3'
    }), { success: false });

    const throwing = routing.createInjectionMessageHandler(() => {
      throw new Error('sync failure');
    });
    assert.deepEqual(await throwing({
      action: 'injectPrompt',
      platform: 'gemini',
      text: 'Prompt',
      requestId: 'request-4'
    }), { success: false });
  }

  {
    let calls = 0;
    const handler = routing.createInjectionMessageHandler(() => {
      calls += 1;
      return true;
    });
    const invalidMessages = [
      { action: 'injectPrompt', platform: 'unknown', text: 'Prompt', requestId: 'invalid-1' },
      { action: 'injectPrompt', platform: 'chatgpt', text: '', requestId: 'invalid-2' },
      { action: 'injectPrompt', platform: 'gemini', text: '   ', requestId: 'invalid-3' },
      { action: 'injectPrompt', platform: 'chatgpt', text: 'Prompt' }
    ];

    for (const message of invalidMessages) {
      assert.deepEqual(await handler(message), { success: false });
    }
    assert.equal(calls, 0);
  }

  {
    let calls = 0;
    const handler = routing.createInjectionMessageHandler(() => {
      calls += 1;
      return true;
    }, { maxEntries: 2 });

    for (let index = 1; index <= 3; index += 1) {
      await handler({
        action: 'injectPrompt',
        platform: 'chatgpt',
        text: `Prompt ${index}`,
        requestId: `bounded-${index}`
      });
    }
    await handler({
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'Prompt 1',
      requestId: 'bounded-1'
    });
    assert.equal(calls, 4);
  }

  {
    let calls = 0;
    let finishFirst;
    const firstPending = new Promise(resolve => { finishFirst = resolve; });
    const handler = routing.createInjectionMessageHandler(async (platform, text) => {
      calls += 1;
      if (text === 'First pending') await firstPending;
      return true;
    }, { maxEntries: 1 });
    const first = {
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'First pending',
      requestId: 'pending-1'
    };
    const second = {
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'Second complete',
      requestId: 'pending-2'
    };

    const firstResult = handler(first);
    await handler(second);
    const firstRetry = handler(first);
    assert.equal(calls, 2);
    finishFirst();
    assert.deepEqual(await Promise.all([firstResult, firstRetry]), [
      { success: true },
      { success: true }
    ]);
    assert.equal(calls, 2);
  }

  {
    const root = path.resolve(__dirname, '..');
    const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
    const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
    const routingSource = fs.readFileSync(path.join(root, 'injection-routing.js'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const contentScript = manifest.content_scripts[0];

    assert.equal(contentScript.all_frames, true);
    assert.deepEqual(contentScript.js, [
      'sidepanel-logic.js',
      'injection-routing.js',
      'content.js'
    ]);
    assert.doesNotMatch(background, /\btryPasteInTab\b/);
    assert.doesNotMatch(background, /\btryFocusGemini\b/);
    assert.doesNotMatch(background, /document\.querySelector/);
    assert.doesNotMatch(background, /\bMutationObserver\b/);
    assert.doesNotMatch(background, /document\.execCommand/);
    assert.doesNotMatch(background, /\bInputEvent\b/);
    assert.doesNotMatch(background, /contenteditable|prompt-textarea|ql-editor/);
    assert.doesNotMatch(background, /injectGemini/);
    assert.match(content, /createInjectionMessageHandler/);
    assert.match(content, /injectTextViaAdapter/);
    assert.match(routingSource, /getPromptPocketPlatform/);
    assert.doesNotMatch(routingSource, /chatgpt\.com|chat\.openai\.com|gemini\.google\.com/);

    const fallbackMatch = background.match(
      /async function copyPromptFallback\(text, url\) \{([\s\S]*?)\n\}/
    );
    assert.ok(fallbackMatch, 'copy-only fallback helper must exist');
    assert.doesNotMatch(fallbackMatch[1], /tryAutoPasteInTab|createInjectionRequest|sendMessageWithRetry/);

    const handlePromptMatch = background.match(
      /async function handlePromptCopy\(promptId, text\) \{([\s\S]*?)\n\}\n\nasync function handleSelectionCommandCopy/
    );
    assert.ok(handlePromptMatch, 'handlePromptCopy must exist');
    assert.equal((handlePromptMatch[1].match(/tryAutoPasteInTab/g) || []).length, 1);
    assert.match(handlePromptMatch[1], /copyPromptFallback\(text, url\)/);

    const promptBranchMatch = background.match(
      /if \(promptMatch\) \{([\s\S]*?)\n  \}\n\}\);/
    );
    assert.ok(promptBranchMatch, 'context-menu prompt branch must exist');
    assert.equal((promptBranchMatch[1].match(/tryAutoPasteInTab/g) || []).length, 1);
    assert.doesNotMatch(promptBranchMatch[1], /handlePromptCopy/);
    assert.match(promptBranchMatch[1], /copyPromptFallback\(prompt\.text, url\)/);
  }

  console.log('injection routing tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
