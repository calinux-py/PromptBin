import { sendRequest } from "../lib/runtime.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";
import { applyTheme } from "../lib/theme.js";
import { escapeHtml, formatRelativeTime, normalizeTag, promptPreview, validateTag } from "../lib/tag-utils.js";

const state = {
  prompts: [],
  filteredPrompts: [],
  selectedTag: null,
  stats: {
    promptCount: 0,
    totalCharacters: 0
  },
  settings: {
    ...DEFAULT_SETTINGS
  }
};

const elements = {
  search: document.getElementById("search"),
  promptList: document.getElementById("prompt-list"),
  filteredCount: document.getElementById("filtered-count"),
  statCount: document.getElementById("stat-count"),
  tagColor: document.getElementById("tag-color"),
  tagColorValue: document.getElementById("tag-color-value"),
  editorTitle: document.getElementById("editor-title"),
  charCount: document.getElementById("char-count"),
  updatedAt: document.getElementById("updated-at"),
  form: document.getElementById("prompt-form"),
  tagInput: document.getElementById("tag-input"),
  promptInput: document.getElementById("prompt-input"),
  deleteButton: document.getElementById("delete-prompt"),
  newButton: document.getElementById("new-prompt"),
  exportButton: document.getElementById("export-library"),
  importButton: document.getElementById("import-library"),
  importFile: document.getElementById("import-file"),
  localBackupButton: document.getElementById("local-backup"),
  settingsButton: document.getElementById("open-settings"),
  backupDialog: document.getElementById("backup-dialog"),
  backupDontAsk: document.getElementById("backup-dont-ask"),
  backupNotNow: document.getElementById("backup-not-now"),
  backupSaveCopy: document.getElementById("backup-save-copy"),
  toast: document.getElementById("toast")
};

let toastTimer = 0;
let backupPromptDismissed = false;

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 2600);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function tagInputValue(value) {
  return normalizeTag(value).replace(/^\/\//, "");
}

function renderStats() {
  applyTheme(state.settings.theme);
  elements.statCount.textContent = formatNumber(state.stats.promptCount);
  elements.tagColor.value = state.settings.tagColor;
  elements.tagColorValue.value = state.settings.tagColor;
  document.documentElement.style.setProperty("--tag-color", state.settings.tagColor);
}

function renderList() {
  const selectedTag = state.selectedTag;
  const prompts = state.filteredPrompts;
  elements.filteredCount.textContent = `${prompts.length} shown`;

  if (!prompts.length) {
    const hasSearch = Boolean(elements.search.value.trim());
    elements.promptList.innerHTML = `
      <div class="options-list__empty">
        <strong>${hasSearch ? "No matching prompts" : "Your library is empty"}</strong>
        <span>${hasSearch ? "Try a different tag or phrase." : "Create a shortcut to add your first prompt."}</span>
      </div>
    `;
    return;
  }

  elements.promptList.innerHTML = prompts
    .map(
      (prompt) => `
        <button class="options-item${prompt.tagKey === selectedTag ? " is-active" : ""}" data-tag="${prompt.tagKey}" type="button">
          <div>
            <p class="options-item__tag">${escapeHtml(prompt.tag)}</p>
            <p class="options-item__preview">${escapeHtml(promptPreview(prompt.prompt))}</p>
          </div>
          <div class="options-item__meta">
            <span>${formatNumber(prompt.characterCount || prompt.prompt.length)} chars</span>
            <span>${formatRelativeTime(prompt.updatedAt)}</span>
          </div>
        </button>
      `
    )
    .join("");
}

function renderEditor() {
  const current = state.prompts.find((prompt) => prompt.tagKey === state.selectedTag);
  elements.deleteButton.hidden = !current;

  if (!current) {
    elements.editorTitle.textContent = "Create a prompt";
    elements.charCount.textContent = `${elements.promptInput.value.length} characters`;
    elements.updatedAt.textContent = "Not saved yet";
    return;
  }

  elements.editorTitle.textContent = `Editing ${current.tag}`;
  elements.tagInput.value = tagInputValue(current.tag);
  elements.promptInput.value = current.prompt;
  elements.charCount.textContent = `${formatNumber(current.characterCount || current.prompt.length)} characters`;
  elements.updatedAt.textContent = `Updated ${formatRelativeTime(current.updatedAt)}`;
}

function render() {
  renderStats();
  renderList();
  renderEditor();
}

function applyFilter() {
  const query = elements.search.value.trim().toLowerCase();
  if (!query) {
    state.filteredPrompts = [...state.prompts];
    return;
  }

  state.filteredPrompts = state.prompts.filter((prompt) => {
    return (
      prompt.tag.toLowerCase().includes(query) ||
      prompt.prompt.toLowerCase().includes(query)
    );
  });
}

async function loadLibrary() {
  const snapshot = await sendRequest("promptbin/getLibrary");
  state.prompts = snapshot.prompts ?? [];
  state.stats = snapshot.stats ?? state.stats;
  state.settings = snapshot.settings ?? state.settings;

  if (state.selectedTag && !state.prompts.some((prompt) => prompt.tagKey === state.selectedTag)) {
    state.selectedTag = null;
  }

  applyFilter();
  render();
}

async function downloadLocalBackup() {
  const library = await sendRequest("promptbin/exportLibrary");
  const blob = new Blob([JSON.stringify(library, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "");
  anchor.href = url;
  anchor.download = `promptbin-backup-${timestamp}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function initializeLocalBackup() {
  const stored = await chrome.storage.local.get({ backupPromptDismissed: false });
  backupPromptDismissed = Boolean(stored.backupPromptDismissed);
}

async function onLocalBackup() {
  try {
    await downloadLocalBackup();
    showToast("Local backup saved to Downloads.");
  } catch (error) {
    showToast(error.message);
  }
}

function maybeOfferLocalBackup() {
  if (!backupPromptDismissed && !elements.backupDialog.open) {
    elements.backupDontAsk.checked = false;
    elements.backupDialog.showModal();
  }
}

async function rememberBackupPromptChoice() {
  if (!elements.backupDontAsk.checked) {
    return;
  }
  backupPromptDismissed = true;
  await chrome.storage.local.set({ backupPromptDismissed: true });
}

function resetEditor() {
  state.selectedTag = null;
  elements.form.reset();
  elements.charCount.textContent = "0 characters";
  elements.updatedAt.textContent = "Not saved yet";
  render();
  elements.tagInput.focus();
}

async function onSubmit(event) {
  event.preventDefault();

  try {
    const payload = {
      tag: validateTag(elements.tagInput.value),
      prompt: elements.promptInput.value
    };

    await sendRequest("promptbin/savePrompt", payload);
    state.selectedTag = normalizeTag(payload.tag);
    await loadLibrary();
    showToast(`Saved ${state.selectedTag}`);
    maybeOfferLocalBackup();
  } catch (error) {
    showToast(error.message);
  }
}

async function onDelete() {
  const current = state.prompts.find((prompt) => prompt.tagKey === state.selectedTag);
  if (!current) {
    return;
  }

  const confirmed = window.confirm(`Delete ${current.tag}?`);
  if (!confirmed) {
    return;
  }

  try {
    await sendRequest("promptbin/deletePrompt", {
      tag: current.tag
    });
    resetEditor();
    await loadLibrary();
    showToast(`Deleted ${current.tag}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function onExport() {
  try {
    await downloadLocalBackup();
    showToast("Library exported.");
  } catch (error) {
    showToast(error.message);
  }
}

async function onImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const library = JSON.parse(text);
    await sendRequest("promptbin/importLibrary", {
      library,
      replaceExisting: false
    });
    await loadLibrary();
    showToast(`Imported ${file.name}`);
  } catch (error) {
    showToast(`Import failed: ${error.message}`);
  } finally {
    elements.importFile.value = "";
  }
}

elements.form.addEventListener("submit", onSubmit);
elements.deleteButton.addEventListener("click", onDelete);
elements.newButton.addEventListener("click", resetEditor);
elements.exportButton.addEventListener("click", onExport);
elements.importButton.addEventListener("click", () => elements.importFile.click());
elements.localBackupButton.addEventListener("click", onLocalBackup);
elements.settingsButton.addEventListener("click", () => {
  window.location.href = "settings.html";
});
elements.backupNotNow.addEventListener("click", () => {
  rememberBackupPromptChoice().catch((error) => showToast(error.message));
});
elements.backupSaveCopy.addEventListener("click", () => {
  rememberBackupPromptChoice().catch((error) => showToast(error.message));
  elements.backupDialog.close();
  onLocalBackup();
});
elements.importFile.addEventListener("change", onImportFile);

elements.promptList.addEventListener("click", (event) => {
  const button =
    event.target instanceof Element ? event.target.closest("[data-tag]") : null;
  if (!button) {
    return;
  }

  state.selectedTag = button.dataset.tag;
  render();
});

elements.search.addEventListener("input", () => {
  applyFilter();
  renderList();
});

elements.tagInput.addEventListener("blur", () => {
  if (!elements.tagInput.value.trim()) {
    return;
  }

  elements.tagInput.value = tagInputValue(elements.tagInput.value);
});

elements.promptInput.addEventListener("input", () => {
  elements.charCount.textContent = `${formatNumber(elements.promptInput.value.length)} characters`;
});

elements.tagColor.addEventListener("input", () => {
  const tagColor = elements.tagColor.value.toUpperCase();
  elements.tagColorValue.value = tagColor;
  document.documentElement.style.setProperty("--tag-color", tagColor);
});

elements.tagColor.addEventListener("change", async () => {
  try {
    state.settings = await sendRequest("promptbin/saveSettings", {
      tagColor: elements.tagColor.value
    });
    renderStats();
    showToast("Tag color updated.");
  } catch (error) {
    showToast(error.message);
  }
});

render();
initializeLocalBackup().catch((error) => showToast(error.message));
loadLibrary().catch((error) => {
  showToast(error.message);
});
