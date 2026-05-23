import { base64ToBlob, blobToBase64 } from "./images";
import { targetPlatform } from "./platform";
import type { AndroidBridge } from "./androidBridge";

type AnyFn = (...args: any[]) => any;

declare global {
  interface Window {
    runtime?: Record<string, AnyFn>;
    go?: {
      backend?: {
        Service?: Record<string, AnyFn>;
      };
    };
    AndroidImageStudio?: AndroidBridge;
    __imageStudioNativeResolve?: (requestId: string, payload: unknown) => void;
    __imageStudioNativeReject?: (requestId: string, message: string) => void;
  }
}

const SHIM_KEY_PREFIX = "android-shell";
const OUTPUT_DIR_KEY = `${SHIM_KEY_PREFIX}.outputDir`;
const DEFAULT_OUTPUT_DIR = "/sdcard/Android/data/top.gptcodex.imagestudio/files/Pictures/ImageStudio";
const unsupportedError = "Android shell build does not include the desktop Go backend for this operation yet.";

function isAndroidShellTarget() {
  return targetPlatform === "android" || targetPlatform === "android-pad";
}

function ensureWindowRuntime() {
  if (typeof window === "undefined") return;
  if (window.runtime && window.go?.backend?.Service) return;

  const listeners = new Map<string, Set<(...args: any[]) => void>>();

  const emit = (eventName: string, ...args: any[]) => {
    const bucket = listeners.get(eventName);
    if (!bucket) return;
    for (const cb of Array.from(bucket)) {
      try { cb(...args); } catch { /* ignore */ }
    }
  };

  const on = (eventName: string, callback: (...args: any[]) => void, maxCallbacks = -1) => {
    const bucket = listeners.get(eventName) ?? new Set<(...args: any[]) => void>();
    listeners.set(eventName, bucket);
    let wrapped = callback;
    if (maxCallbacks > 0) {
      let seen = 0;
      wrapped = (...args: any[]) => {
        seen += 1;
        callback(...args);
        if (seen >= maxCallbacks) bucket.delete(wrapped);
      };
    }
    bucket.add(wrapped);
    return () => bucket.delete(wrapped);
  };

  const nativeCalls = new Map<string, { resolve: (payload: any) => void; reject: (message: any) => void }>();

  window.__imageStudioNativeResolve = (requestId, payload) => {
    const entry = nativeCalls.get(requestId);
    if (!entry) return;
    nativeCalls.delete(requestId);
    entry.resolve(payload);
  };
  window.__imageStudioNativeReject = (requestId, message) => {
    const entry = nativeCalls.get(requestId);
    if (!entry) return;
    nativeCalls.delete(requestId);
    entry.reject(new Error(typeof message === "string" ? message : String(message)));
  };

  const invokeNative = (method: string, args: unknown[], fallback?: () => Promise<any> | any): Promise<any> => {
    if (window.AndroidImageStudio?.invoke) {
      return new Promise((resolve, reject) => {
        const requestId = `${method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        nativeCalls.set(requestId, { resolve, reject });
        try {
          window.AndroidImageStudio!.invoke!(requestId, method, JSON.stringify(args));
        } catch (error) {
          nativeCalls.delete(requestId);
          reject(error);
        }
      });
    }
    if (fallback) return Promise.resolve(fallback());
    return Promise.reject(new Error(`${method} is unavailable in this environment`));
  };

  const rejectUnsupported = () => Promise.reject(new Error(unsupportedError));

  const getStoredApiKey = (user: string) => invokeNative("GetStoredAPIKey", [user], () => {
    try { return localStorage.getItem(`${SHIM_KEY_PREFIX}.apikey.${user}`) ?? ""; } catch { return ""; }
  });

  const setStoredApiKey = (user: string, value: string) => invokeNative("SetStoredAPIKey", [user, value], () => {
    try {
      if (value.trim()) localStorage.setItem(`${SHIM_KEY_PREFIX}.apikey.${user}`, value.trim());
      else localStorage.removeItem(`${SHIM_KEY_PREFIX}.apikey.${user}`);
    } catch {
      // ignore
    }
  });

  const deleteStoredApiKey = (user: string) => invokeNative("DeleteStoredAPIKey", [user], () => {
    try { localStorage.removeItem(`${SHIM_KEY_PREFIX}.apikey.${user}`); } catch { /* ignore */ }
  });

  const getOutputDir = () => invokeNative("GetOutputDir", [], () => {
    try { return localStorage.getItem(OUTPUT_DIR_KEY) ?? DEFAULT_OUTPUT_DIR; } catch { return DEFAULT_OUTPUT_DIR; }
  });

  const setOutputDir = (value: string) => invokeNative("SetOutputDir", [value], () => {
    try {
      if (value.trim()) localStorage.setItem(OUTPUT_DIR_KEY, value.trim());
      else localStorage.removeItem(OUTPUT_DIR_KEY);
    } catch {
      // ignore
    }
  });

  const service: Record<string, AnyFn> = {
    Cancel: (_jobId: string) => rejectUnsupported(),
    ChooseOutputDir: () => invokeNative("ChooseOutputDir", [], getOutputDir),
    CropImage: (path: string, x: number, y: number, w: number, h: number) => invokeNative("CropImage", [path, x, y, w, h]),
    DeleteStoredAPIKey: (user: string) => deleteStoredApiKey(user),
    Edit: () => rejectUnsupported(),
    ExportHistoryToFile: (jsonContent: string) => {
      if (window.AndroidImageStudio?.exportHistory) {
        const suggested = `image-studio-history-${Date.now()}.json`;
        return Promise.resolve(window.AndroidImageStudio.exportHistory(jsonContent, suggested));
      }
      return invokeNative("ExportHistoryToFile", [jsonContent]);
    },
    FlipImage: (path: string, horizontal: boolean) => invokeNative("FlipImage", [path, horizontal]),
    Generate: () => rejectUnsupported(),
    GetOutputDir: () => getOutputDir(),
    GetStoredAPIKey: (user: string) => getStoredApiKey(user),
    ImportHistoryFromFile: () => {
      if (window.AndroidImageStudio?.importHistory) {
        return Promise.resolve(window.AndroidImageStudio.importHistory() ?? "");
      }
      return invokeNative("ImportHistoryFromFile", []);
    },
    ImportImageFromB64: (imageB64: string, suggestedName: string) => invokeNative("ImportImageFromB64", [imageB64, suggestedName]),
    OpenExternalURL: (url: string) => invokeNative("OpenExternalURL", [url], () => {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) window.location.href = url;
    }),
    OpenFile: (path: string) => invokeNative("OpenFile", [path]),
    OpenImageDialog: () => invokeNative("OpenImageDialog", []),
    OpenOutputDir: () => {
      if (window.AndroidImageStudio?.openOutputDir) return Promise.resolve(window.AndroidImageStudio.openOutputDir());
      return invokeNative("OpenOutputDir", [], () => undefined);
    },
    OptimizePrompt: () => rejectUnsupported(),
    ReadImageAsBase64: (path: string) => invokeNative("ReadImageAsBase64", [path]),
    ReadTextFile: (path: string) => invokeNative("ReadTextFile", [path]),
    RegisterTrustedOutputDir: (_root: string) => Promise.resolve(),
    RotateImage: (path: string, degrees: number) => invokeNative("RotateImage", [path, degrees]),
    SaveImageAs: async (imageB64: string, suggestedName: string) => {
      if (window.AndroidImageStudio?.saveImage) {
        return window.AndroidImageStudio.saveImage(imageB64, suggestedName);
      }
      const url = URL.createObjectURL(base64ToBlob(imageB64));
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName || "image-studio.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return suggestedName;
    },
    SetOutputDir: (path: string) => setOutputDir(path),
    SetStoredAPIKey: (user: string, value: string) => setStoredApiKey(user, value),
  };

  window.runtime = window.runtime ?? {
    EventsOnMultiple: on,
    EventsOff: (...eventNames: string[]) => {
      for (const name of eventNames) listeners.delete(name);
    },
    EventsOffAll: () => listeners.clear(),
    EventsEmit: emit,
    WindowSetSystemDefaultTheme: () => undefined,
    WindowSetLightTheme: () => undefined,
    WindowSetDarkTheme: () => undefined,
    BrowserOpenURL: (url: string) => {
      const opened = window.open(url, "_blank", "noopener,noreferrer");
      if (!opened) window.location.href = url;
    },
    ClipboardGetText: async () => navigator.clipboard.readText(),
    ClipboardSetText: async (text: string) => navigator.clipboard.writeText(text),
  };

  window.go = window.go ?? {};
  window.go.backend = window.go.backend ?? {};
  window.go.backend.Service = window.go.backend.Service ?? service;

  for (const [name, fn] of Object.entries(service)) {
    if (!(name in window.go.backend.Service)) {
      window.go.backend.Service[name] = fn;
    }
  }
}

if (typeof window !== "undefined" && isAndroidShellTarget()) {
  ensureWindowRuntime();
}

export async function readBlobAsBase64ForShell(blob: Blob): Promise<string> {
  return blobToBase64(blob);
}
