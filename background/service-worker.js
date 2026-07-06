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

async function broadcastLibraryUpdate() {
  const tabs = await chrome.tabs.query({});

  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: "promptbin/libraryUpdated"
        })
      )
  );
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
    await broadcastLibraryUpdate();
    return settings;
  },

  async "promptbin/savePrompt"(payload) {
    const prompt = await savePrompt(payload);
    await broadcastLibraryUpdate();
    return prompt;
  },

  async "promptbin/deletePrompt"(payload) {
    await deletePrompt(payload.tag);
    await broadcastLibraryUpdate();
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
    await broadcastLibraryUpdate();
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
