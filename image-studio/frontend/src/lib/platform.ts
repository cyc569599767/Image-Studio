export type UIPlatform = "macos" | "windows" | "linux" | "ios" | "android" | "web";
export type UITargetPlatform = UIPlatform | "android-pad";
export type UIFamily = "apple" | "fluent" | "android" | "generic";

function fromOverride(raw?: string): UITargetPlatform | null {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "mac":
    case "macos":
    case "darwin":
      return "macos";
    case "windows":
    case "win":
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "ios":
      return "ios";
    case "android":
      return "android";
    case "android-pad":
    case "android_tablet":
    case "android-tablet":
    case "tablet":
    case "pad":
      return "android-pad";
    case "web":
      return "web";
    default:
      return null;
  }
}

function detectTargetPlatform(): UITargetPlatform {
  const override = fromOverride(import.meta.env.VITE_TARGET_PLATFORM);
  if (override) return override;
  if (typeof navigator === "undefined") return "web";

  const uaDataPlatform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  const platform = navigator.platform ?? "";
  const userAgent = navigator.userAgent ?? "";
  const source = `${uaDataPlatform} ${platform} ${userAgent}`.toLowerCase();

  if (/iphone|ipad|ipod|ios/.test(source)) return "ios";
  if (/android/.test(source)) {
    const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    const wide = typeof window !== "undefined" && Math.min(window.innerWidth, window.innerHeight) >= 600;
    return coarse && wide ? "android-pad" : "android";
  }
  if (/mac/.test(source)) return "macos";
  if (/win/.test(source)) return "windows";
  if (/linux|x11/.test(source)) return "linux";
  return "web";
}

function normalizeRuntimePlatform(value: UITargetPlatform): UIPlatform {
  if (value === "android-pad") return "android";
  return value;
}

function familyForTarget(value: UITargetPlatform): UIFamily {
  switch (value) {
    case "macos":
    case "ios":
      return "apple";
    case "android":
    case "android-pad":
      return "android";
    case "windows":
      return "fluent";
    default:
      return "generic";
  }
}

export const targetPlatform = detectTargetPlatform();
export const platform = normalizeRuntimePlatform(targetPlatform);
export const uiFamily = familyForTarget(targetPlatform);
export const isAndroid = platform === "android";
export const isAndroidPad = targetPlatform === "android-pad";
export const isAndroidPhone = targetPlatform === "android";
export const usesAppleUI = uiFamily === "apple";
export const usesAndroidUI = uiFamily === "android";
export const isMac = platform === "macos" || platform === "ios";
export const isWindows = platform === "windows";

export function applyPlatformAttributes(root: HTMLElement = document.documentElement) {
  root.dataset.platform = platform;
  root.dataset.targetPlatform = targetPlatform;
  root.dataset.uiFamily = uiFamily;
}

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
  if (isAndroidPad) return "应用图片目录 / MediaStore Pictures";
  if (isAndroidPhone) return "系统下载 / 分享面板";
  if (isMac) return "~/Pictures/Image Studio";
  if (isWindows) return "%APPDATA%\\image-studio";
  return "~/Pictures/Image Studio";
}

export function platformRuntimeLabel() {
  if (isAndroidPad) return "Android Pad WebView / Material 3 adaptive frontend";
  if (isAndroidPhone) return "Android WebView / Material 3 phone frontend";
  if (isMac) return "Wails v2 / WKWebView";
  if (isWindows) return "Wails v2 / WebView2";
  return "Wails v2 / WebKitGTK";
}
