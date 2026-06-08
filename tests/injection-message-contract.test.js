const assert = require('node:assert/strict');
const routing = require('../injection-routing.js');

function createTabsChannel({
  runtime,
  handler,
  loseResponses = 0,
  alwaysFail = false
}) {
  const calls = [];
  return {
    calls,
    sendMessage(tabId, message, options, callback) {
      calls.push({
        tabId,
        message: structuredClone(message),
        options: structuredClone(options)
      });

      if (alwaysFail) {
        runtime.lastError = { message: 'No receiver' };
        callback(undefined);
        runtime.lastError = null;
        return;
      }

      Promise.resolve(handler(message)).then((response) => {
        if (loseResponses > 0) {
          loseResponses -= 1;
          runtime.lastError = { message: 'Response channel closed' };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        callback(response);
      });
    }
  };
}

async function run() {
  for (const platform of ['chatgpt', 'gemini']) {
    let adapterCalls = 0;
    const contentHandler = routing.createInjectionMessageHandler(
      async (receivedPlatform, text) => {
        adapterCalls += 1;
        assert.equal(receivedPlatform, platform);
        assert.equal(text, `${platform} prompt`);
        return true;
      }
    );
    const runtime = { lastError: null };
    const tabs = createTabsChannel({ runtime, handler: contentHandler });
    const message = {
      action: 'injectPrompt',
      platform,
      text: `${platform} prompt`,
      requestId: `${platform}-request`
    };

    const result = await routing.sendInjectionMessageWithRetry(
      { tabs, runtime, schedule: (fn) => fn() },
      {
        tabId: 42,
        message,
        attempts: 8,
        delayMs: 600,
        frameId: 0
      }
    );

    assert.equal(result, true);
    assert.equal(adapterCalls, 1);
    assert.deepEqual(tabs.calls[0].options, { frameId: 0 });
  }

  {
    const contentHandler = routing.createInjectionMessageHandler(async () => true);
    const runtime = { lastError: null };
    const tabs = createTabsChannel({ runtime, handler: contentHandler });
    const message = {
      action: 'injectPrompt',
      platform: 'gemini',
      text: 'Sub-frame prompt',
      requestId: 'sub-frame-request'
    };

    assert.equal(await routing.sendInjectionMessageWithRetry(
      { tabs, runtime, schedule: (fn) => fn() },
      {
        tabId: 7,
        message,
        attempts: 1,
        delayMs: 600,
        frameId: 12
      }
    ), true);
    assert.deepEqual(tabs.calls[0].options, { frameId: 12 });
  }

  {
    let adapterCalls = 0;
    const contentHandler = routing.createInjectionMessageHandler(async () => {
      adapterCalls += 1;
      return true;
    });
    const runtime = { lastError: null };
    const tabs = createTabsChannel({
      runtime,
      handler: contentHandler,
      loseResponses: 1
    });
    const message = {
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'Retry prompt',
      requestId: 'stable-request-id'
    };

    const result = await routing.sendInjectionMessageWithRetry(
      { tabs, runtime, schedule: (fn) => fn() },
      {
        tabId: 9,
        message,
        attempts: 2,
        delayMs: 600,
        frameId: 0
      }
    );

    assert.equal(result, true);
    assert.equal(tabs.calls.length, 2);
    assert.equal(tabs.calls[0].message.requestId, 'stable-request-id');
    assert.equal(tabs.calls[1].message.requestId, 'stable-request-id');
    assert.equal(adapterCalls, 1);
  }

  {
    let adapterCalls = 0;
    const contentHandler = routing.createInjectionMessageHandler(async () => {
      adapterCalls += 1;
      return false;
    });
    const runtime = { lastError: null };
    const tabs = createTabsChannel({ runtime, handler: contentHandler });
    const message = {
      action: 'injectPrompt',
      platform: 'gemini',
      text: 'Rejected prompt',
      requestId: 'rejected-request'
    };

    const result = await routing.sendInjectionMessageWithRetry(
      { tabs, runtime, schedule: (fn) => fn() },
      {
        tabId: 10,
        message,
        attempts: 8,
        delayMs: 600,
        frameId: 0
      }
    );

    assert.equal(result, false);
    assert.equal(tabs.calls.length, 1);
    assert.equal(adapterCalls, 1);
  }

  {
    const runtime = { lastError: null };
    const tabs = createTabsChannel({
      runtime,
      handler: () => Promise.resolve({ success: true }),
      alwaysFail: true
    });
    const message = {
      action: 'injectPrompt',
      platform: 'chatgpt',
      text: 'Unavailable prompt',
      requestId: 'unavailable-request'
    };

    const result = await routing.sendInjectionMessageWithRetry(
      { tabs, runtime, schedule: (fn) => fn() },
      {
        tabId: 11,
        message,
        attempts: 3,
        delayMs: 600,
        frameId: 0
      }
    );

    assert.equal(result, false);
    assert.equal(tabs.calls.length, 3);
  }

  console.log('injection message contract tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
