const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../src/shared/sidepanel-logic.js');
const routing = require('../src/shared/injection-routing.js');

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
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const contentScript = manifest.content_scripts[0];

    assert.equal(contentScript.all_frames, true);
    assert.deepEqual(contentScript.js, [
      'src/shared/sidepanel-logic.js',
      'src/shared/injection-routing.js',
      'src/content.js'
    ]);
  }

  console.log('injection routing tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
