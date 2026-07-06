const TAG_RULE = /^\/\/[a-z0-9][a-z0-9_-]*$/i;

export function normalizeTag(input) {
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

export function validateTag(input) {
  const normalized = normalizeTag(input);
  if (!normalized) {
    throw new Error("Tags cannot be empty.");
  }

  if (!TAG_RULE.test(normalized)) {
    throw new Error("Tags must start with // and only use letters, numbers, hyphens, or underscores.");
  }

  return normalized;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildPromptMap(prompts) {
  return prompts.reduce((map, prompt) => {
    map[prompt.tagKey] = prompt.prompt;
    return map;
  }, {});
}

export function promptPreview(prompt, maxLength = 160) {
  const collapsed = String(prompt || "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return `${collapsed.slice(0, maxLength - 1)}…`;
}

export function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "Just now";
  }

  const time = new Date(timestamp).getTime();
  if (Number.isNaN(time)) {
    return "Just now";
  }

  const delta = Math.max(0, Date.now() - time);
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;

  if (delta < minute) {
    return "Just now";
  }

  if (delta < hour) {
    return `${Math.max(1, Math.round(delta / minute))}m ago`;
  }

  if (delta < day) {
    return `${Math.max(1, Math.round(delta / hour))}h ago`;
  }

  return `${Math.max(1, Math.round(delta / day))}d ago`;
}
