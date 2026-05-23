import { create } from "zustand";
import {
  EventsOn,
  EventsOff,
  WindowSetDarkTheme,
  WindowSetLightTheme,
  WindowSetSystemDefaultTheme,
} from "../../wailsjs/runtime/runtime";
import {
  Generate as wailsGenerate,
  Edit as wailsEdit,
  Cancel as wailsCancel,
  OpenImageDialog,
  GetOutputDir,
  GetStoredAPIKey,
  SetStoredAPIKey,
  SaveImageAs,
  ImportImageFromB64,
  RotateImage,
  FlipImage,
  CropImage,
  ReadImageAsBase64,
  ExportHistoryToFile,
  ImportHistoryFromFile,
  RegisterTrustedOutputDir,
  SetOutputDir,
} from "../../wailsjs/go/backend/Service";
import type { backend } from "../../wailsjs/go/models";
import {
  HistoryItem,
  Mode,
  OutputFormatValue,
  Preset,
  ProgressInfo,
  QualityValue,
  SizeValue,
  SourceImage,
  ThemeMode,
  Toast,
  TransportKind,
  Workspace,
  Annotation,
} from "../types/domain";
import {
  clearLegacyAPIKeys,
  loadLegacyModeAPIKey,
  loadHistoryFullImage,
  loadLegacySharedAPIKey,
  loadTrustedOutputRoots,
  persistHistoryItem,
  persistHistoryFullImage,
  pruneHistoryStorage,
  rememberTrustedOutputRoot,
  removeHistoryItem,
  loadAllHistory,
} from "../lib/storage";
import {
  cleanBaseURL,
  sanitizeHistoryForExport,
  sanitizeImportedHistoryItem,
  suggestedImportNameForHistory,
  validateBaseURL,
} from "../lib/security";
import { base64ToBlob, blobToBase64, createPreviewBlob, getImageDimensionsFromBase64 } from "../lib/images";
import { isWindows } from "../lib/platform";

// 单个 API 形态的上游 5 字段(去掉 apiMode 本身)。
// 其中 apiKey 只进后端凭据存储;其余字段走 localStorage。
export interface ModeConfig {
  baseURL: string;
  apiKey: string;
  textModelID: string;
  imageModelID: string;
}

const EMPTY_MODE_CFG: ModeConfig = { baseURL: "", apiKey: "", textModelID: "", imageModelID: "" };
const MAX_HISTORY_ITEMS = 120;
let detachSystemThemeListener: (() => void) | null = null;

function resolvedTheme(theme: ThemeMode): "light" | "dark" {
  if (theme === "dark" || theme === "light") return theme;
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

function unbindSystemThemeListener() {
  if (detachSystemThemeListener) {
    detachSystemThemeListener();
    detachSystemThemeListener = null;
  }
}

function writeResolvedTheme(theme: "light" | "dark") {
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

function bindSystemThemeListener() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (matches: boolean) => writeResolvedTheme(matches ? "dark" : "light");
  const onChange = (event: MediaQueryListEvent) => apply(event.matches);
  apply(media.matches);
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    detachSystemThemeListener = () => media.removeEventListener("change", onChange);
    return;
  }
  media.addListener(onChange);
  detachSystemThemeListener = () => media.removeListener(onChange);
}

function applyTheme(theme: ThemeMode) {
  unbindSystemThemeListener();
  document.documentElement.setAttribute("data-appearance", theme);
  writeResolvedTheme(resolvedTheme(theme));
  if (isWindows) {
    if (theme === "system") WindowSetSystemDefaultTheme();
    else if (theme === "dark") WindowSetDarkTheme();
    else WindowSetLightTheme();
  }
  if (theme === "system") bindSystemThemeListener();
}

function loadModeConfig(mode: "responses" | "images"): ModeConfig {
  const r = (k: Exclude<keyof ModeConfig, "apiKey">): string => {
    try { return localStorage.getItem(`gptcodex.${mode}.${k}`) ?? ""; } catch { return ""; }
  };
  return {
    baseURL: r("baseURL"),
    apiKey: "",
    textModelID: r("textModelID"),
    imageModelID: r("imageModelID"),
  };
}

function saveModeField(mode: "responses" | "images", field: Exclude<keyof ModeConfig, "apiKey">, value: string) {
  try { localStorage.setItem(`gptcodex.${mode}.${field}`, value); } catch {}
}

interface StudioState {
  // ---- Form state ----
  apiKey: string;
  mode: Mode;
  prompt: string;
  negativePrompt: string;
  size: SizeValue;
  quality: QualityValue;
  // 输出图像编码:png / jpeg / webp。落盘扩展名 jpeg → .jpg(后端 client.FileExtForFormat)。
  outputFormat: OutputFormatValue;
  seed: number;          // 0 = random
  transport: TransportKind;

  // 顶层的「当前生效」上游配置 —— 它实际等于 responsesConfig 或 imagesConfig 里
  // 一份的镜像,具体取决于 apiMode。改 apiMode 时这 4 个字段会被瞬时换成另一形态
  // 已保存的值(热切换),所以两种形态的 BASE_URL / Key / 模型 ID 互不污染。
  baseURL: string;
  textModelID: string;
  imageModelID: string;
  // 上游 API 形态:
  //   "responses" — 默认,POST /v1/responses + SSE 流式保活(防 CF 524)
  //   "images"    — 标准 OpenAI Images API,POST /v1/images/generations + /v1/images/edits
  apiMode: "responses" | "images";
  // 关掉 Responses API 的 prompt 改写(在 payload 顶层加 instructions 让模型逐字使用)。
  // 对 Images API 无效但留着不影响。全局偏好,不分形态。
  noPromptRevision: boolean;
  // 两种形态各自独立的持久化槽。setField 在改 baseURL/textModelID/imageModelID
  // 或 setAPIKey 改 apiKey 时,同时写入对应形态的槽 + 顶层镜像。
  responsesConfig: ModeConfig;
  imagesConfig: ModeConfig;
  // Multi-reference source images. The legacy single-source UI now feeds into
  // and reads from this list. Empty list + currentImage on the canvas triggers
  // a fallback where the canvas image is used as the implicit source.
  sources: SourceImage[];

  // ---- Runtime ----
  // List of concurrently running job IDs (batch parallel). Empty when idle.
  runningJobs: string[];
  // Total jobs in current batch, completed so far. Used by StatusBar.
  jobsTotal: number;
  jobsCompleted: number;
  progress: ProgressInfo | null;
  lastLogLine: string;
  errorMessage: string | null;
  isRunning: boolean;
  // Snapshot of the last successfully-built payload, used by the retry button
  // on the error banner. Null when there's nothing to retry.
  lastPayload: backend.GenerateOptions | null;

  // ---- Result + history ----
  currentImage: HistoryItem | null;
  history: HistoryItem[];

  // ---- Canvas tooling state (UI only) ----
  tool: "pan" | "mask" | "annotate";
  brushSize: number;
  brushMode: "paint" | "erase";
  annotationKind: "rect" | "arrow" | "freehand" | "text";
  annotationColor: string;
  selectedAnnotationId: string | null;
  maskDataURL: string | null;       // PNG dataURL of current mask layer
  strokes: Stroke[];                // canvas mask strokes (image-local coords)
  annotations: Annotation[];

  // Compare mode: when compareB is non-null, the canvas renders currentImage
  // on the left and compareB on the right, split by `compareSplit` (0..1).
  compareB: HistoryItem | null;
  compareSplit: number;

  // Transient toast notifications.
  toasts: Toast[];

  // Rolling average of the last few generation times in seconds. Used by
  // StatusBar to estimate remaining time on the current run.
  recentDurations: number[];

  // Reported by CanvasStage; consumed by StatusBar. 1.0 = 100%.
  viewZoom: number;
  // 单调递增计数器。旋转 / 翻转 / 裁剪在 currentImage id 不变的前提下递增此值,
  // CanvasStage 用它当依赖来重置 userView(新尺寸下旧 pan/zoom 已经无意义)。
  canvasViewResetTick: number;
  // Toggled by F11; canvas-shell expands to full window and side panels hide.
  fullscreen: boolean;
  // List of recently used prompts (most recent first, capped).
  promptHistory: string[];

  // How many images to generate per "提交" click. 1 = single, 2-8 = batch.
  batchCount: number;
  // User-saved parameter presets, persisted to localStorage.
  presets: Preset[];

  // UI theme + font scale; persisted to localStorage and applied to <html>.
  theme: ThemeMode;
  fontScale: number; // 0.85 / 1 / 1.15

  // Multi-workspace (tabs). Top-level prompt/sources/etc. mirror the active tab.
  workspaces: Workspace[];
  activeWorkspaceId: string;

  // Style tag selected from the chip row in ControlPanel. Empty string =
  // no style (don't append anything to the prompt). Otherwise the chip's
  // expanded description gets concatenated at submit time.
  styleTag: string;

  // Unified undo/redo timeline. Each entry packages a forward + inverse so we
  // don't have to discriminate by kind on every undo call.
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // ---- Actions ----
  setField: <K extends keyof StudioState>(key: K, value: StudioState[K]) => void;
  setAPIKey: (v: string) => Promise<void>;
  selectSourceImage: () => Promise<void>;
  removeSource: (index: number) => void;
  clearSources: () => void;
  reorderSources: (from: number, to: number) => void;
  submit: () => Promise<void>;
  cancel: () => Promise<void>;
  reuseAsSource: (item: HistoryItem) => Promise<void>;
  applyHistoryParams: (item: HistoryItem) => void;
  regenerateFromHistory: (item: HistoryItem) => Promise<void>;
  deleteHistoryItem: (id: string) => Promise<void>;
  saveCurrentImageAs: () => Promise<void>;
  bootstrap: () => Promise<void>;

  setMaskDataURL: (v: string | null) => void;
  pushStroke: (s: Stroke) => void;
  resetMask: () => void;
  addAnnotation: (a: Annotation) => void;
  removeAnnotation: (id: string) => void;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void;
  clearAnnotations: () => void;
  undo: () => void;
  redo: () => void;
  setCompareB: (item: HistoryItem | null) => void;
  setCompareSplit: (v: number) => void;
  importImageFile: (file: File) => Promise<void>;
  pushToast: (text: string, kind?: Toast["kind"], ttl?: number, action?: Toast["action"]) => void;
  dismissToast: (id: string) => void;
  // 「查看详情」抽屉。打开时锁住当前 HistoryItem,不随 currentImage 切换变化。
  resultDetail: HistoryItem | null;
  openResultDetail: (item: HistoryItem) => Promise<void>;
  closeResultDetail: () => void;
  materializeCurrentImage: (item: HistoryItem) => Promise<HistoryItem>;
  retryLast: () => Promise<void>;
  savePreset: (name: string) => void;
  applyPreset: (id: string) => void;
  deletePreset: (id: string) => void;
  exportHistory: () => Promise<void>;
  importHistory: () => Promise<void>;
  setTheme: (t: ThemeMode) => void;
  setFontScale: (v: number) => void;
  testAPIKey: () => Promise<void>;
  isTestingKey: boolean;
  // 上游配置弹窗状态。bootstrap 在 apiKey/baseURL 任一为空时自动置 true。
  upstreamModalOpen: boolean;
  openUpstreamConfig: () => void;
  closeUpstreamConfig: () => void;
  newWorkspace: (name?: string) => void;
  switchWorkspace: (id: string) => void;
  closeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  rotateCurrent: (degrees: number) => Promise<void>;
  flipCurrent: (horizontal: boolean) => Promise<void>;
  cropToRect: (x: number, y: number, w: number, h: number) => Promise<void>;
}

export interface Stroke {
  points: number[];
  size: number;
  // erase=true 笔触在 mask PNG 中绘制为黑色(取消白色覆盖)
  erase?: boolean;
}

interface UndoEntry {
  label: string;
  // Each entry knows how to undo and redo itself given the store API.
  undo: (s: StudioState) => Partial<StudioState>;
  redo: (s: StudioState) => Partial<StudioState>;
}

function genId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  // Fallback for older WebView2 runtimes lacking crypto.randomUUID.
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function tempDataURLFromB64(b64: string): string {
  return `data:image/png;base64,${b64}`;
}

function stripDataURLPrefix(dataURL: string): string {
  const idx = dataURL.indexOf(",");
  return idx >= 0 ? dataURL.slice(idx + 1) : dataURL;
}

function buildMaskPNGDataURL(strokes: Stroke[], dims: { w: number; h: number } | null): string | null {
  if (!dims || strokes.length === 0) return null;
  const c = document.createElement("canvas");
  c.width = dims.w;
  c.height = dims.h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let hasWhite = false;
  for (const s of strokes) {
    ctx.strokeStyle = s.erase ? "#000" : "#fff";
    ctx.lineWidth = s.size;
    ctx.beginPath();
    for (let i = 0; i < s.points.length; i += 2) {
      const x = s.points[i];
      const y = s.points[i + 1];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (!s.erase) hasWhite = true;
  }
  return hasWhite ? c.toDataURL("image/png") : null;
}

async function registerTrustedOutputRoots(roots: string[]): Promise<void> {
  for (const root of roots) {
    if (!root.trim()) continue;
    await RegisterTrustedOutputDir(root).catch(() => undefined);
  }
}

function trimHistory(items: HistoryItem[]): HistoryItem[] {
  if (items.length <= MAX_HISTORY_ITEMS) return items;
  return items.slice(0, MAX_HISTORY_ITEMS);
}

function persistTrimmedHistory(items: HistoryItem[]): void {
  const keptIDs = items.map((item) => item.id);
  void pruneHistoryStorage(keptIDs);
}

async function createPreviewB64(b64: string, maxEdge = 192): Promise<string> {
  const blob = base64ToBlob(b64);
  const preview = await createPreviewBlob(blob, maxEdge);
  if (preview === blob) return b64;
  return await blobToBase64(preview);
}

// Compute image natural dimensions from a base64 PNG by reading the IHDR chunk.
// Cheap, sync, doesn't require a full image decode.
function imageDims(b64: string): { w: number; h: number } | null {
  return getImageDimensionsFromBase64(b64);
}

// If the user drew annotations, append a brief positional hint to the prompt.
// Falls back gracefully when we can't read image dimensions.
function augmentPromptWithAnnotations(
  prompt: string,
  annotations: Annotation[],
  dims: { w: number; h: number } | null,
): string {
  if (!annotations || annotations.length === 0) return prompt;
  const rects = annotations.filter((a) => a.kind === "rect");
  if (rects.length === 0) return prompt;
  const describe = (a: Annotation): string => {
    if (!dims) return `区域 ${rects.indexOf(a) + 1}`;
    const cx = (a.x + (a.width ?? 0) / 2) / dims.w;
    const cy = (a.y + (a.height ?? 0) / 2) / dims.h;
    const hPart = cx < 0.34 ? "左" : cx > 0.66 ? "右" : "中";
    const vPart = cy < 0.34 ? "上" : cy > 0.66 ? "下" : "中";
    return `${vPart}${hPart}部`;
  };
  const positions = rects.map(describe).join("、");
  return `${prompt}\n(请重点关注${positions}标注区域)`;
}

async function writeBase64ToTempFile(b64: string, _name: string): Promise<string> {
  // Backend doesn't currently expose a "write temp file from b64" binding,
  // but reuseAsSource needs a path for edit mode. Workaround: use SaveImageAs
  // with a fixed name into the user config dir would prompt the user. Instead,
  // we re-purpose the savedPath field that comes back with every result — it's
  // already on disk under UserConfigDir/image-studio/images. So callers should
  // use item.savedPath; this helper exists for parity and is currently unused.
  void b64;
  return "";
}

export const useStudioStore = create<StudioState>((set, get) => ({
  apiKey: "",
  mode: "generate",
  prompt: "",
  negativePrompt: "",
  size: "1024x1024",
  quality: "medium",
  outputFormat: "png",
  seed: 0,
  transport: "auto",
  baseURL: "",
  textModelID: "",
  imageModelID: "",
  apiMode: "responses",
  noPromptRevision: false,
  responsesConfig: EMPTY_MODE_CFG,
  imagesConfig: EMPTY_MODE_CFG,
  sources: [],

  runningJobs: [],
  jobsTotal: 0,
  jobsCompleted: 0,
  progress: null,
  lastLogLine: "",
  errorMessage: null,
  isRunning: false,
  lastPayload: null,

  currentImage: null,
  history: [],

  tool: "pan",
  brushSize: 30,
  brushMode: "paint",
  annotationKind: "rect",
  annotationColor: "#ff4d4d",
  selectedAnnotationId: null,
  maskDataURL: null,
  strokes: [],
  annotations: [],
  undoStack: [],
  redoStack: [],

  compareB: null,
  compareSplit: 0.5,

  toasts: [],
  recentDurations: [],
  viewZoom: 1,
  canvasViewResetTick: 0,
  fullscreen: false,
  promptHistory: [],
  batchCount: 1,
  presets: [],
  theme: "system",
  fontScale: 1,
  isTestingKey: false,
  upstreamModalOpen: false,
  openUpstreamConfig: () => set({ upstreamModalOpen: true }),
  closeUpstreamConfig: () => set({ upstreamModalOpen: false }),
  workspaces: [],
  activeWorkspaceId: "",
  styleTag: "",

  setField: (key, value) => {
    // apiMode 切换 → 把另一形态已保存的槽热加载到顶层镜像;两形态配置不互相覆盖
    if (key === "apiMode") {
      const newMode = value as "responses" | "images";
      const cfg = newMode === "responses" ? get().responsesConfig : get().imagesConfig;
      set({
        apiMode: newMode,
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        textModelID: cfg.textModelID,
        imageModelID: cfg.imageModelID,
      });
      try { localStorage.setItem("gptcodex.apiMode", newMode); } catch {}
      return;
    }
    // 上游 4 字段:写顶层镜像 + 写当前 mode 的槽
    if (key === "baseURL" || key === "textModelID" || key === "imageModelID") {
      const cleaned = key === "baseURL" ? cleanBaseURL(String(value)) : String(value);
      const mode = get().apiMode;
      const slot = mode === "responses" ? "responsesConfig" : "imagesConfig";
      const next: ModeConfig = { ...get()[slot], [key]: cleaned };
      set({ [key]: cleaned, [slot]: next } as any);
      saveModeField(mode, key as Exclude<keyof ModeConfig, "apiKey">, cleaned);
      return;
    }
    // 其他全局偏好字段
    set({ [key]: value } as any);
    if (key === "transport") {
      try { localStorage.setItem("gptcodex.transport", String(value)); } catch {}
    } else if (key === "noPromptRevision") {
      try { localStorage.setItem("gptcodex.noPromptRevision", value ? "1" : "0"); } catch {}
    } else if (key === "outputFormat") {
      try { localStorage.setItem("gptcodex.outputFormat", String(value)); } catch {}
    }
  },

  setAPIKey: async (v) => {
    const trimmed = v.trim();
    const mode = get().apiMode;
    const slot = mode === "responses" ? "responsesConfig" : "imagesConfig";
    const next: ModeConfig = { ...get()[slot], apiKey: trimmed };
    set({ apiKey: trimmed, [slot]: next } as any);
    await SetStoredAPIKey(mode, trimmed);
  },

  selectSourceImage: async () => {
    try {
      const res = await OpenImageDialog();
      if (!res || !res.path) return;
      const baseName = res.path.split(/[\\/]/).pop() ?? res.path;
      const existing = get().sources;
      if (existing.some((s) => s.path === res.path)) {
        set({ mode: "edit", errorMessage: null });
        return;
      }
      set({
        sources: [...existing, { path: res.path, name: baseName, size: res.size }],
        mode: "edit",
        errorMessage: null,
      });
    } catch (e: any) {
      set({ errorMessage: `选择图片失败:${e?.message ?? e}` });
    }
  },

  removeSource: (index) => {
    const next = get().sources.filter((_, i) => i !== index);
    set({ sources: next, mode: next.length > 0 ? "edit" : "generate" });
  },

  clearSources: () => set({ sources: [], mode: "generate" }),

  reorderSources: (from: number, to: number) => {
    const list = [...get().sources];
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    set({ sources: list });
  },

  submit: async () => {
    const s = get();
    if (s.isRunning) return;
    if (!s.apiKey.trim()) {
      set({ errorMessage: "请填写 API Key" });
      return;
    }
    if (!s.prompt.trim()) {
      set({ errorMessage: "请填写提示词" });
      return;
    }
    if (!s.baseURL.trim()) {
      set({ errorMessage: "请在右侧工作栏顶部的「上游配置」中填入你的中转站地址(必须兼容 OpenAI Responses API + image_generation 工具)" });
      return;
    }
    const cleanedBaseURL = cleanBaseURL(s.baseURL);
    const baseURLError = validateBaseURL(cleanedBaseURL);
    if (baseURLError) {
      set({ errorMessage: baseURLError });
      return;
    }
    let editSourcePaths: string[] = [];
    if (s.mode === "edit") {
      editSourcePaths = s.sources.map((src) => src.path).filter(Boolean);
      if (editSourcePaths.length === 0 && s.currentImage) {
        const materialized = await materializeHistoryItem(s.currentImage).catch(() => null);
        if (materialized?.savedPath) {
          editSourcePaths = [materialized.savedPath];
        }
      }
      if (editSourcePaths.length === 0) {
        set({ errorMessage: "图生图模式需要先添加源图(或从文件管理器拖图到画板)" });
        return;
      }
    }

    set({
      errorMessage: null,
      progress: null,
      lastLogLine: "",
      isRunning: true,
      jobsTotal: 1,
      jobsCompleted: 0,
      runningJobs: [],
    });

    const maskDataURL = s.mode === "edit"
      ? buildMaskPNGDataURL(s.strokes, s.currentImage?.imageB64 ? imageDims(s.currentImage.imageB64) : null)
      : null;
    const maskB64 = maskDataURL ? stripDataURLPrefix(maskDataURL) : "";
    let augmentedPrompt = augmentPromptWithAnnotations(s.prompt, s.annotations, s.currentImage?.imageB64 ? imageDims(s.currentImage.imageB64) : null);
    // Append style chip suffix if the user picked one (other than "全部").
    const styleSuffix = STYLE_SUFFIXES[s.styleTag];
    if (styleSuffix) {
      augmentedPrompt = `${augmentedPrompt}, ${styleSuffix}`;
    }

    const basePayload: backend.GenerateOptions = {
      apiKey: s.apiKey,
      mode: s.mode,
      prompt: augmentedPrompt,
      size: s.size,
      quality: s.quality,
      outputFormat: s.outputFormat,
      imagePaths: editSourcePaths,
      imagePath: "",
      maskB64: maskB64,
      seed: s.seed,
      negativePrompt: s.negativePrompt,
      baseURL: cleanedBaseURL,
      textModelID: s.textModelID,
      imageModelID: s.imageModelID,
      transport: s.transport,
      apiMode: s.apiMode,
      noPromptRevision: s.noPromptRevision,
    };

    if (s.prompt.trim()) {
      const ph = [s.prompt, ...get().promptHistory.filter((p) => p !== s.prompt)].slice(0, 50);
      set({ promptHistory: ph });
      try { localStorage.setItem("gptcodex.promptHistory", JSON.stringify(ph)); } catch {}
    }
    set({ lastPayload: basePayload });

    // 单张生成。批量生图(batchCount>1)已下架 —— 上游中转站对并发不友好,
    // 多个 SSE 流并行常会被节流/截断。如果将来恢复,for 循环回来即可。
    const jobSeed = s.seed || 0;
    const p: backend.GenerateOptions = { ...basePayload, seed: jobSeed };
    void launchOneJob(s.mode, p, {
      size: s.size,
      quality: s.quality,
      outputFormat: s.outputFormat,
      sources: s.sources,
      currentImage: s.currentImage,
      styleTag: s.styleTag,
      transport: s.transport,
    });
  },

  cancel: async () => {
    const ids = [...get().runningJobs];
    // Cancel every concurrent job in the batch.
    for (const id of ids) {
      try { await wailsCancel(id); } catch { /* ignore */ }
      EventsOff(`progress:${id}`, `log:${id}`, `result:${id}`, `error:${id}`);
    }
    set({
      isRunning: false,
      runningJobs: [],
      progress: null,
      jobsTotal: 0,
      jobsCompleted: 0,
    });
  },

  applyHistoryParams: (item) => {
    // Restore every reproducible field from the history item back into the
    // active workspace, but don't kick off a new generation.
    const patch: Partial<StudioState> = {
      prompt: item.prompt ?? "",
      mode: item.mode,
      size: item.size,
      quality: item.quality,
    };
    if (item.seed !== undefined) patch.seed = item.seed;
    if (item.negativePrompt !== undefined) patch.negativePrompt = item.negativePrompt;
    if (item.styleTag !== undefined) patch.styleTag = item.styleTag;
    if (item.transport) patch.transport = item.transport;
    if (item.outputFormat) patch.outputFormat = item.outputFormat;
    set(patch as any);
    get().pushToast("已应用此图的参数到控制台", "success");
  },

  regenerateFromHistory: async (item) => {
    get().applyHistoryParams(item);
    // Yield a microtask so React state has flushed before submit reads it.
    await Promise.resolve();
    await get().submit();
  },

  reuseAsSource: async (item) => {
    const localItem = await materializeHistoryItem(item).catch((e: any) => {
      set({ errorMessage: `源图准备失败:${e?.message ?? e}` });
      return null;
    });
    if (!localItem?.savedPath) return;
    const baseName = localItem.savedPath.split(/[\\/]/).pop() ?? "source.png";
    const existing = get().sources;
    const alreadyIn = existing.some((s) => s.path === localItem.savedPath);
    set({
      mode: "edit",
      currentImage: localItem,
      sources: alreadyIn
        ? existing
        : [...existing, { path: localItem.savedPath, name: baseName, size: 0 }],
    });
  },

  deleteHistoryItem: async (id) => {
    await removeHistoryItem(id);
    set({ history: get().history.filter((h) => h.id !== id) });
    if (get().currentImage?.id === id) set({ currentImage: null });
  },

  saveCurrentImageAs: async () => {
    const cur = await ensureFullHistoryItem(get().currentImage);
    if (!cur) return;
    const suggested = `image-${cur.mode}-${cur.id.slice(0, 8)}.png`;
    try {
      const saved = await SaveImageAs(cur.imageB64, suggested);
      if (saved) get().pushToast(`已保存:${saved.split(/[\\/]/).pop()}`, "success");
    } catch (e: any) {
      const msg = `保存失败:${e?.message ?? e}`;
      set({ errorMessage: msg });
      get().pushToast(msg, "error");
    }
  },

  bootstrap: async () => {
    const items = await loadAllHistory();
    let promptHistory: string[] = [];
    let presets: Preset[] = [];
    let theme: ThemeMode = "system";
    let fontScale = 1;
    try {
      const raw = localStorage.getItem("gptcodex.promptHistory");
      if (raw) promptHistory = JSON.parse(raw);
    } catch {}
    try {
      const raw = localStorage.getItem("gptcodex.presets");
      if (raw) presets = JSON.parse(raw);
    } catch {}
    try {
      const raw = localStorage.getItem("gptcodex.theme");
      if (raw === "system" || raw === "light" || raw === "dark") theme = raw;
    } catch {}
    try {
      const raw = localStorage.getItem("gptcodex.fontScale");
      const n = Number(raw);
      if (!Number.isNaN(n) && n > 0.5 && n < 2) fontScale = n;
    } catch {}
    // API 形态 + 网络通道(全局)
    let apiMode: "responses" | "images" = "responses";
    let transport: TransportKind = "auto";
    try {
      const v = localStorage.getItem("gptcodex.apiMode");
      if (v === "images" || v === "responses") apiMode = v;
    } catch {}
    try {
      const v = localStorage.getItem("gptcodex.transport");
      if (v === "auto" || v === "native" || v === "curl") transport = v;
    } catch {}
    let noPromptRevision = false;
    try {
      noPromptRevision = localStorage.getItem("gptcodex.noPromptRevision") === "1";
    } catch {}
    let outputFormat: OutputFormatValue = "png";
    try {
      const v = localStorage.getItem("gptcodex.outputFormat");
      if (v === "png" || v === "jpeg" || v === "webp") outputFormat = v;
    } catch {}
    // 每个形态的独立上游槽
    let responsesConfig = loadModeConfig("responses");
    let imagesConfig = loadModeConfig("images");
    // 旧版本(共享单份配置)迁移: legacy 字段 → 当前形态的槽,只在该槽为空时迁入。
    const legacyBaseURL  = (() => { try { return localStorage.getItem("gptcodex.baseURL") ?? ""; } catch { return ""; } })();
    const legacyTextID   = (() => { try { return localStorage.getItem("gptcodex.textModelID") ?? ""; } catch { return ""; } })();
    const legacyImageID  = (() => { try { return localStorage.getItem("gptcodex.imageModelID") ?? ""; } catch { return ""; } })();
    const legacySharedKey = loadLegacySharedAPIKey();
    const legacyResponsesKey = loadLegacyModeAPIKey("responses") || (apiMode === "responses" ? legacySharedKey : "");
    const legacyImagesKey = loadLegacyModeAPIKey("images") || (apiMode === "images" ? legacySharedKey : "");
    const activeSlot = apiMode === "responses" ? responsesConfig : imagesConfig;
    let migrated = false;
    if (!activeSlot.baseURL && legacyBaseURL)     { activeSlot.baseURL = cleanBaseURL(legacyBaseURL); migrated = true; }
    if (!activeSlot.textModelID && legacyTextID)  { activeSlot.textModelID = legacyTextID; migrated = true; }
    if (!activeSlot.imageModelID && legacyImageID){ activeSlot.imageModelID = legacyImageID; migrated = true; }
    if (migrated) {
      saveModeField(apiMode, "baseURL", activeSlot.baseURL);
      saveModeField(apiMode, "textModelID", activeSlot.textModelID);
      saveModeField(apiMode, "imageModelID", activeSlot.imageModelID);
      if (apiMode === "responses") responsesConfig = activeSlot;
      else imagesConfig = activeSlot;
    }
    let responsesKey = await GetStoredAPIKey("responses").catch(() => "");
    let imagesKey = await GetStoredAPIKey("images").catch(() => "");
    let clearedLegacy = false;
    if (!responsesKey && legacyResponsesKey) {
      try {
        await SetStoredAPIKey("responses", legacyResponsesKey);
        responsesKey = legacyResponsesKey;
        clearedLegacy = true;
      } catch {}
    }
    if (!imagesKey && legacyImagesKey) {
      try {
        await SetStoredAPIKey("images", legacyImagesKey);
        imagesKey = legacyImagesKey;
        clearedLegacy = true;
      } catch {}
    }
    if (clearedLegacy) clearLegacyAPIKeys();
    responsesConfig = { ...responsesConfig, apiKey: responsesKey || legacyResponsesKey };
    imagesConfig = { ...imagesConfig, apiKey: imagesKey || legacyImagesKey };
    const activeConfig = apiMode === "responses" ? responsesConfig : imagesConfig;
    // 顶层镜像 = 当前形态的槽
    const baseURL = activeConfig.baseURL;
    const textModelID = activeConfig.textModelID;
    const imageModelID = activeConfig.imageModelID;
    const activeKey = activeConfig.apiKey;
    // Apply theme + font scale to root immediately.
    applyTheme(theme);
    document.documentElement.style.setProperty("--font-scale", String(fontScale));
    // 用户自定义输出目录 —— 推给 backend,并记为可信输出根。
    const trustedRoots = new Set(loadTrustedOutputRoots());
    try {
      const customOutput = localStorage.getItem("gptcodex.outputDir");
      if (customOutput && customOutput.trim()) {
        await SetOutputDir(customOutput).catch(() => undefined);
        trustedRoots.add(customOutput.trim());
      }
    } catch {}
    const effectiveOutput = await GetOutputDir().catch(() => "");
    if (effectiveOutput) trustedRoots.add(effectiveOutput);
    for (const root of trustedRoots) rememberTrustedOutputRoot(root);
    await registerTrustedOutputRoots(Array.from(trustedRoots));
    // Make sure there's always at least one workspace.
    const wsId = genId();
    const initialWorkspace: Workspace = {
      id: wsId,
      name: "图片 1",
      prompt: "",
      negativePrompt: "",
      mode: "generate",
      size: "1024x1024",
      quality: "medium",
      outputFormat,
      seed: 0,
      batchCount: 1,
      sources: [],
      currentImageId: null,
    };
    set({
      apiKey: activeKey, history: trimHistory(items), promptHistory, presets, theme, fontScale,
      apiMode, baseURL, textModelID, imageModelID, transport, noPromptRevision,
      outputFormat,
      responsesConfig, imagesConfig,
      workspaces: [initialWorkspace],
      activeWorkspaceId: wsId,
      // 首次启动:当前形态的 apiKey 或 baseURL 任一缺失 → 自动弹上游配置。
      upstreamModalOpen: !activeKey.trim() || !baseURL.trim(),
    });
  },

  setMaskDataURL: (v) => set({ maskDataURL: v }),

  pushStroke: (stroke) => {
    const before = get().strokes;
    const after = [...before, stroke];
    const entry: UndoEntry = {
      label: "stroke",
      undo: (s) => ({ strokes: s.strokes.slice(0, -1) }),
      redo: () => ({ strokes: [...get().strokes, stroke] }),
    };
    set({
      strokes: after,
      undoStack: [...get().undoStack, entry],
      redoStack: [],
    });
  },

  resetMask: () => {
    const before = get().strokes;
    if (before.length === 0) return;
    const entry: UndoEntry = {
      label: "clear-mask",
      undo: () => ({ strokes: before, maskDataURL: get().maskDataURL }),
      redo: () => ({ strokes: [], maskDataURL: null }),
    };
    set({
      strokes: [],
      maskDataURL: null,
      undoStack: [...get().undoStack, entry],
      redoStack: [],
    });
  },

  addAnnotation: (a) => {
    const entry: UndoEntry = {
      label: "annotation",
      undo: (s) => ({ annotations: s.annotations.filter((x) => x.id !== a.id) }),
      redo: () => ({ annotations: [...get().annotations, a] }),
    };
    set({
      annotations: [...get().annotations, a],
      undoStack: [...get().undoStack, entry],
      redoStack: [],
    });
  },

  removeAnnotation: (id) => {
    const target = get().annotations.find((a) => a.id === id);
    if (!target) return;
    const entry: UndoEntry = {
      label: "remove-annotation",
      undo: (s) => ({ annotations: [...s.annotations, target] }),
      redo: () => ({ annotations: get().annotations.filter((x) => x.id !== id) }),
    };
    set({
      annotations: get().annotations.filter((a) => a.id !== id),
      selectedAnnotationId: get().selectedAnnotationId === id ? null : get().selectedAnnotationId,
      undoStack: [...get().undoStack, entry],
      redoStack: [],
    });
  },

  updateAnnotation: (id, patch) => {
    set({
      annotations: get().annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    });
  },

  clearAnnotations: () => {
    const before = get().annotations;
    if (before.length === 0) return;
    const entry: UndoEntry = {
      label: "clear-annotations",
      undo: () => ({ annotations: before }),
      redo: () => ({ annotations: [] }),
    };
    set({
      annotations: [],
      undoStack: [...get().undoStack, entry],
      redoStack: [],
    });
  },

  undo: () => {
    const stack = get().undoStack;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    const patch = entry.undo(get());
    set({
      ...(patch as any),
      undoStack: stack.slice(0, -1),
      redoStack: [...get().redoStack, entry],
    });
  },

  redo: () => {
    const stack = get().redoStack;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    const patch = entry.redo(get());
    set({
      ...(patch as any),
      redoStack: stack.slice(0, -1),
      undoStack: [...get().undoStack, entry],
    });
  },

  setCompareB: (item) => {
    if (!item) {
      set({ compareB: null, compareSplit: 0.5 });
      return;
    }
    void ensureFullHistoryItem(item).then((full) => {
      if (full) set({ compareB: full, compareSplit: 0.5 });
    });
  },
  setCompareSplit: (v) => set({ compareSplit: Math.max(0, Math.min(1, v)) }),

  pushToast: (text, kind = "info", ttl = 3500, action) => {
    const id = genId();
    const toast: Toast = { id, text, kind, createdAt: Date.now(), ttl, action };
    set({ toasts: [...get().toasts, toast] });
    if (ttl > 0) {
      setTimeout(() => {
        set({ toasts: get().toasts.filter((t) => t.id !== id) });
      }, ttl);
    }
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  resultDetail: null,
  openResultDetail: async (item) => {
    const full = await ensureFullHistoryItem(item);
    set({ resultDetail: full ?? item });
  },
  closeResultDetail: () => set({ resultDetail: null }),
  materializeCurrentImage: async (item) => {
    const full = await ensureFullHistoryItem(item);
    return full ?? item;
  },

  rotateCurrent: async (degrees) => {
    let cur = get().currentImage;
    if (!cur) {
      get().pushToast("当前没有图片", "warn");
      return;
    }
    cur = await materializeHistoryItem(cur).catch((e: any) => {
      get().pushToast(`当前图无法落盘:${e?.message ?? e}`, "error");
      return null;
    });
    if (!cur?.savedPath) return;
    try {
      const r = await RotateImage(cur.savedPath, degrees);
      await loadTransformedAsCurrent(r.path);
      get().pushToast(`已旋转 ${degrees}°`, "success");
    } catch (e: any) {
      get().pushToast(`旋转失败:${e?.message ?? e}`, "error");
    }
  },

  flipCurrent: async (horizontal) => {
    let cur = get().currentImage;
    if (!cur) {
      get().pushToast("当前没有图片", "warn");
      return;
    }
    cur = await materializeHistoryItem(cur).catch((e: any) => {
      get().pushToast(`当前图无法落盘:${e?.message ?? e}`, "error");
      return null;
    });
    if (!cur?.savedPath) return;
    try {
      const r = await FlipImage(cur.savedPath, horizontal);
      await loadTransformedAsCurrent(r.path);
      get().pushToast(horizontal ? "已水平翻转" : "已竖直翻转", "success");
    } catch (e: any) {
      get().pushToast(`翻转失败:${e?.message ?? e}`, "error");
    }
  },

  cropToRect: async (x, y, w, h) => {
    let cur = get().currentImage;
    if (!cur) {
      get().pushToast("当前没有图片", "warn");
      return;
    }
    cur = await materializeHistoryItem(cur).catch((e: any) => {
      get().pushToast(`当前图无法落盘:${e?.message ?? e}`, "error");
      return null;
    });
    if (!cur?.savedPath) return;
    try {
      const r = await CropImage(cur.savedPath, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      await loadTransformedAsCurrent(r.path);
      get().pushToast(`已裁出 ${Math.round(w)}×${Math.round(h)}`, "success");
    } catch (e: any) {
      get().pushToast(`裁剪失败:${e?.message ?? e}`, "error");
    }
  },

  savePreset: (name) => {
    const s = get();
    const trimmed = name.trim();
    if (!trimmed) return;
    const p: Preset = {
      id: genId(),
      name: trimmed,
      size: s.size,
      quality: s.quality,
      outputFormat: s.outputFormat,
      negativePrompt: s.negativePrompt,
      transport: s.transport,
      batchCount: s.batchCount,
    };
    const next = [...s.presets, p];
    set({ presets: next });
    try { localStorage.setItem("gptcodex.presets", JSON.stringify(next)); } catch {}
    get().pushToast(`已保存预设「${trimmed}」`, "success");
  },

  applyPreset: (id) => {
    const p = get().presets.find((x) => x.id === id);
    if (!p) return;
    set({
      size: p.size,
      quality: p.quality,
      outputFormat: p.outputFormat ?? get().outputFormat,
      negativePrompt: p.negativePrompt,
      transport: p.transport,
      batchCount: p.batchCount,
    });
    get().pushToast(`已应用预设「${p.name}」`, "success");
  },

  deletePreset: (id) => {
    const next = get().presets.filter((p) => p.id !== id);
    set({ presets: next });
    try { localStorage.setItem("gptcodex.presets", JSON.stringify(next)); } catch {}
  },

  exportHistory: async () => {
    const s = get();
    if (s.history.length === 0) {
      s.pushToast("没有可导出的历史记录", "warn");
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      count: s.history.length,
      items: s.history.map(sanitizeHistoryForExport),
    };
    try {
      const dst = await ExportHistoryToFile(JSON.stringify(payload, null, 2));
      if (dst) s.pushToast(`已导出 ${s.history.length} 条 → ${dst.split(/[\\/]/).pop()}`, "success");
    } catch (e: any) {
      s.pushToast(`导出失败:${e?.message ?? e}`, "error");
    }
  },

  setTheme: (t) => {
    set({ theme: t });
    try { localStorage.setItem("gptcodex.theme", t); } catch {}
    applyTheme(t);
  },

  setFontScale: (v) => {
    set({ fontScale: v });
    try { localStorage.setItem("gptcodex.fontScale", String(v)); } catch {}
    document.documentElement.style.setProperty("--font-scale", String(v));
  },

  testAPIKey: async () => {
    const s = get();
    if (!s.apiKey.trim()) {
      s.pushToast("先填入 API Key", "warn");
      return;
    }
    if (!s.baseURL.trim()) {
      s.pushToast("先在右侧工作栏顶部的「上游配置」中填入中转站地址", "warn", 5000);
      return;
    }
    const cleanedBaseURL = cleanBaseURL(s.baseURL);
    const baseURLError = validateBaseURL(cleanedBaseURL);
    if (baseURLError) {
      s.pushToast(baseURLError, "error", 6000);
      return;
    }
    if (s.isTestingKey) return;
    set({ isTestingKey: true });
    s.pushToast("正在测试连接...", "info", 8000);
    try {
      // Fire-and-forget tiny generation; success = key works.
      const r = await wailsGenerate({
        apiKey: s.apiKey,
        mode: "generate",
        prompt: "a red dot",
        size: "1024x1024",
        quality: "low",
        outputFormat: "png",
        imagePaths: [],
        imagePath: "",
        maskB64: "",
        seed: 0,
        negativePrompt: "",
        baseURL: cleanedBaseURL,
        textModelID: s.textModelID,
        imageModelID: s.imageModelID,
        transport: s.transport,
        apiMode: s.apiMode,
        noPromptRevision: s.noPromptRevision,
      } as any);
      // We don't actually wait for the image; the job is queued in backend.
      // Cancel right after to avoid burning quota.
      setTimeout(() => { wailsCancel(r.jobId).catch(() => undefined); }, 800);
      set({ isTestingKey: false });
      s.pushToast("连接 OK · 上游接受了请求(已取消)", "success");
    } catch (e: any) {
      set({ isTestingKey: false });
      s.pushToast(`连接失败:${e?.message ?? e}`, "error", 6000);
    }
  },

  newWorkspace: (name) => {
    const s = get();
    // Persist current top-level fields into the active workspace first.
    const persisted = saveActiveWorkspaceSnapshot(s);
    const id = genId();
    const newW: Workspace = {
      id,
      name: name ?? `图片 ${persisted.length + 1}`,
      prompt: "",
      negativePrompt: "",
      mode: "generate",
      size: "1024x1024",
      quality: "medium",
      outputFormat: s.outputFormat,
      seed: 0,
      batchCount: 1,
      sources: [],
      currentImageId: null,
    };
    set({
      workspaces: [...persisted, newW],
      activeWorkspaceId: id,
      // Reset top-level form state to the new workspace's defaults.
      prompt: newW.prompt,
      negativePrompt: newW.negativePrompt,
      mode: newW.mode,
      size: newW.size,
      quality: newW.quality,
      outputFormat: newW.outputFormat,
      seed: newW.seed,
      batchCount: newW.batchCount,
      sources: newW.sources,
      currentImage: null,
      annotations: [],
      strokes: [],
      maskDataURL: null,
    });
  },

  switchWorkspace: (id) => {
    const s = get();
    if (s.activeWorkspaceId === id) return;
    const persisted = saveActiveWorkspaceSnapshot(s);
    const target = persisted.find((w) => w.id === id);
    if (!target) return;
    const newCurrent = target.currentImageId
      ? s.history.find((h) => h.id === target.currentImageId) ?? null
      : null;
    set({
      workspaces: persisted,
      activeWorkspaceId: id,
      prompt: target.prompt,
      negativePrompt: target.negativePrompt,
      mode: target.mode,
      size: target.size,
      quality: target.quality,
      outputFormat: target.outputFormat ?? get().outputFormat,
      seed: target.seed,
      batchCount: target.batchCount,
      sources: target.sources,
      currentImage: newCurrent,
      annotations: [],
      strokes: [],
      maskDataURL: null,
    });
  },

  closeWorkspace: (id) => {
    const s = get();
    if (s.workspaces.length <= 1) {
      s.pushToast("至少保留一个标签页", "warn");
      return;
    }
    const remaining = s.workspaces.filter((w) => w.id !== id);
    // If we're closing the active one, switch to a neighbour first.
    if (s.activeWorkspaceId === id) {
      const next = remaining[0];
      const newCurrent = next.currentImageId
        ? s.history.find((h) => h.id === next.currentImageId) ?? null
        : null;
      set({
        workspaces: remaining,
        activeWorkspaceId: next.id,
        prompt: next.prompt,
        negativePrompt: next.negativePrompt,
        mode: next.mode,
        size: next.size,
        quality: next.quality,
        outputFormat: next.outputFormat ?? get().outputFormat,
        seed: next.seed,
        batchCount: next.batchCount,
        sources: next.sources,
        currentImage: newCurrent,
        annotations: [],
        strokes: [],
        maskDataURL: null,
      });
    } else {
      set({ workspaces: remaining });
    }
  },

  renameWorkspace: (id, name) => {
    set({
      workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
    });
  },

  importHistory: async () => {
    const s = get();
    try {
      const json = await ImportHistoryFromFile();
      if (!json) return;
      const parsed = JSON.parse(json);
      const incoming: HistoryItem[] = Array.isArray(parsed?.items) ? parsed.items : [];
      if (incoming.length === 0) {
        s.pushToast("文件里没有历史记录", "warn");
        return;
      }
      // Merge by id; existing items win on conflict.
      const existing = new Set(s.history.map((h) => h.id));
      const merged = [...s.history];
      let added = 0;
      for (const item of incoming) {
        if (!item.id || existing.has(item.id)) continue;
        if (!item.imageB64 || !item.createdAt) continue;
        const safeItem = sanitizeImportedHistoryItem(item);
        merged.push(safeItem);
        await persistHistoryItem(safeItem).catch(() => undefined);
        added++;
      }
      merged.sort((a, b) => b.createdAt - a.createdAt);
      const trimmed = trimHistory(merged);
      set({ history: trimmed });
      persistTrimmedHistory(trimmed);
      s.pushToast(`已导入 ${added} 条(跳过 ${incoming.length - added} 条重复/无效)`, "success");
    } catch (e: any) {
      s.pushToast(`导入失败:${e?.message ?? e}`, "error");
    }
  },

  retryLast: async () => {
    const s = get();
    if (!s.lastPayload || s.isRunning) return;
    set({ errorMessage: null });
    // Re-invoke submit, which will rebuild the payload from current state.
    // (We don't reuse lastPayload verbatim so any tweaks the user made
    // after the failure — different seed, different prompt — take effect.)
    await get().submit();
  },

  importImageFile: async (file) => {
    try {
      if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
        set({ errorMessage: `不支持的图片类型:${file.type || "(未知)"},请用 PNG/JPG/WebP` });
        return;
      }
      const b64 = await fileToBase64(file);
      const result = await ImportImageFromB64(b64, file.name);
      const previewB64 = await createPreviewB64(b64);
      const previewBlob = base64ToBlob(previewB64);
      const fullBlob = base64ToBlob(b64);
      const fullItem: HistoryItem = {
        id: genId(),
        imageB64: b64,
        imageBlob: fullBlob,
        previewBlob,
        prompt: `(导入)${file.name}`,
        mode: "edit",
        size: "1024x1024",
        quality: "medium",
        createdAt: Date.now(),
        savedPath: result.path,
      };
      const item: HistoryItem = {
        ...fullItem,
        imageB64: previewB64,
        previewOnly: previewB64 !== b64,
      };
      await persistHistoryItem(item);
      await persistHistoryFullImage(item.id, b64).catch(() => undefined);
      const existingSources = get().sources;
      const alreadyIn = existingSources.some((s) => s.path === result.path);
      const trimmed = trimHistory([item, ...get().history]);
      set({
        currentImage: fullItem,
        history: trimmed,
        mode: "edit",
        sources: alreadyIn
          ? existingSources
          : [...existingSources, { path: result.path, name: file.name, size: file.size, imageB64: b64 }],
        errorMessage: null,
      });
      persistTrimmedHistory(trimmed);
    } catch (e: any) {
      set({ errorMessage: `导入失败:${e?.message ?? e}` });
    }
  },
}));

// Toast actions inserted at end of store factory below via patch.
// 把一次旋转 / 翻转 / 裁剪的产物挂到 currentImage 上 —— 是「就地编辑」语义,
// 不是新的生成事件,因此:
//   1) 不创建新的 HistoryItem,不 persistHistoryItem,不 prepend 进 history 列表
//      → 历史栏只保留真正"花了 token 的生成",连续旋转十次也不会刷十条历史
//   2) 把当前 HistoryItem 的 imageB64 / savedPath 换成新文件的;id / prompt /
//      参数都保留(原始那一条史 history[] 里的引用是不同对象,不受影响 ——
//      画布显示旋转版,历史栏依然显示原图)
//   3) 旋转 / 翻转后清空 mask + 标注,因为它们的坐标系是基于旧图的
//   4) 触发 canvasViewResetTick 让 CanvasStage 重新 fit,因为旋转 90 度时
//      W↔H 互换,残留 userView 会让图飞到边外
async function loadTransformedAsCurrent(path: string) {
  const store = useStudioStore.getState();
  try {
    const b64 = await ReadImageAsBase64(path);
    const baseName = path.split(/[\\/]/).pop() ?? "transformed.png";
    const cur = store.currentImage;
    const updated: HistoryItem = cur
      ? { ...cur, imageB64: b64, savedPath: path }
      : {
          id: cryptoIDFallback(),
          imageB64: b64,
          prompt: `(变换)${baseName}`,
          mode: "edit",
          size: store.size,
          quality: store.quality,
          createdAt: Date.now(),
          savedPath: path,
        };
    // Replace the first source with the new transformed file so the next
    // edit call uses it; keep the rest of sources intact.
    const nextSources = store.sources.length > 0
      ? [{ path, name: baseName, size: 0, imageB64: b64 }, ...store.sources.slice(1)]
      : [{ path, name: baseName, size: 0, imageB64: b64 }];
    useStudioStore.setState({
      currentImage: updated,
      sources: nextSources,
      mode: "edit",
      // 旋转/翻转/裁剪改变了图像坐标系,必须清掉残留的画笔与标注。
      maskDataURL: null,
      strokes: [],
      annotations: [],
      // 让 CanvasStage 的视图 / 蒙版重置 effect 重新触发(它依赖此 tick)。
      canvasViewResetTick: useStudioStore.getState().canvasViewResetTick + 1,
    });
  } catch (e: any) {
    useStudioStore.getState().pushToast(`加载变换结果失败:${e?.message ?? e}`, "error");
  }
}

async function materializeHistoryItem(item: HistoryItem): Promise<HistoryItem> {
  if (item.savedPath) return item;
  const imported = await ImportImageFromB64(item.imageB64, suggestedImportNameForHistory(item));
  const next: HistoryItem = { ...item, savedPath: imported.path };
  const state = useStudioStore.getState();
  useStudioStore.setState({
    currentImage: state.currentImage?.id === item.id ? next : state.currentImage,
    history: state.history.map((h) => (h.id === item.id ? next : h)),
  });
  await persistHistoryItem(next).catch(() => undefined);
  return next;
}

async function ensureFullHistoryItem(item: HistoryItem | null): Promise<HistoryItem | null> {
  if (!item) return null;
  if (!item.savedPath || !item.previewOnly) return item;
  try {
    let fullB64 = await ReadImageAsBase64(item.savedPath).catch(() => "");
    if (!fullB64) {
      fullB64 = await loadHistoryFullImage(item.id).catch(() => "");
    }
    if (!fullB64) return item;
    const next: HistoryItem = { ...item, imageB64: fullB64, imageBlob: base64ToBlob(fullB64), previewOnly: false };
    const state = useStudioStore.getState();
    useStudioStore.setState({
      currentImage: state.currentImage?.id === item.id ? next : state.currentImage,
      resultDetail: state.resultDetail?.id === item.id ? next : state.resultDetail,
      compareB: state.compareB?.id === item.id ? next : state.compareB,
    });
    return next;
  } catch {
    return item;
  }
}

function cryptoIDFallback(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {}
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// Fire one job (concurrent member of a batch). Registers its own EventsOn
// callbacks; updates store.runningJobs / jobsCompleted as the run progresses.
// `snapshot` is the store state at submit time — captures size/quality/sources
// so per-job result writes still see the originating context.
async function launchOneJob(
  mode: string,
  payload: backend.GenerateOptions,
  snapshot: {
    size: SizeValue;
    quality: QualityValue;
    outputFormat: OutputFormatValue;
    sources: SourceImage[];
    currentImage: HistoryItem | null;
    styleTag: string;
    transport: TransportKind;
  },
): Promise<void> {
  const store = useStudioStore;
  try {
    const started = mode === "edit"
      ? await wailsEdit(payload)
      : await wailsGenerate(payload);
    const jobId = started.jobId;
    store.setState({ runningJobs: [...store.getState().runningJobs, jobId] });

    let offProgress = () => {};
    let offLog = () => {};
    let offResult = () => {};
    let offError = () => {};
    const cleanup = () => { offProgress(); offLog(); offResult(); offError(); };
    const removeFromRunning = () => {
      const remaining = store.getState().runningJobs.filter((id) => id !== jobId);
      const completed = store.getState().jobsCompleted + 1;
      store.setState({
        runningJobs: remaining,
        jobsCompleted: completed,
        isRunning: remaining.length > 0,
        progress: remaining.length === 0 ? null : store.getState().progress,
      });
    };

    offProgress = EventsOn(`progress:${jobId}`, (p: ProgressInfo) => {
      // Only show latest progress (any concurrent job). Sufficient for UX.
      store.setState({ progress: p });
    });
    offLog = EventsOn(`log:${jobId}`, (line: string) => {
      store.setState({ lastLogLine: line });
    });

    const startedAt = Date.now();
    offResult = EventsOn(`result:${jobId}`, (r: any) => {
      cleanup();
      void (async () => {
      try {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rd = [elapsedSec, ...store.getState().recentDurations].slice(0, 5);
        const willNotify = typeof document !== "undefined" && document.visibilityState !== "visible";
        const previewB64 = await createPreviewB64(r.imageB64);
        const previewBlob = base64ToBlob(previewB64);
        const fullBlob = base64ToBlob(r.imageB64);
        const fullItem: HistoryItem = {
          id: cryptoIDFallback(),
          imageB64: r.imageB64,
          imageBlob: fullBlob,
          previewBlob,
          prompt: r.prompt,
          revisedPrompt: r.revisedPrompt,
          mode: r.mode as Mode,
          size: snapshot.size,
          quality: snapshot.quality,
          outputFormat: snapshot.outputFormat,
          parentId: mode === "edit" ? (snapshot.sources[0]?.path || snapshot.currentImage?.savedPath) : undefined,
          createdAt: Date.now(),
          seed: payload.seed || undefined,
          negativePrompt: payload.negativePrompt || undefined,
          styleTag: snapshot.styleTag || undefined,
          transport: snapshot.transport,
          elapsedSec: Number(elapsedSec.toFixed(1)),
          savedPath: r.savedPath,
          rawPath: r.rawPath,
        };
        const item: HistoryItem = {
          ...fullItem,
          imageB64: previewB64,
          previewOnly: previewB64 !== r.imageB64,
        };
        persistHistoryItem(item).catch(() => undefined);
        persistHistoryFullImage(item.id, r.imageB64).catch(() => undefined);
        // Always set the latest result as currentImage so the canvas updates
        // even when multiple jobs land within the same React tick.
        const trimmed = trimHistory([item, ...store.getState().history]);
        store.setState({
          currentImage: fullItem,
          history: trimmed,
          maskDataURL: null,
          annotations: [],
          tool: "pan",
          recentDurations: rd,
        });
        persistTrimmedHistory(trimmed);
        // 桌面通知 —— 点击拉前台 + 直达详情抽屉
        if (willNotify) {
          tryNotify("Image Studio · 已完成", r.prompt ?? "", () => {
            store.getState().openResultDetail(fullItem);
          });
        }
        const total = store.getState().jobsTotal;
        const completedAfter = store.getState().jobsCompleted + 1;
        store.getState().pushToast(
          total > 1
            ? `已完成 (${completedAfter}/${total}) · ${elapsedSec.toFixed(0)}s`
            : `已${fullItem.mode === "edit" ? "编辑" : "生成"} · ${elapsedSec.toFixed(0)}s`,
          "success",
          6000,
          { label: "查看详情", onClick: () => store.getState().openResultDetail(fullItem) },
        );
        removeFromRunning();
      } catch (err: any) {
        store.setState({ errorMessage: `处理结果失败:${err?.message ?? err}` });
        removeFromRunning();
      }
      })();
    });
    offError = EventsOn(`error:${jobId}`, (e: { message: string }) => {
      cleanup();
      store.setState({ errorMessage: e?.message ?? "未知错误" });
      removeFromRunning();
    });
  } catch (e: any) {
    store.setState({
      errorMessage: `提交失败:${e?.message ?? e}`,
      isRunning: false,
    });
  }
}

// Capture the active workspace's mutable fields from top-level state.
// Returns the new workspaces array with the snapshot merged in. If the
// workspace has the default `图片 N` name and a prompt has been entered,
// auto-rename the tab to the first 18 chars of the prompt for context.
function saveActiveWorkspaceSnapshot(s: StudioState): Workspace[] {
  if (!s.activeWorkspaceId) return s.workspaces;
  return s.workspaces.map((w) => {
    if (w.id !== s.activeWorkspaceId) return w;
    let name = w.name;
    const hasDefaultName = /^图片 \d+$/.test(w.name);
    if (hasDefaultName && s.prompt.trim()) {
      const concise = s.prompt.trim().replace(/\s+/g, " ").slice(0, 18);
      name = concise || w.name;
    }
    return {
      ...w,
      name,
      prompt: s.prompt,
      negativePrompt: s.negativePrompt,
      mode: s.mode,
      size: s.size,
      quality: s.quality,
      outputFormat: s.outputFormat,
      seed: s.seed,
      batchCount: s.batchCount,
      sources: s.sources,
      currentImageId: s.currentImage?.id ?? null,
    };
  });
}

function tryNotify(title: string, body: string, onClick?: () => void) {
  try {
    if (typeof Notification === "undefined") return;
    const fire = () => {
      const n = new Notification(title, { body });
      if (onClick) {
        n.onclick = () => {
          try { window.focus(); } catch {}
          onClick();
          n.close();
        };
      }
    };
    if (Notification.permission === "granted") {
      fire();
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") fire();
      });
    }
  } catch { /* ignore */ }
}

const STYLE_SUFFIXES: Record<string, string> = {
  cyberpunk: "cyberpunk style, neon lights, glowing reflections, futuristic",
  anime: "anime style, cel shading, vibrant colors, detailed illustration",
  illust: "modern illustration, flat colors, clean lines",
  "3d": "3D render, octane render, ray tracing, glossy surfaces, studio lighting",
  chinese: "traditional Chinese painting style, ink wash, misty landscape",
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataURL = reader.result as string;
      const idx = dataURL.indexOf(",");
      resolve(idx >= 0 ? dataURL.slice(idx + 1) : dataURL);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export { tempDataURLFromB64, writeBase64ToTempFile };
