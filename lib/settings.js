export const DEFAULT_SETTINGS = Object.freeze({
  theme: "midnight",
  tagColor: "#F6B17A",
  compactTags: true,
  enableTripleSlash: true,
  expandOnTab: true,
  showRecentPrompts: true
});

function normalizeTagColor(value) {
  const color = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : DEFAULT_SETTINGS.tagColor;
}

function normalizeTheme(value) {
  if (value === "forest") {
    return "basic";
  }
  return ["midnight", "basic", "gallery", "violet"].includes(value) ? value : DEFAULT_SETTINGS.theme;
}

export function normalizeSettings(input = {}) {
  return {
    theme: normalizeTheme(input.theme),
    tagColor: normalizeTagColor(input.tagColor),
    compactTags: input.compactTags !== false,
    enableTripleSlash: input.enableTripleSlash !== false,
    expandOnTab: input.expandOnTab !== false,
    showRecentPrompts: input.showRecentPrompts !== false
  };
}
