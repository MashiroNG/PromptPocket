(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PromptPocketInjectionRouting = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  let fallbackRequestId = 0;

  function getPlatformFromUrl(url) {
    try {
      const logic = root && root.PromptPocketLogic;
      if (!logic || typeof logic.getPromptPocketPlatform !== 'function') return '';
      return logic.getPromptPocketPlatform(new URL(String(url || '')).hostname || '');
    } catch (error) {
      return '';
    }
  }

  function createRequestId() {
    const cryptoApi = root && root.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID();
    }
    fallbackRequestId += 1;
    return `inject_${Date.now().toString(36)}_${fallbackRequestId.toString(36)}`;
  }

  function createInjectionRequest(url, text) {
    const value = String(text || '');
    if (!value.trim()) return null;
    const platform = getPlatformFromUrl(url);
    if (!platform) return null;
    return {
      platform,
      message: {
        action: 'injectPrompt',
        platform,
        text: value,
        requestId: createRequestId()
      }
    };
  }

  function createSendMessageOptions(frameId) {
    return {
      frameId: Number.isInteger(frameId) && frameId >= 0 ? frameId : 0
    };
  }

  function isValidInjectionMessage(message) {
    if (!message || message.action !== 'injectPrompt') return false;
    if (message.platform !== 'chatgpt' && message.platform !== 'gemini') return false;
    if (typeof message.requestId !== 'string' || !message.requestId.trim()) return false;
    return typeof message.text === 'string' && !!message.text.trim();
  }

  function createInjectionMessageHandler(inject, options) {
    const inFlight = new Map();
    const completed = new Map();
    const requestedLimit = options && options.maxEntries;
    const maxEntries = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : 100;

    return function handleInjectionMessage(message) {
      if (!isValidInjectionMessage(message) || typeof inject !== 'function') {
        return Promise.resolve({ success: false });
      }

      if (inFlight.has(message.requestId)) return inFlight.get(message.requestId);
      if (completed.has(message.requestId)) {
        return Promise.resolve(completed.get(message.requestId));
      }

      let resolveResult;
      const pending = new Promise(resolve => {
        resolveResult = resolve;
      });
      inFlight.set(message.requestId, pending);

      (async () => {
        let response;
        try {
          response = {
            success: await inject(message.platform, message.text) === true
          };
        } catch (error) {
          response = { success: false };
        }

        inFlight.delete(message.requestId);
        completed.set(message.requestId, response);
        while (completed.size > maxEntries) {
          completed.delete(completed.keys().next().value);
        }
        resolveResult(response);
      })();

      return pending;
    };
  }

  return {
    getPlatformFromUrl,
    createInjectionRequest,
    createSendMessageOptions,
    createInjectionMessageHandler
  };
});
