import {
  deletePrompt,
  exportLibrary,
  getLibrarySnapshot,
  importLibrary,
  markPromptsUsed,
  savePrompt
} from "../lib/db.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../lib/settings.js";

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);

  return normalizeSettings(stored);
}

async function notifyLibraryUpdate() {
  // Content scripts can observe extension storage changes directly. A unique
  // revision wakes every open PromptBin content script without requiring the
  // broad `tabs` permission or enumerating the user's open tabs.
  await chrome.storage.local.set({
    promptbinLibraryRevision: `${Date.now()}-${crypto.randomUUID()}`
  });
}

const handlers = {
  async "promptbin/getLibrary"() {
    const [snapshot, settings] = await Promise.all([getLibrarySnapshot(), getSettings()]);
    return {
      ...snapshot,
      settings
    };
  },

  async "promptbin/saveSettings"(payload) {
    const current = await getSettings();
    const settings = normalizeSettings({ ...current, ...payload });
    await chrome.storage.local.set(settings);
    await notifyLibraryUpdate();
    return settings;
  },

  async "promptbin/savePrompt"(payload) {
    const prompt = await savePrompt(payload);
    await notifyLibraryUpdate();
    return prompt;
  },

  async "promptbin/deletePrompt"(payload) {
    await deletePrompt(payload.tag);
    await notifyLibraryUpdate();
    return { tag: payload.tag };
  },

  async "promptbin/markUsed"(payload) {
    const tags = await markPromptsUsed(payload.tags);
    return { tags };
  },

  async "promptbin/exportLibrary"() {
    return exportLibrary();
  },

  async "promptbin/importLibrary"(payload) {
    const prompts = await importLibrary(payload.library, {
      replaceExisting: payload.replaceExisting
    });
    await notifyLibraryUpdate();
    return {
      prompts
    };
  }
};

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type || !handlers[message.type]) {
    return false;
  }

  Promise.resolve(handlers[message.type](message.payload ?? {}))
    .then((data) => {
      sendResponse({
        ok: true,
        data
      });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message ?? "PromptBin request failed."
      });
    });

  return true;
});
