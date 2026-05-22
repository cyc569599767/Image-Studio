export const isMac =
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);

export const primaryModifierLabel = isMac ? "⌘" : "Ctrl";
export const redoShortcutLabel = isMac ? "⇧⌘Z" : "Ctrl+Shift+Z";
export const newTabShortcutLabel = isMac ? "⌘N" : "Ctrl+N";
export const closeTabShortcutLabel = isMac ? "⌘W" : "Ctrl+W";
export const submitShortcutLabel = isMac ? "⌘Enter" : "Ctrl+Enter";
export const copyShortcutLabel = isMac ? "⌘C" : "Ctrl+C";
export const pasteShortcutLabel = isMac ? "⌘V" : "Ctrl+V";
export const undoShortcutLabel = isMac ? "⌘Z" : "Ctrl+Z";
export const fullscreenShortcutLabel = isMac ? "⌃⌘F" : "F11";

export function platformOutputRootLabel() {
  if (isMac) return "~/Pictures/Image Studio";
  return "%APPDATA%\\image-studio";
}

export function platformRuntimeLabel() {
  return isMac ? "Wails v2 / WKWebView" : "Wails v2 / WebView2";
}
