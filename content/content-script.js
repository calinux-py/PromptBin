(function promptBinContentScript() {
  const BRIDGE_SOURCE = "promptbin-extension";
  const PAGE_SOURCE = "promptbin-page";
  const DEFAULT_TAG_COLOR = "#F6B17A";
  let promptMap = {};
  let promptPattern = null;
  let promptBodies = new Set();
  let tagsWithLongerMatch = new Set();
  let settings = {
    compactTags: true,
    enableTripleSlash: true,
    expandOnTab: true
  };
  let activeEditor = null;
  let editorDecorator = null;
  let expansionInProgress = false;
  let decorationsSuspended = false;
  const expansionSuppressedEditors = new WeakSet();
  const pendingEditorTasks = new WeakMap();

  function afterEditorTransaction(editor, callback) {
    const pendingTask = pendingEditorTasks.get(editor);
    if (pendingTask !== undefined) {
      window.clearTimeout(pendingTask);
    }

    const task = window.setTimeout(() => {
      if (pendingEditorTasks.get(editor) !== task) {
        return;
      }

      pendingEditorTasks.delete(editor);
      if (editor.isConnected) {
        callback();
      }
    }, 0);

    pendingEditorTasks.set(editor, task);
  }

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

  function escapeHtml(value) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function getMatches(text) {
    if (!promptPattern || !text) {
      return [];
    }

    const matches = [];
    String(text).replace(promptPattern, (tag, _match, offset) => {
      matches.push({
        tag,
        index: offset,
        length: tag.length
      });
      return tag;
    });

    return matches;
  }

  function isKnownPromptBody(text) {
    if (!text) {
      return false;
    }

    return promptBodies.has(text);
  }

  function hasExpandedPromptWithTagPrefix(text) {
    if (!text) {
      return false;
    }

    return Object.entries(promptMap).some(([tag, prompt]) => {
      if (!prompt || !tag || !text.startsWith(tag)) {
        return false;
      }

      const remainder = text.slice(tag.length);
      return remainder === prompt || remainder.startsWith(prompt);
    });
  }

  function shouldHideCompactDecorations(text) {
    return isKnownPromptBody(text) || hasExpandedPromptWithTagPrefix(text);
  }

  function getCompactDisplayMatches(text) {
    if (shouldHideCompactDecorations(text)) {
      return [];
    }

    return getMatches(text);
  }

  function contentEditableTextBeforeCaret(editor) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    if (!editor.contains(range.endContainer)) {
      return null;
    }

    const beforeCaret = range.cloneRange();
    beforeCaret.selectNodeContents(editor);
    beforeCaret.setEnd(range.endContainer, range.endOffset);
    return beforeCaret.toString();
  }

  function textPosition(editor, offset) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let remaining = Math.max(0, offset);
    let node = walker.nextNode();

    while (node) {
      if (remaining <= node.data.length) {
        return { node, offset: remaining };
      }
      remaining -= node.data.length;
      node = walker.nextNode();
    }

    return { node: editor, offset: editor.childNodes.length };
  }

  function replaceEditorRange(editor, start, end, replacement, token, trailing) {
    expansionInProgress = true;
    // Rich editors can synchronously emit input and mutation callbacks while
    // replacing the shortcut, and controlled editors may commit their DOM on
    // a later task. Suppress this specific editor before touching its value so
    // none of those callbacks can recreate an overlay from the old //tag.
    expansionSuppressedEditors.add(editor);
    teardownDecorators();
    let nativeInputDispatched = false;
    let replacementApplied = false;

    if (editor instanceof HTMLTextAreaElement) {
      editor.focus();
      editor.setRangeText(replacement, start, end, "end");
      replacementApplied = true;
    } else {
      const selection = window.getSelection();
      const originalRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

      if (selection?.modify && originalRange) {
        for (let index = 0; index < trailing.length; index += 1) {
          selection.modify("move", "backward", "character");
        }
        for (let index = 0; index < token.length; index += 1) {
          selection.modify("extend", "backward", "character");
        }

        if (selection.toString() === token) {
          if (editor.dataset.lexicalEditor === "true") {
            // Lexical owns an immutable editor model and treats execCommand's
            // input as a dangling DOM mutation. Send the replacement through
            // its controlled beforeinput path so both model and DOM update in
            // one editor transaction. The event option makes Lexical import
            // the DOM selection we established above before inserting text.
            const replacementEvent = new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              composed: true,
              inputType: "insertReplacementText",
              data: replacement
            });
            editor.dispatchEvent(replacementEvent);
            nativeInputDispatched = replacementEvent.defaultPrevented;
            replacementApplied = nativeInputDispatched;
          } else {
            nativeInputDispatched = document.execCommand("insertText", false, replacement);
            replacementApplied = nativeInputDispatched;
          }

          if (!nativeInputDispatched && selection.rangeCount) {
            const selectedRange = selection.getRangeAt(0);
            selectedRange.deleteContents();
            const textNode = document.createTextNode(replacement);
            selectedRange.insertNode(textNode);
            selectedRange.setStartAfter(textNode);
            selectedRange.collapse(true);
            selection.removeAllRanges();
            selection.addRange(selectedRange);
            replacementApplied = true;
          }
        } else {
          selection.removeAllRanges();
          selection.addRange(originalRange);
        }
      }

      if (!replacementApplied) {
        // The selection-based path above preserves rich-editor structure. This
        // offset fallback covers basic contenteditables without Selection.modify.
        if (selection) {
          if (originalRange) {
            selection.removeAllRanges();
            selection.addRange(originalRange);
          }
          const startPosition = textPosition(editor, start);
          const endPosition = textPosition(editor, end);
          const range = document.createRange();
          range.setStart(startPosition.node, startPosition.offset);
          range.setEnd(endPosition.node, endPosition.offset);
          range.deleteContents();
          const textNode = document.createTextNode(replacement);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          replacementApplied = true;
        }
      }
    }

    if (replacementApplied && !nativeInputDispatched) {
      editor.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertReplacementText",
          data: replacement
        })
      );
    }
    expansionInProgress = false;

    if (!replacementApplied) {
      expansionSuppressedEditors.delete(editor);
    }

    if (activeEditor === editor && editor.isConnected) {
      refreshDecorations();
    }

    return replacementApplied;
  }

  function shortcutAtCaret(editor, forceDoubleSlash = false) {
    if (!isEditableElement(editor) || expansionInProgress) {
      return null;
    }

    const caret = editor instanceof HTMLTextAreaElement ? editor.selectionStart : null;
    const beforeCaret = editor instanceof HTMLTextAreaElement
      ? editor.value.slice(0, caret)
      : contentEditableTextBeforeCaret(editor);
    if (beforeCaret === null || (editor instanceof HTMLTextAreaElement && caret !== editor.selectionEnd)) {
      return null;
    }

    const match = beforeCaret.match(/(^|[^A-Za-z0-9_\/-])(\/{2,3}[A-Za-z0-9][A-Za-z0-9_-]*)([^A-Za-z0-9_-]?)$/i);
    if (!match) {
      return null;
    }

    const token = match[2];
    const isTripleSlash = token.startsWith("///");
    if ((isTripleSlash && !settings.enableTripleSlash) || (!isTripleSlash && settings.compactTags && !forceDoubleSlash)) {
      return null;
    }

    const tag = normalizeTag(token);
    const prompt = promptMap[tag];
    if (!prompt) {
      return null;
    }

    const trailing = match[3] ?? "";
    if (!trailing && tagsWithLongerMatch.has(tag) && !forceDoubleSlash) {
      return null;
    }

    const tokenEnd = beforeCaret.length - trailing.length;
    const tokenStart = tokenEnd - token.length;
    return { prompt, tag, token, tokenEnd, tokenStart, trailing };
  }

  function expandShortcutAtCaret(editor, forceDoubleSlash = false) {
    const shortcut = shortcutAtCaret(editor, forceDoubleSlash);
    if (!shortcut) {
      return false;
    }

    const { prompt, tag, token, tokenEnd, tokenStart, trailing } = shortcut;
    if (!replaceEditorRange(editor, tokenStart, tokenEnd, prompt, token, trailing)) {
      return false;
    }

    recordPromptUsage([tag]);
    return true;
  }

  function editorText(editor) {
    if (!editor) {
      return "";
    }

    if (editor instanceof HTMLTextAreaElement) {
      return editor.value || "";
    }

    if (editor.isContentEditable) {
      return editor.innerText || editor.textContent || "";
    }

    return "";
  }

  function isEditableElement(node) {
    return resolveEditableElement(node) !== null;
  }

  function resolveEditableElement(node) {
    if (!node) {
      return null;
    }

    if (node instanceof HTMLTextAreaElement) {
      return node;
    }

    if (node instanceof Element) {
      if (node.isContentEditable) {
        return node;
      }

      const editable = node.closest('[contenteditable="true"], textarea');
      if (editable instanceof HTMLTextAreaElement || editable?.isContentEditable) {
        return editable;
      }
    }

    return null;
  }

  function isElementVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function pushLibraryToPage() {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "promptbin/library",
        payload: {
          promptMap
        }
      },
      "*"
    );
  }

  function armBridge(ttlMs = 3500) {
    // DOM attributes cross Chrome's isolated-world boundary synchronously. This
    // must be set before the page handles the same Enter/click event.
    document.documentElement.dataset.promptbinArmedUntil = String(Date.now() + ttlMs);

    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "promptbin/arm",
        payload: {
          ttlMs
        }
      },
      "*"
    );
  }

  async function request(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({
      type,
      payload
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "PromptBin request failed.");
    }

    return response.data;
  }

  function recordPromptUsage(tags) {
    request("promptbin/markUsed", { tags }).catch(() => {
      // Usage metadata must never interfere with editing or submission.
    });
  }

  function installStyles() {
    document.getElementById("promptbin-content-styles")?.remove();

    const style = document.createElement("style");
    style.id = "promptbin-content-styles";
    style.dataset.promptbinRevision = "post-lexical-transaction";
    style.textContent = `
      .promptbin-overlay {
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        overflow: hidden;
        color: transparent;
        white-space: pre-wrap;
        word-break: break-word;
        background: transparent;
      }

      .promptbin-overlay[hidden] {
        display: none !important;
      }

      .promptbin-overlay:not([hidden]) {
        display: block !important;
      }

      .promptbin-overlay__inner {
        min-height: 100%;
        color: transparent;
        -webkit-text-fill-color: transparent;
        white-space: inherit;
        word-break: inherit;
      }

      .promptbin-overlay__tag {
        display: inline;
        color: var(--promptbin-tag-color, #F6B17A) !important;
        -webkit-text-fill-color: var(--promptbin-tag-color, #F6B17A) !important;
        background: transparent;
        box-shadow: none;
        border-radius: 0;
        margin: 0;
        padding: 0;
        font-weight: inherit;
      }
    `;
    document.documentElement.appendChild(style);
  }

  class EditorDecorator {
    constructor(editor) {
      this.editor = editor;
      this.overlay = document.createElement("div");
      this.overlay.className = "promptbin-overlay";
      this.overlay.hidden = true;
      this.inner = document.createElement("div");
      this.inner.className = "promptbin-overlay__inner";
      this.overlay.appendChild(this.inner);
      document.documentElement.appendChild(this.overlay);
      this.pendingDeletionText = null;
      this.sync = this.sync.bind(this);
      this.handleScroll = this.handleScroll.bind(this);

      this.mutationObserver = null;
      if (editor.isContentEditable) {
        this.mutationObserver = new MutationObserver(this.sync);
        this.mutationObserver.observe(editor, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }

      editor.addEventListener("scroll", this.handleScroll, true);
      window.addEventListener("resize", this.sync, true);
      document.addEventListener("scroll", this.sync, true);
      this.sync();
    }

    destroy() {
      this.editor.removeEventListener("scroll", this.handleScroll, true);
      window.removeEventListener("resize", this.sync, true);
      document.removeEventListener("scroll", this.sync, true);
      this.mutationObserver?.disconnect();
      this.hide();
      this.overlay.remove();
    }

    hide() {
      this.overlay.hidden = true;
      this.inner.textContent = "";
    }

    prepareForDeletion() {
      this.pendingDeletionText = editorText(this.editor);
      this.hide();
    }

    render() {
      const text = editorText(this.editor);

      if (
        decorationsSuspended ||
        expansionSuppressedEditors.has(this.editor) ||
        !settings.compactTags
      ) {
        this.hide();
        return;
      }

      // Some controlled contenteditables dispatch input before their rendered
      // DOM commits. Never repaint the exact text that Backspace is replacing.
      // Once the value changes, normal matching resumes immediately.
      if (this.pendingDeletionText !== null) {
        if (text === this.pendingDeletionText) {
          this.hide();
          return;
        }
        this.pendingDeletionText = null;
      }

      const matches = getCompactDisplayMatches(text);

      if (!matches.length) {
        this.hide();
        return;
      }

      const chunks = [];
      let cursor = 0;

      matches.forEach((match) => {
        const before = text.slice(cursor, match.index);
        const token = text.slice(match.index, match.index + match.length);
        if (before) {
          chunks.push(escapeHtml(before));
        }
        chunks.push(`<span class="promptbin-overlay__tag">${escapeHtml(token)}</span>`);
        cursor = match.index + match.length;
      });

      if (cursor < text.length) {
        chunks.push(escapeHtml(text.slice(cursor)));
      }

      this.inner.innerHTML = chunks.join("");
      this.overlay.hidden = false;
    }

    sync() {
      if (!this.editor.isConnected || !isElementVisible(this.editor)) {
        this.hide();
        return;
      }

      const rect = this.editor.getBoundingClientRect();
      const styles = window.getComputedStyle(this.editor);
      const borderTop = Number.parseFloat(styles.borderTopWidth) || 0;
      const borderRight = Number.parseFloat(styles.borderRightWidth) || 0;
      const borderBottom = Number.parseFloat(styles.borderBottomWidth) || 0;
      const borderLeft = Number.parseFloat(styles.borderLeftWidth) || 0;

      this.overlay.style.top = `${rect.top + borderTop}px`;
      this.overlay.style.left = `${rect.left + borderLeft}px`;
      this.overlay.style.width = `${Math.max(0, rect.width - borderLeft - borderRight)}px`;
      this.overlay.style.height = `${Math.max(0, rect.height - borderTop - borderBottom)}px`;
      this.overlay.style.padding = styles.padding;
      this.overlay.style.font = styles.font;
      this.overlay.style.letterSpacing = styles.letterSpacing;
      this.overlay.style.wordSpacing = styles.wordSpacing;
      this.overlay.style.lineHeight = styles.lineHeight;
      this.overlay.style.textIndent = styles.textIndent;
      this.overlay.style.textTransform = styles.textTransform;
      this.overlay.style.textAlign = styles.textAlign;
      this.overlay.style.borderRadius = styles.borderRadius;
      this.overlay.style.tabSize = styles.tabSize;
      this.overlay.style.direction = styles.direction;
      this.overlay.style.overflowWrap = styles.overflowWrap;
      this.overlay.style.wordBreak = styles.wordBreak;
      this.inner.style.transform = `translate(${-this.editor.scrollLeft}px, ${-this.editor.scrollTop}px)`;
      this.render();
    }

    handleScroll() {
      this.sync();
    }
  }

  function teardownDecorators() {
    if (editorDecorator) {
      editorDecorator.destroy();
      editorDecorator = null;
    }

    // Also remove an orphan left by an invalidated/older content-script
    // instance. An orphan has no live owner to hide it when settings change or
    // a shortcut expands, but it is still visible in the page DOM.
    document.querySelectorAll(".promptbin-overlay").forEach((overlay) => overlay.remove());
  }

  function refreshDecorations() {
    if (
      !activeEditor ||
      !activeEditor.isConnected ||
      decorationsSuspended ||
      expansionSuppressedEditors.has(activeEditor) ||
      !settings.compactTags ||
      !isElementVisible(activeEditor)
    ) {
      teardownDecorators();
      return;
    }

    const editorContent = editorText(activeEditor);

    if (shouldHideCompactDecorations(editorContent)) {
      teardownDecorators();
      return;
    }

    if (editorDecorator?.editor === activeEditor) {
      editorDecorator.sync();
      return;
    }

    teardownDecorators();
    editorDecorator = new EditorDecorator(activeEditor);
  }

  function setActiveEditor(element) {
    if (activeEditor === element) {
      refreshDecorations();
      return;
    }

    activeEditor = element;
    decorationsSuspended = false;
    refreshDecorations();
  }

  function onEditorChange(element) {
    if (!isEditableElement(element)) {
      return;
    }

    decorationsSuspended = false;
    setActiveEditor(element);
  }

  function resumeDecorationsForUserEdit(element, isTrusted) {
    // Expansion-generated input events run while expansionInProgress is true.
    // The next separate input event represents a new edit and may legitimately
    // introduce another compact shortcut, so decoration can resume then.
    if (!expansionInProgress && isTrusted) {
      expansionSuppressedEditors.delete(element);
    }
  }

  function onEditorBeforeInput(element, inputType) {
    if (!isEditableElement(element) || !inputType?.startsWith("delete")) {
      return;
    }

    if (activeEditor !== element) {
      setActiveEditor(element);
    }

    // beforeinput fires ahead of the browser's DOM/value update. Remove the
    // stale tag overlay now so Backspace feels immediate, then redraw once the
    // edit has been applied. The regular input handler remains the primary
    // update path; this frame callback covers editors that dispatch it late.
    if (editorDecorator?.editor === element) {
      editorDecorator.prepareForDeletion();
    }

    window.requestAnimationFrame(() => {
      if (activeEditor === element && element.isConnected) {
        refreshDecorations();
      }
    });
  }

  function maybeArmForSubmission() {
    if (!activeEditor) {
      return;
    }

    const matches = getMatches(editorText(activeEditor));
    if (!matches.length) {
      return;
    }

    decorationsSuspended = true;
    teardownDecorators();
    armBridge(3500);
    recordPromptUsage([...new Set(matches.map((match) => match.tag.toLowerCase()))]);
  }

  function nearActiveEditor(target) {
    if (!activeEditor || !(target instanceof Element)) {
      return false;
    }

    if (activeEditor.closest("form") && target.closest("form") === activeEditor.closest("form")) {
      return true;
    }

    const editorRect = activeEditor.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const horizontalGap = Math.abs(targetRect.left - editorRect.right);
    const verticalOverlap =
      targetRect.bottom >= editorRect.top - 120 && targetRect.top <= editorRect.bottom + 120;

    return horizontalGap < 320 && verticalOverlap;
  }

  async function reloadLibrary() {
    try {
      const snapshot = await request("promptbin/getLibrary");
      promptMap = snapshot.promptMap ?? {};
      const knownTags = Object.keys(promptMap);
      promptPattern = compileTagPattern(knownTags);
      promptBodies = new Set(Object.values(promptMap).filter(Boolean));
      tagsWithLongerMatch = new Set();
      knownTags.forEach((tag) => {
        for (let end = 3; end < tag.length; end += 1) {
          const prefix = tag.slice(0, end);
          if (Object.hasOwn(promptMap, prefix)) {
            tagsWithLongerMatch.add(prefix);
          }
        }
      });
      settings = {
        ...settings,
        ...(snapshot.settings ?? {})
      };
      document.documentElement.style.setProperty(
        "--promptbin-tag-color",
        snapshot.settings?.tagColor ?? DEFAULT_TAG_COLOR
      );
      pushLibraryToPage();
      refreshDecorations();
    } catch (_error) {
      // The extension context can disappear during an update; the host editor
      // must continue working without PromptBin until the page reloads.
    }
  }

  document.querySelectorAll(".promptbin-overlay").forEach((overlay) => overlay.remove());
  installStyles();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) {
      return;
    }

    if (event.data.type === "promptbin/ready") {
      pushLibraryToPage();
    }
  });

  document.addEventListener(
    "focusin",
    (event) => {
      const target = resolveEditableElement(event.target);
      if (!target || !isElementVisible(target)) {
        return;
      }

      setActiveEditor(target);
    },
    true
  );

  document.addEventListener(
    "beforeinput",
    (event) => {
      const target = resolveEditableElement(event.target);
      if (!target) {
        return;
      }
      onEditorBeforeInput(target, event.inputType);
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      const target = resolveEditableElement(event.target);
      if (!target) {
        return;
      }

      const generatedByExpansion = expansionInProgress;
      const isTrusted = event.isTrusted;

      // Observe input in capture so editors cannot hide changes with
      // stopPropagation, but defer mutation to the next task. Controlled
      // editors can finish both event handlers and queued microtask commits
      // first, avoiding stale-state and selection reconciliation in Lexical.
      afterEditorTransaction(target, () => {
        if (!generatedByExpansion) {
          resumeDecorationsForUserEdit(target, isTrusted);
          if (!expansionInProgress) {
            expandShortcutAtCaret(target);
          }
        }
        onEditorChange(target);
      });
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const target = resolveEditableElement(event.target);
      if (!target) {
        return;
      }

      // The input event redraws after text changes. Avoid a full decorator
      // sync on every keydown, where the editor still contains the old text.
      if (activeEditor !== target) {
        setActiveEditor(target);
      }

      if (event.isComposing) {
        return;
      }

      if (event.key === "Tab" && settings.expandOnTab && shortcutAtCaret(target, true)) {
        event.preventDefault();

        // Lexical completes selection and editor-state reconciliation in
        // microtasks queued by its keydown handlers. Run in the following task
        // so those commits cannot overwrite the replacement or stale caret.
        afterEditorTransaction(target, () => {
          expandShortcutAtCaret(target, true);
        });
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        maybeArmForSubmission();
      }
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (activeEditor && event.target instanceof Element && event.target.contains(activeEditor)) {
        maybeArmForSubmission();
      }
    },
    true
  );

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest("button, [role='button']") : null;
      if (!target || !nearActiveEditor(target)) {
        return;
      }

      maybeArmForSubmission();
    },
    true
  );

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "promptbin/libraryUpdated") {
      reloadLibrary();
    }
  });

  reloadLibrary();
})();
