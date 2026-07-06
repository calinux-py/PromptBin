import { sendRequest } from "../lib/runtime.js";
import { DEFAULT_SETTINGS } from "../lib/settings.js";
import { applyTheme } from "../lib/theme.js";
import { escapeHtml, formatRelativeTime, promptPreview } from "../lib/tag-utils.js";

const countElement = document.getElementById("popup-count");
const recentListElement = document.getElementById("recent-list");
const recentSectionElement = document.getElementById("recent-section");
const openOptionsButton = document.getElementById("open-options");
const openSettingsButton = document.getElementById("open-settings");

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function renderRecent(prompts) {
  if (!prompts.length) {
    recentListElement.innerHTML = `
      <div class="popup-empty">
        No recently used prompts yet.
      </div>
    `;
    return;
  }

  recentListElement.innerHTML = prompts
    .slice(0, 3)
    .map(
      (prompt) => `
        <article class="popup-item">
          <p class="popup-item__tag">${escapeHtml(prompt.tag)}</p>
          <p class="popup-item__preview">${escapeHtml(promptPreview(prompt.prompt, 72))}</p>
          <p class="popup-item__meta">Used ${formatRelativeTime(prompt.lastUsedAt)}</p>
        </article>
      `
    )
    .join("");
}

async function load() {
  const snapshot = await sendRequest("promptbin/getLibrary");
  countElement.textContent = formatNumber(snapshot.stats?.promptCount ?? 0);
  applyTheme(snapshot.settings?.theme ?? DEFAULT_SETTINGS.theme);
  const tagColor = snapshot.settings?.tagColor ?? DEFAULT_SETTINGS.tagColor;
  document.documentElement.style.setProperty("--tag-color", tagColor);
  recentSectionElement.hidden = snapshot.settings?.showRecentPrompts === false;
  renderRecent(snapshot.recentPrompts ?? []);
}

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

openSettingsButton.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("ui/settings.html") });
  window.close();
});

load().catch((error) => {
  recentListElement.innerHTML = `<div class="popup-empty">${escapeHtml(error.message)}</div>`;
});
