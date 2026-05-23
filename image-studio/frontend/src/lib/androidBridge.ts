import { isAndroid, isAndroidPad, isAndroidPhone } from "./platform";

type AndroidBridge = {
  saveImage?: (imageB64: string, suggestedName: string) => string | Promise<string>;
  shareImage?: (imageB64: string, suggestedName: string) => string | Promise<string>;
  openOutputDir?: () => string | Promise<string | void>;
  pickImage?: () => string | Promise<string | AndroidPickedImage | null>;
  exportHistory?: (jsonContent: string, suggestedName: string) => string | Promise<string>;
  importHistory?: () => string | Promise<string | null>;
};

type AndroidPickedImage = {
  path?: string;
  name?: string;
  size?: number;
  imageB64?: string;
  mimeType?: string;
};

declare global {
  interface Window {
    AndroidImageStudio?: AndroidBridge;
    Android?: AndroidBridge;
  }
}

function bridge(): AndroidBridge | null {
  if (typeof window === "undefined") return null;
  return window.AndroidImageStudio ?? window.Android ?? null;
}

function byteStringToBlobURL(imageB64: string, type = "image/png"): string {
  const bin = atob(imageB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function triggerDownload(imageB64: string, suggestedName: string): string {
  const objectURL = byteStringToBlobURL(imageB64);
  const a = document.createElement("a");
  a.href = objectURL;
  a.download = suggestedName || "image-studio.png";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  return suggestedName;
}

function ensurePngName(name: string): string {
  const trimmed = name.trim() || "image-studio.png";
  return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.png`;
}

export const androidTarget = {
  isAndroid,
  isPad: isAndroidPad,
  isPhone: isAndroidPhone,
};

export function hasAndroidBridge(): boolean {
  return !!bridge();
}

export async function saveImageForPlatform(
  imageB64: string,
  suggestedName: string,
  desktopSave: (imageB64: string, suggestedName: string) => Promise<string>,
): Promise<string> {
  const filename = ensurePngName(suggestedName);
  if (!isAndroid) return desktopSave(imageB64, filename);

  const b = bridge();
  if (b?.saveImage) {
    const saved = await b.saveImage(imageB64, filename);
    return String(saved || filename);
  }

  if (navigator.share && typeof File !== "undefined") {
    try {
      const blob = await (await fetch(`data:image/png;base64,${imageB64}`)).blob();
      const file = new File([blob], filename, { type: "image/png" });
      const canShare = !navigator.canShare || navigator.canShare({ files: [file] });
      if (canShare) {
        await navigator.share({ files: [file], title: filename });
        return filename;
      }
    } catch {
      // Fall back to download below.
    }
  }

  return triggerDownload(imageB64, filename);
}

export async function openOutputLocationForPlatform(
  desktopOpen: () => Promise<void>,
): Promise<void> {
  if (!isAndroid) {
    await desktopOpen();
    return;
  }
  const b = bridge();
  if (b?.openOutputDir) {
    await b.openOutputDir();
    return;
  }
  throw new Error(isAndroidPad ? "Android Pad 壳层未提供打开图片目录接口" : "手机版请从系统下载或分享记录里查看保存图片");
}

export async function exportHistoryForPlatform(
  jsonContent: string,
  desktopExport: (jsonContent: string) => Promise<string>,
): Promise<string> {
  if (!isAndroid) return desktopExport(jsonContent);
  const suggested = `image-studio-history-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const b = bridge();
  if (b?.exportHistory) {
    const exported = await b.exportHistory(jsonContent, suggested);
    return String(exported || suggested);
  }
  const objectURL = URL.createObjectURL(new Blob([jsonContent], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = objectURL;
  a.download = suggested;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectURL), 1000);
  return suggested;
}

export async function openExternalURLForPlatform(
  url: string,
  desktopOpen: (url: string) => Promise<void>,
): Promise<void> {
  if (!isAndroid) {
    await desktopOpen(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) window.location.href = url;
}

export async function importHistoryForPlatform(
  desktopImport: () => Promise<string>,
): Promise<string> {
  if (!isAndroid) return desktopImport();
  const b = bridge();
  if (b?.importHistory) return String((await b.importHistory()) || "");
  return "";
}

export function androidSaveHint(): string {
  if (isAndroidPad) return "Pad 版默认保存到壳层暴露的 Pictures/应用相册;无壳层时会下载或调系统分享面板。";
  if (isAndroidPhone) return "手机版不弹桌面另存为窗口;保存会走系统下载、分享面板或壳层 MediaStore。";
  return "";
}
