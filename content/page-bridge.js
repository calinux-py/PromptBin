(function promptBinPageBridge() {
  if (window.__promptbinPageBridgeLoaded) {
    return;
  }

  Object.defineProperty(window, "__promptbinPageBridgeLoaded", {
    value: true,
    configurable: false,
    enumerable: false
  });

  const STATE = {
    promptMap: {},
    promptPattern: null,
    armedUntil: 0
  };

  const MARKER = "__promptbinBridgePatched";

  function normalizeTag(input) {
    if (!input) {
      return "";
    }

    const compact = String(input).trim().replace(/\s+/g, "");
    const withoutPrefix = compact.replace(/^\/+/, "");
    if (!withoutPrefix) {
      return "";
    }

    return `//${withoutPrefix.toLowerCase()}`;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function compileTagPattern(tags) {
    const normalized = [...new Set(tags.map(normalizeTag).filter(Boolean))];
    if (!normalized.length) {
      return null;
    }

    normalized.sort((left, right) => right.length - left.length);
    const alternation = normalized.map(escapeRegExp).join("|");
    return new RegExp(`(?<![A-Za-z0-9_/-])(${alternation})(?![A-Za-z0-9_-])`, "gi");
  }

  function replaceKnownTags(text) {
    if (!text || !STATE.promptPattern) {
      return text;
    }

    if (!String(text).includes("//")) {
      return text;
    }

    return String(text).replace(
      STATE.promptPattern,
      (tag) => STATE.promptMap[tag.toLowerCase()] ?? tag
    );
  }

  function replaceStructuredStrings(value, seen = new WeakSet()) {
    if (typeof value === "string") {
      return replaceKnownTags(value);
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return value;
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => replaceStructuredStrings(item, seen));
    }

    const next = {};
    Object.entries(value).forEach(([key, nestedValue]) => {
      next[key] = replaceStructuredStrings(nestedValue, seen);
    });
    return next;
  }

  function isArmed() {
    const domArmedUntil = Number(document.documentElement?.dataset.promptbinArmedUntil ?? 0);
    return Date.now() <= Math.max(STATE.armedUntil, domArmedUntil);
  }

  function replaceBody(body, contentType = "") {
    if (!body || !isArmed() || !STATE.promptPattern) {
      return body;
    }

    if (typeof body === "string") {
      if (!body.includes("//")) {
        return body;
      }

      const looksLikeJson = contentType.toLowerCase().includes("application/json") || /^[\[{]/.test(body.trim());
      if (!looksLikeJson) {
        return replaceKnownTags(body);
      }

      try {
        const parsed = JSON.parse(body);
        return JSON.stringify(replaceStructuredStrings(parsed));
      } catch (_error) {
        return replaceKnownTags(body);
      }
    }

    if (body instanceof URLSearchParams) {
      const next = new URLSearchParams();
      let changed = false;
      for (const [key, value] of body.entries()) {
        const replacement = replaceKnownTags(value);
        next.append(key, replacement);
        changed ||= replacement !== value;
      }
      return changed ? next : body;
    }

    if (body instanceof FormData) {
      const next = new FormData();
      let changed = false;
      for (const [key, value] of body.entries()) {
        const replacement = typeof value === "string" ? replaceKnownTags(value) : value;
        next.append(key, replacement);
        changed ||= replacement !== value;
      }
      return changed ? next : body;
    }

    return body;
  }

  function canInspectRequests() {
    return isArmed() && STATE.promptPattern !== null;
  }

  function patchFetch() {
    if (window.fetch[MARKER]) {
      return;
    }

    const originalFetch = window.fetch;

    window.fetch = async function promptBinFetch(input, init) {
      let nextInput = input;
      let nextInit = init;

      try {
        if (canInspectRequests()) {
          if (init?.body != null) {
            const fallbackHeaders = input instanceof Request ? input.headers : {};
            const headers = new Headers(init.headers || fallbackHeaders);
            const contentType = headers.get("content-type") ?? "";
            const replacedBody = replaceBody(init.body, contentType);

            if (replacedBody !== init.body) {
              nextInit = {
                ...init,
                body: replacedBody
              };
            }
          } else if (input instanceof Request) {
            const contentType = input.headers.get("content-type") ?? "";
            const cloned = input.clone();
            const originalBody = await cloned.text();
            const replacedBody = replaceBody(originalBody, contentType);

            if (replacedBody !== originalBody) {
              nextInput = new Request(input, {
                body: replacedBody
              });
            }
          }
        }
      } catch (_error) {
        // Never block the host request if a body cannot be cloned or decoded.
      }

      return originalFetch.call(this, nextInput, nextInit);
    };

    window.fetch[MARKER] = true;
  }

  function patchXhr() {
    if (XMLHttpRequest.prototype.send[MARKER]) {
      return;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function promptBinOpen(method, url, async, user, password) {
      this.__promptbinContentType = "";
      return originalOpen.call(this, method, url, async, user, password);
    };

    XMLHttpRequest.prototype.setRequestHeader = function promptBinSetRequestHeader(header, value) {
      if (String(header).toLowerCase() === "content-type") {
        this.__promptbinContentType = value;
      }
      return originalSetRequestHeader.call(this, header, value);
    };

    XMLHttpRequest.prototype.send = function promptBinSend(body) {
      let nextBody = body;

      try {
        nextBody = replaceBody(body, this.__promptbinContentType ?? "");
      } catch (_error) {
        // Preserve native XHR behavior when a body type cannot be inspected.
      }

      return originalSend.call(this, nextBody);
    };

    XMLHttpRequest.prototype.send[MARKER] = true;
  }

  function patchWebSocket() {
    if (!window.WebSocket || window.WebSocket.prototype.send[MARKER]) {
      return;
    }

    const originalSend = window.WebSocket.prototype.send;

    window.WebSocket.prototype.send = function promptBinWebSocketSend(data) {
      let nextData = data;

      try {
        if (typeof data === "string") {
          nextData = replaceBody(data, "");
        }
      } catch (_error) {
        // Preserve native WebSocket behavior for unsupported payloads.
      }

      return originalSend.call(this, nextData);
    };

    window.WebSocket.prototype.send[MARKER] = true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "promptbin-extension") {
      return;
    }

    if (event.data.type === "promptbin/library") {
      STATE.promptMap = event.data.payload?.promptMap ?? {};
      STATE.promptPattern = compileTagPattern(Object.keys(STATE.promptMap));
    }

    if (event.data.type === "promptbin/arm") {
      const ttlMs = Math.max(750, Number(event.data.payload?.ttlMs ?? 3500));
      STATE.armedUntil = Date.now() + ttlMs;
    }
  });

  patchFetch();
  patchXhr();
  patchWebSocket();

  window.postMessage(
    {
      source: "promptbin-page",
      type: "promptbin/ready"
    },
    "*"
  );
})();
