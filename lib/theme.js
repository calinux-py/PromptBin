export const THEMES = Object.freeze([
  Object.freeze({ id: "midnight", name: "Midnight Apricot", color: "#F6B17A" }),
  Object.freeze({ id: "basic", name: "Basic", color: "#E5E7EB" }),
  Object.freeze({ id: "gallery", name: "Blue Gallery", color: "#89B4D4" }),
  Object.freeze({ id: "violet", name: "Violet Ink", color: "#B7A0D8" })
]);

export function applyTheme(theme) {
  const nextTheme = THEMES.some(({ id }) => id === theme) ? theme : THEMES[0].id;
  document.documentElement.dataset.theme = nextTheme;
}
