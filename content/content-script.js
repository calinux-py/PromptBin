(function promptBinContentScript() {
  const DEFAULT_TAG_COLOR = "#F6B17A";
  const SUPPORTED_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);
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
    // none of those callbacks can restore decoration for the old //tag.
    expansionSuppressedEditors.add(editor);
    teardownDecorators();
    let nativeInputDispatched = false;
    let replacementApplied = false;

    if (isTextControl(editor)) {
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

    const caret = isTextControl(editor) ? editor.selectionStart : null;
    const beforeCaret = isTextControl(editor)
      ? editor.value.slice(0, caret)
      : contentEditableTextBeforeCaret(editor);
    if (beforeCaret === null || (isTextControl(editor) && caret !== editor.selectionEnd)) {
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

    if (isTextControl(editor)) {
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

  function isTextControl(node) {
    return node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLInputElement && SUPPORTED_INPUT_TYPES.has(node.type));
  }

  function resolveEditableElement(node) {
    if (!node) {
      return null;
    }

    if (isTextControl(node) && !node.disabled && !node.readOnly) {
      return node;
    }

    if (node instanceof Element) {
      const textControl = node.closest("textarea, input");
      if (isTextControl(textControl) && !textControl.disabled && !textControl.readOnly) {
        return textControl;
      }

      // Resolve descendants to their explicit editing host. This covers both
      // contenteditable="true" and contenteditable="plaintext-only" without
      // treating an arbitrary nested span as a separate editor.
      const editable = node.closest("[contenteditable]");
      if (editable?.getAttribute("contenteditable")?.toLowerCase() === "false") {
        return null;
      }
      if (editable?.isContentEditable) {
        return editable;
      }
    }

    return null;
  }

  function resolveEventEditor(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (const node of path) {
      const editor = resolveEditableElement(node);
      if (editor) {
        return editor;
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

  function installStyles(root = document) {
    const existing = root === document
      ? document.getElementById("promptbin-content-styles")
      : root.querySelector("#promptbin-content-styles");
    if (existing?.dataset.promptbinRevision === "native-tag-color") {
      return;
    }
    existing?.remove();

    const style = document.createElement("style");
    style.id = "promptbin-content-styles";
    style.dataset.promptbinRevision = "native-tag-color";
    style.textContent = `
      .promptbin-tag-text {
        color: var(--promptbin-tag-color, #F6B17A) !important;
        -webkit-text-fill-color: var(--promptbin-tag-color, #F6B17A) !important;
      }

      ::highlight(promptbin-compact-tag) {
        color: var(--promptbin-tag-color, #F6B17A);
      }
    `;
    (root === document ? document.documentElement : root).appendChild(style);
  }

  class EditorDecorator {
    constructor(editor) {
      this.editor = editor;
      const root = editor.getRootNode();
      if (root instanceof ShadowRoot) {
        installStyles(root);
      }
      this.pendingDeletionText = null;
      this.sync = this.sync.bind(this);

      this.mutationObserver = null;
      if (editor.isContentEditable) {
        this.mutationObserver = new MutationObserver(this.sync);
        this.mutationObserver.observe(editor, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }

      this.sync();
    }

    destroy() {
      this.mutationObserver?.disconnect();
      this.hide();
    }

    hide() {
      this.editor.classList.remove("promptbin-tag-text");
      CSS.highlights?.delete("promptbin-compact-tag");
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

      const highlightText = this.editor.isContentEditable
        ? (this.editor.textContent || "")
        : text;
      const matches = getCompactDisplayMatches(highlightText);

      if (!matches.length) {
        this.hide();
        return;
      }

      if (!this.editor.isContentEditable) {
        // Native text controls paint their value as one layer. Coloring the
        // existing value avoids the alignment bugs caused by mirroring it.
        this.editor.classList.add("promptbin-tag-text");
        return;
      }

      if (!CSS.highlights || typeof Highlight !== "function") {
        // Keep using real editor text on older Chromium versions that do not
        // provide range highlights.
        this.editor.classList.add("promptbin-tag-text");
        return;
      }

      const ranges = matches.map((match) => {
        const start = textPosition(this.editor, match.index);
        const end = textPosition(this.editor, match.index + match.length);
        const range = new Range();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        return range;
      });
      CSS.highlights.set("promptbin-compact-tag", new Highlight(...ranges));
    }

    sync() {
      if (!this.editor.isConnected || !isElementVisible(this.editor)) {
        this.hide();
        return;
      }

      this.render();
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
    document.querySelectorAll(".promptbin-tag-text").forEach((editor) => {
      editor.classList.remove("promptbin-tag-text");
    });
    CSS.highlights?.delete("promptbin-compact-tag");
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
    // stale tag color now so Backspace feels immediate, then redraw once the
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

  function expandTextControlForNativeSubmission(editor, matches) {
    if (!isTextControl(editor) || !matches.length) {
      return;
    }

    const original = editor.value;
    const replacement = original.replace(
      promptPattern,
      (tag) => promptMap[normalizeTag(tag)] ?? tag
    );
    if (replacement === original) {
      return;
    }

    expansionInProgress = true;
    editor.setRangeText(replacement, 0, original.length, "preserve");
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertReplacementText",
        data: replacement
      })
    );
    expansionInProgress = false;
  }

  function maybeExpandForSubmission({ expandNativeControl = false } = {}) {
    if (!activeEditor) {
      return;
    }

    const matches = getMatches(editorText(activeEditor));
    if (!matches.length) {
      return;
    }

    decorationsSuspended = true;
    teardownDecorators();
    if (expandNativeControl) {
      // Update successful native text controls before the browser constructs
      // the form payload. PromptBin never patches the page's network APIs.
      expandTextControlForNativeSubmission(activeEditor, matches);
      recordPromptUsage([...new Set(matches.map((match) => match.tag.toLowerCase()))]);
      return;
    }

    // Send actions on modern sites usually originate in a controlled rich
    // editor rather than a native form. Expand the shortcut through that
    // editor's existing replacement path before the site's event handler runs.
    // This preserves compact shortcuts without modifying fetch, XHR, or socket
    // behavior for the whole page.
    expandShortcutAtCaret(activeEditor, true);
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
      refreshDecorations();
    } catch (_error) {
      // The extension context can disappear during an update; the host editor
      // must continue working without PromptBin until the page reloads.
    }
  }

  document.querySelectorAll(".promptbin-overlay").forEach((overlay) => overlay.remove());
  installStyles();

  document.addEventListener(
    "focusin",
    (event) => {
      const target = resolveEventEditor(event);
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
      const target = resolveEventEditor(event);
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
      const target = resolveEventEditor(event);
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
      const target = resolveEventEditor(event);
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
        maybeExpandForSubmission();
      }
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (activeEditor && event.target instanceof Element && event.target.contains(activeEditor)) {
        maybeExpandForSubmission({ expandNativeControl: true });
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

      maybeExpandForSubmission();
    },
    true
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.promptbinLibraryRevision) {
      reloadLibrary();
    }
  });

  reloadLibrary();
})();
