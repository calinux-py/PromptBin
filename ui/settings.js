import { sendRequest } from "../lib/runtime.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";
import { applyTheme } from "../lib/theme.js";

const elements = {
  tagColor: document.getElementById("tag-color"),
  tagColorValue: document.getElementById("tag-color-value"),
  themeChoices: [...document.querySelectorAll(".settings-theme")],
  compactTags: document.getElementById("compact-tags"),
  enableTripleSlash: document.getElementById("triple-slash"),
  expandOnTab: document.getElementById("expand-on-tab"),
  showRecentPrompts: document.getElementById("show-recents"),
  previewTag: document.getElementById("preview-tag"),
  previewResult: document.getElementById("preview-result"),
  saveStatus: document.getElementById("save-status"),
  resetButton: document.getElementById("reset-settings"),
  toast: document.getElementById("toast")
};

let saveTimer = 0;
let toastTimer = 0;
let editRevision = 0;

function readForm() {
  return {
    theme: document.documentElement.dataset.theme ?? DEFAULT_SETTINGS.theme,
    tagColor: elements.tagColor.value.toUpperCase(),
    compactTags: elements.compactTags.checked,
    enableTripleSlash: elements.enableTripleSlash.checked,
    expandOnTab: elements.expandOnTab.checked,
    showRecentPrompts: elements.showRecentPrompts.checked
  };
}

function render(settings) {
  const nextSettings = { ...DEFAULT_SETTINGS, ...settings };
  applyTheme(nextSettings.theme);
  elements.tagColor.value = nextSettings.tagColor;
  elements.tagColorValue.value = nextSettings.tagColor;
  elements.themeChoices.forEach((choice) => {
    const isSelected = choice.dataset.themeChoice === nextSettings.theme;
    choice.classList.toggle("is-selected", isSelected);
    choice.setAttribute("aria-pressed", String(isSelected));
  });
  elements.compactTags.checked = nextSettings.compactTags;
  elements.enableTripleSlash.checked = nextSettings.enableTripleSlash;
  elements.expandOnTab.checked = nextSettings.expandOnTab;
  elements.showRecentPrompts.checked = nextSettings.showRecentPrompts;
  document.documentElement.style.setProperty("--tag-color", nextSettings.tagColor);

  if (nextSettings.compactTags) {
    elements.previewTag.textContent = "//test";
    elements.previewResult.textContent = "Sent as “this is a test”";
  } else {
    elements.previewTag.textContent = "this is a test";
    elements.previewResult.textContent = "Expanded in the editor";
  }
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 2400);
}

async function save(revision) {
  window.clearTimeout(saveTimer);
  elements.saveStatus.textContent = "Saving…";
  try {
    const settings = await sendRequest("promptbin/saveSettings", readForm());
    if (revision !== editRevision) {
      return true;
    }
    render(settings);
    elements.saveStatus.textContent = "Settings are up to date.";
    return true;
  } catch (error) {
    if (revision === editRevision) {
      elements.saveStatus.textContent = "Settings could not be saved.";
      showToast(error.message);
    }
    return false;
  }
}

function queueSave() {
  const revision = ++editRevision;
  render(readForm());
  elements.saveStatus.textContent = "Saving…";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => save(revision), 180);
}

document.querySelectorAll("input").forEach((input) => {
  input.addEventListener("input", queueSave);
});

elements.themeChoices.forEach((choice) => {
  choice.addEventListener("click", () => {
    applyTheme(choice.dataset.themeChoice);
    queueSave();
  });
});

elements.resetButton.addEventListener("click", async () => {
  render(DEFAULT_SETTINGS);
  if (await save(++editRevision)) {
    showToast("Default settings restored.");
  }
});

sendRequest("promptbin/getLibrary")
  .then((snapshot) => render(snapshot.settings))
  .catch((error) => showToast(error.message));
