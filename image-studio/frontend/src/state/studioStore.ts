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
  OptimizePrompt as wailsOptimizePrompt,
  Cancel as wailsCancel,
  OpenImageDialog,
  GetOutputDir,
  DeleteStoredAPIKey,
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
  APIMode,
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
  UpstreamProfile,
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
import {
  ACTIVE_PROFILE_LS_KEY,
  PROFILES_LS_KEY,
  apiModeLabel as profileApiModeLabel,
  duplicateProfile as cloneProfile,
  genProfileId,
  keyringUserFor,
  makeBlankProfile,
  pickActiveProfile,
  tryParseProfile,
} from "../lib/profiles";
import { base64ToBlob, blobToBase64, createPreviewBlob, getImageDimensionsFromBase64 } from "../lib/images";
import { isWindows } from "../lib/platform";
import { exportHistoryForPlatform, saveImageForPlatform } from "../lib/androidBridge";
import {
  activeRuntimePatch,
  apiModeLabel,
  normalizeBatchCount,
  normalizeConcurrencyLimit,
  patchWorkspaceRuntime,
  workspaceRuntimeFromState,
  workspaceRunningCount,
  type APIModeValue,
  type RunningJobMeta,
  type WorkspacePatch,
} from "./workspaceRuntime";

// 单个 API 形态的上游 5 字段(去掉 apiMode 本身)。
// 其中 apiKey 只进后端凭据存储;其余字段走 localStorage。
export interface ModeConfig {
  baseURL: string;
  apiKey: string;
  textModelID: string;
  imageModelID: string;
  // 0 = unlimited. Positive values cap concurrently running jobs for this
  // upstream API shape across all tabs.
  concurrencyLimit: number;
}

export interface PromptOptimizeRequest {
  apiKey: string;
  prompt: string;
  mode: Mode;
  baseURL: string;
  textModelID: string;
  imagePaths: string[];
  imagePath: string;
}

const EMPTY_MODE_CFG: ModeConfig = { baseURL: "", apiKey: "", textModelID: "", imageModelID: "", concurrencyLimit: 0 };
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
  const r = (k: Exclude<keyof ModeConfig, "apiKey" | "concurrencyLimit">): string => {
    try { return localStorage.getItem(`gptcodex.${mode}.${k}`) ?? ""; } catch { return ""; }
  };
  const limit = (() => {
    try {
      const raw = localStorage.getItem(`gptcodex.${mode}.concurrencyLimit`) ?? "";
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    } catch {
      return 0;
    }
  })();
  return {
    baseURL: r("baseURL"),
    apiKey: "",
    textModelID: r("textModelID"),
    imageModelID: r("imageModelID"),
    concurrencyLimit: limit,
  };
}

function saveModeField(mode: "responses" | "images", field: Exclude<keyof ModeConfig, "apiKey">, value: string | number) {
  try { localStorage.setItem(`gptcodex.${mode}.${field}`, String(value)); } catch {}
}

// ---- v0.1.6 多 profile 持久化 ---------------------------------------------

// 把整个 profile 列表写 localStorage。apiKey 已经在 keyring,这里只存元数据。
function persistProfiles(list: UpstreamProfile[]) {
  try { localStorage.setItem(PROFILES_LS_KEY, JSON.stringify(list)); } catch {}
}

function persistActiveProfileId(id: string) {
  try {
    if (id) localStorage.setItem(ACTIVE_PROFILE_LS_KEY, id);
    else localStorage.removeItem(ACTIVE_PROFILE_LS_KEY);
  } catch {}
}

function loadStoredProfiles(): UpstreamProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => tryParseProfile(x)).filter((p): p is UpstreamProfile => p !== null);
  } catch {
    return [];
  }
}

function loadStoredActiveProfileId(): string {
  try { return localStorage.getItem(ACTIVE_PROFILE_LS_KEY) ?? ""; } catch { return ""; }
}

// 清理 v0.1.5 及之前的「按 mode 二选一」遗留 localStorage 键。
// 迁移到 profile 列表之后调一次,避免下次启动还重复迁移。
function clearLegacyModeLocalStorage() {
  for (const mode of ["responses", "images"] as const) {
    for (const field of ["baseURL", "textModelID", "imageModelID", "concurrencyLimit"]) {
      try { localStorage.removeItem(`gptcodex.${mode}.${field}`); } catch {}
    }
  }
  try { localStorage.removeItem("gptcodex.apiMode"); } catch {}
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

  // 顶层「当前生效」上游字段 —— 它们都是 active profile 的实时镜像,只读。
  // 改这些字段必须走 updateProfile / setActiveProfile,不能用 setField。
  // 组件 (ControlPanel / submit) 继续读这几个字段,保持向后兼容。
  baseURL: string;
  textModelID: string;
  imageModelID: string;
  // 上游 API 形态(active profile 的字段镜像):
  //   "responses" — POST /v1/responses + SSE 流式保活(防 CF 524)
  //   "images"    — 标准 OpenAI Images API,POST /v1/images/generations + /v1/images/edits
  apiMode: APIMode;
  // 关掉 Responses API 的 prompt 改写(顶层加 instructions 让模型逐字使用)。
  // 对 Images API 无效但留着不影响。全局偏好,不分 profile。
  noPromptRevision: boolean;

  // v0.1.6:多上游配置支持。用户可以保存多个 profile,通过 UpstreamConfigModal
  // 编辑,通过 ControlPanel 的 dropdown 切。
  profiles: UpstreamProfile[];
  // 当前激活的 profile id。若 activeProfileId 不在 profiles 里(被删了 / 数据
  // 损坏),pickActiveProfile 回退到 lastUsedAt 最大的那条;空列表则为 ""。
  activeProfileId: string;
  // Multi-reference source images. The legacy single-source UI now feeds into
  // and reads from this list. Empty list + currentImage on the canvas triggers
  // a fallback where the canvas image is used as the implicit source.
  sources: SourceImage[];

  // ---- Runtime ----
  // List of concurrently running job IDs (batch parallel). Empty when idle.
  // Active-workspace scoped mirror for the currently selected tab.
  runningJobs: string[];
  // Total jobs in current batch, completed so far. Used by StatusBar.
  jobsTotal: number;
  jobsCompleted: number;
  progress: ProgressInfo | null;
  lastLogLine: string;
  errorMessage: string | null;
  // 失败时上游原始响应文件的绝对路径(SSE 文本 / Images API JSON)。前端
  // 错误条幅上的「查看日志」按钮用它调 OpenFile 让系统默认应用打开。
  // 请求都没发出就失败的早期错误(参数校验、transport 初始化)RawPath 为空。
  errorRawPath: string | null;
  isRunning: boolean;
  // Snapshot of the last successfully-built payload, used by the retry button
  // on the error banner. Null when there's nothing to retry.
  lastPayload: backend.GenerateOptions | null;
  // Global registry used to route progress/results back to their originating
  // workspace and to enforce upstream concurrency limits.
  runningJobMeta: Record<string, RunningJobMeta>;

  // ---- Result + history ----
  currentImage: HistoryItem | null;
  history: HistoryItem[];
  batchResults: HistoryItem[];
  resultGridOpen: boolean;

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
  // 写当前 active profile 的 apiKey 到 keyring(无 active profile 时静默返回)。
  setAPIKey: (v: string) => Promise<void>;
  // 一次性清掉错误条幅相关的两个字段(errorMessage + errorRawPath)。
  // 比单独 setField 两次更不容易漏一边。
  clearError: () => void;

  // ---- Profile management (v0.1.6) ----
  // createProfile:新建一个 profile,自动给它分配 id,并(如果 apiKey 非空)写 keyring。
  //   返回新建 profile 的 id,UpstreamConfigModal 用它定位刚建的项。
  createProfile: (input: { name: string; apiMode: APIMode; baseURL?: string;
    textModelID?: string; imageModelID?: string; concurrencyLimit?: number;
    apiKey?: string; setActive?: boolean }) => Promise<string>;
  // updateProfile:就地改一个 profile 的字段。apiKey 若传入,同步写 keyring。
  //   返回 true 当且仅当 profile 存在并被修改。
  updateProfile: (id: string, patch: Partial<Omit<UpstreamProfile, "id" | "createdAt">> & { apiKey?: string }) => Promise<boolean>;
  // deleteProfile:删除 profile,顺手清掉 keyring 项;若被删的是 active,自动
  //   切到 lastUsedAt 最大的剩余 profile;若列表清空,弹首次配置 modal。
  deleteProfile: (id: string) => Promise<void>;
  // duplicateProfile:复制一份 profile,name 末尾追加「副本」,新 id;若源
  //   profile 有 keyring 项,复制一份到新 id 的 keyring 项。返回新 id。
  duplicateProfile: (id: string) => Promise<string | null>;
  // setActiveProfile:把指定 profile 设为 active,同步顶层镜像 + 写 localStorage。
  setActiveProfile: (id: string) => Promise<void>;
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
  openResultGrid: () => void;
  closeResultGrid: () => void;
  selectBatchResult: (item: HistoryItem) => Promise<void>;
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
  isOptimizingPrompt: boolean;
  optimizePrompt: () => Promise<void>;
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

function historyItemsByIds(history: HistoryItem[], ids: string[]): HistoryItem[] {
  if (ids.length === 0) return [];
  const byID = new Map(history.map((item) => [item.id, item]));
  return ids.map((id) => byID.get(id)).filter((item): item is HistoryItem => !!item);
}

async function ensureFullBatchItem(item: HistoryItem): Promise<HistoryItem> {
  return (await ensureFullHistoryItem(item)) ?? item;
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
  profiles: [],
  activeProfileId: "",
  sources: [],

  runningJobs: [],
  jobsTotal: 0,
  jobsCompleted: 0,
  progress: null,
  lastLogLine: "",
  errorMessage: null,
  errorRawPath: null,
  isRunning: false,
  lastPayload: null,
  runningJobMeta: {},

  currentImage: null,
  history: [],
  batchResults: [],
  resultGridOpen: false,

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
  isOptimizingPrompt: false,
  upstreamModalOpen: false,
  openUpstreamConfig: () => set({ upstreamModalOpen: true }),
  closeUpstreamConfig: () => set({ upstreamModalOpen: false }),
  workspaces: [],
  activeWorkspaceId: "",
  styleTag: "",

  setField: (key, value) => {
    // 上游字段(apiKey / baseURL / textModelID / imageModelID / apiMode)是
    // active profile 的派生镜像,直接 set 顶层不持久化,改完下次启动就丢。
    // 这些字段必须走 updateProfile / setActiveProfile 这两个 action。开发期
    // 抓一下,生产期还是 set 一下顶层让 UI 不爆炸。
    if (key === "apiMode" || key === "baseURL" || key === "apiKey" ||
        key === "textModelID" || key === "imageModelID") {
      if (typeof console !== "undefined") {
        console.warn(`setField("${String(key)}", ...) 不写持久化;改这个字段请用 updateProfile / setActiveProfile`);
      }
      set({ [key]: value } as any);
      return;
    }
    // 其他全局偏好字段
    const normalizedValue = key === "batchCount" ? normalizeBatchCount(value) : value;
    set({ [key]: normalizedValue } as any);
    if (key === "currentImage") {
      const item = normalizedValue as HistoryItem | null;
      set({
        compareB: null,
        resultGridOpen: false,
        workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, {
          currentImageId: item?.id ?? null,
          resultGridOpen: false,
        }),
      });
    } else if (key === "batchCount") {
      const value = normalizedValue as number;
      set({
        workspaces: get().workspaces.map((w) => (
          w.id === get().activeWorkspaceId ? { ...w, batchCount: value } : w
        )),
      });
    } else if (key === "errorMessage") {
      set({ workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, { errorMessage: value as string | null }) });
    } else if (key === "errorRawPath") {
      set({ workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, { errorRawPath: value as string | null }) });
    } else if (key === "lastPayload") {
      set({ workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, { lastPayload: value as backend.GenerateOptions | null }) });
    }
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
    const activeId = get().activeProfileId;
    if (!activeId) {
      // 没有 active profile,设 key 没意义;留个 warning 方便排查。
      if (typeof console !== "undefined") console.warn("setAPIKey: 没有 active profile,丢弃");
      return;
    }
    // 顶层镜像立即更新,UI 立即响应;keyring 写入异步
    set({ apiKey: trimmed });
    await SetStoredAPIKey(keyringUserFor(activeId), trimmed);
  },

  createProfile: async (input) => {
    const id = genProfileId();
    const profile: UpstreamProfile = {
      id,
      name: input.name.trim() || (input.apiMode === "images" ? "新配置 · Images" : "新配置 · Responses"),
      apiMode: input.apiMode,
      baseURL: cleanBaseURL(input.baseURL ?? ""),
      textModelID: (input.textModelID ?? "").trim(),
      imageModelID: (input.imageModelID ?? "").trim(),
      concurrencyLimit: normalizeConcurrencyLimit(input.concurrencyLimit ?? 0),
      createdAt: Date.now(),
    };
    if ((input.apiKey ?? "").trim()) {
      try { await SetStoredAPIKey(keyringUserFor(id), input.apiKey!.trim()); }
      catch (e: any) {
        if (typeof console !== "undefined") console.error("写 keyring 失败", e);
      }
    }
    const next = [...get().profiles, profile];
    persistProfiles(next);
    set({ profiles: next });
    if (input.setActive ?? true) {
      await get().setActiveProfile(id);
    }
    return id;
  },

  updateProfile: async (id, patch) => {
    const list = get().profiles;
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return false;
    const cur = list[i];
    const next: UpstreamProfile = {
      ...cur,
      name: patch.name !== undefined ? patch.name.trim() : cur.name,
      apiMode: patch.apiMode ?? cur.apiMode,
      baseURL: patch.baseURL !== undefined ? cleanBaseURL(patch.baseURL) : cur.baseURL,
      textModelID: patch.textModelID !== undefined ? patch.textModelID.trim() : cur.textModelID,
      imageModelID: patch.imageModelID !== undefined ? patch.imageModelID.trim() : cur.imageModelID,
      concurrencyLimit: patch.concurrencyLimit !== undefined
        ? normalizeConcurrencyLimit(patch.concurrencyLimit) : cur.concurrencyLimit,
      lastUsedAt: patch.lastUsedAt ?? cur.lastUsedAt,
    };
    const nextList = list.map((p, idx) => (idx === i ? next : p));
    persistProfiles(nextList);
    set({ profiles: nextList });
    if (patch.apiKey !== undefined) {
      try { await SetStoredAPIKey(keyringUserFor(id), patch.apiKey); }
      catch (e: any) {
        if (typeof console !== "undefined") console.error("写 keyring 失败", e);
      }
    }
    // 如果改的就是 active profile,镜像同步刷一遍
    if (id === get().activeProfileId) {
      const apiKey = patch.apiKey !== undefined ? patch.apiKey.trim() : get().apiKey;
      set({
        apiMode: next.apiMode,
        baseURL: next.baseURL,
        textModelID: next.textModelID,
        imageModelID: next.imageModelID,
        apiKey,
      });
    }
    return true;
  },

  deleteProfile: async (id) => {
    const list = get().profiles;
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const nextList = list.filter((_, i) => i !== idx);
    persistProfiles(nextList);
    // 顺手清 keyring,留着只会是孤儿项
    try { await DeleteStoredAPIKey(keyringUserFor(id)); }
    catch (e: any) {
      if (typeof console !== "undefined") console.warn("删 keyring 项失败(继续)", e);
    }
    set({ profiles: nextList });
    // 如果删的是 active,自动切到 lastUsedAt 最大的;空列表 → 弹首次配置
    if (get().activeProfileId === id) {
      const fallback = pickActiveProfile(nextList, "");
      if (fallback) {
        await get().setActiveProfile(fallback.id);
      } else {
        persistActiveProfileId("");
        set({
          profiles: nextList,
          activeProfileId: "",
          apiKey: "",
          baseURL: "",
          textModelID: "",
          imageModelID: "",
          apiMode: "responses",
          upstreamModalOpen: true,
        });
      }
    }
  },

  duplicateProfile: async (id) => {
    const cur = get().profiles.find((p) => p.id === id);
    if (!cur) return null;
    const cloned = cloneProfile(cur);
    // 把 keyring 里的 apiKey 也复制一份(避免新 profile 还得用户手动重填 key)
    try {
      const existingKey = await GetStoredAPIKey(keyringUserFor(id)).catch(() => "");
      if (existingKey) {
        await SetStoredAPIKey(keyringUserFor(cloned.id), existingKey);
      }
    } catch { /* keyring 异常不阻塞复制 */ }
    const next = [...get().profiles, cloned];
    persistProfiles(next);
    set({ profiles: next });
    return cloned.id;
  },

  setActiveProfile: async (id) => {
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile) return;
    persistActiveProfileId(id);
    // 镜像顶层字段
    const apiKey = await GetStoredAPIKey(keyringUserFor(id)).catch(() => "");
    // 更新 lastUsedAt 不写 keyring(只是元数据)
    const refreshed: UpstreamProfile = { ...profile, lastUsedAt: Date.now() };
    const nextProfiles = get().profiles.map((p) => p.id === id ? refreshed : p);
    persistProfiles(nextProfiles);
    set({
      profiles: nextProfiles,
      activeProfileId: id,
      apiMode: profile.apiMode,
      baseURL: profile.baseURL,
      textModelID: profile.textModelID,
      imageModelID: profile.imageModelID,
      apiKey,
    });
  },

  clearError: () => {
    const wsId = get().activeWorkspaceId;
    set({
      errorMessage: null,
      errorRawPath: null,
      workspaces: patchWorkspaceRuntime(get().workspaces, wsId, {
        errorMessage: null,
        errorRawPath: null,
      }),
    });
  },

  selectSourceImage: async () => {
    try {
      const res = await OpenImageDialog();
      if (!res || !res.path) return;
      const baseName = res.path.split(/[\\/]/).pop() ?? res.path;
      const existing = get().sources;
      if (existing.some((s) => s.path === res.path)) {
        set({ mode: "edit", errorMessage: null, errorRawPath: null });
        return;
      }
      set({
        sources: [...existing, { path: res.path, name: baseName, size: res.size }],
        mode: "edit",
        errorMessage: null,
        errorRawPath: null,
      });
    } catch (e: any) {
      set({ errorMessage: `选择图片失败:${e?.message ?? e}`, errorRawPath: null });
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
      set({ errorMessage: "请填写 API Key", errorRawPath: null });
      return;
    }
    if (!s.prompt.trim()) {
      set({ errorMessage: "请填写提示词", errorRawPath: null });
      return;
    }
    if (!s.baseURL.trim()) {
      set({ errorMessage: "请在右侧工作栏顶部的「上游配置」中填入你的中转站地址(必须兼容 OpenAI Responses API + image_generation 工具)", errorRawPath: null });
      return;
    }
    const cleanedBaseURL = cleanBaseURL(s.baseURL);
    const baseURLError = validateBaseURL(cleanedBaseURL);
    if (baseURLError) {
      set({ errorMessage: baseURLError, errorRawPath: null });
      return;
    }
    const batchCount = normalizeBatchCount(s.batchCount);
    const activeProfile = s.profiles.find((p) => p.id === s.activeProfileId);
    const concurrencyLimit = normalizeConcurrencyLimit(activeProfile?.concurrencyLimit ?? 0);
    if (concurrencyLimit > 0) {
      const activeCount = workspaceRunningCount(s, s.apiMode);
      const available = concurrencyLimit - activeCount;
      if (available < batchCount) {
        const apiLabel = s.apiMode === "responses" ? "Responses API" : "Images API";
        set({
          errorMessage: `${apiLabel} 并发限制 ${concurrencyLimit},当前还可提交 ${Math.max(0, available)} 个,本次需要 ${batchCount} 个。`,
          errorRawPath: null,
        });
        return;
      }
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
        set({ errorMessage: "图生图模式需要先添加源图(或从文件管理器拖图到画板)", errorRawPath: null });
        return;
      }
    }

    const workspaceId = s.activeWorkspaceId;
    const runPatch = {
      errorMessage: null,
      errorRawPath: null,
      progress: null,
      lastLogLine: "",
      isRunning: true,
      jobsTotal: batchCount,
      jobsCompleted: 0,
      runningJobs: [],
    };
    set({
      ...runPatch,
      batchCount,
      batchResults: [],
      resultGridOpen: batchCount > 1,
      workspaces: patchWorkspaceRuntime(s.workspaces, workspaceId, {
        ...runPatch,
        batchResultIds: [],
        resultGridOpen: batchCount > 1,
      }),
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
      concurrencyLimit,
    };

    if (s.prompt.trim()) {
      const ph = [s.prompt, ...get().promptHistory.filter((p) => p !== s.prompt)].slice(0, 50);
      set({ promptHistory: ph });
      try { localStorage.setItem("gptcodex.promptHistory", JSON.stringify(ph)); } catch {}
    }
    set({
      lastPayload: basePayload,
      workspaces: patchWorkspaceRuntime(get().workspaces, workspaceId, { lastPayload: basePayload }),
    });

    for (let i = 0; i < batchCount; i++) {
      const jobSeed = s.seed ? s.seed + i : 0;
      const p: backend.GenerateOptions = { ...basePayload, seed: jobSeed };
      void launchOneJob(s.mode, p, {
        workspaceId,
        apiMode: s.apiMode,
        size: s.size,
        quality: s.quality,
        outputFormat: s.outputFormat,
        sources: s.sources,
        currentImage: s.currentImage,
        styleTag: s.styleTag,
        transport: s.transport,
      });
    }
  },

  cancel: async () => {
    const s = get();
    const workspaceId = s.activeWorkspaceId;
    const ids = [...s.runningJobs];
    // Cancel every concurrent job in the batch.
    for (const id of ids) {
      try { await wailsCancel(id); } catch { /* ignore */ }
      EventsOff(`progress:${id}`, `log:${id}`, `result:${id}`, `error:${id}`);
    }
    const nextMeta = { ...get().runningJobMeta };
    for (const id of ids) delete nextMeta[id];
    const runPatch = {
      isRunning: false,
      runningJobs: [],
      progress: null,
      jobsTotal: 0,
      jobsCompleted: 0,
    };
    set({
      ...runPatch,
      runningJobMeta: nextMeta,
      workspaces: patchWorkspaceRuntime(get().workspaces, workspaceId, runPatch),
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
      set({ errorMessage: `源图准备失败:${e?.message ?? e}`, errorRawPath: null });
      return null;
    });
    if (!localItem?.savedPath) return;
    const baseName = localItem.savedPath.split(/[\\/]/).pop() ?? "source.png";
    const existing = get().sources;
    const alreadyIn = existing.some((s) => s.path === localItem.savedPath);
    set({
      mode: "edit",
      currentImage: localItem,
      resultGridOpen: false,
      sources: alreadyIn
        ? existing
        : [...existing, { path: localItem.savedPath, name: baseName, size: 0 }],
    });
  },

  deleteHistoryItem: async (id) => {
    await removeHistoryItem(id);
    const currentBefore = get().currentImage;
    const wasCurrent = currentBefore?.id === id;
    const nextBatch = get().batchResults.filter((h) => h.id !== id);
    const patch: Partial<StudioState> = { batchResults: nextBatch };
    if (wasCurrent) patch.currentImage = null;
    if (nextBatch.length <= 1) patch.resultGridOpen = false;
    set({
      history: get().history.filter((h) => h.id !== id),
      ...(patch as any),
      workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, {
        currentImageId: wasCurrent ? null : currentBefore?.id ?? null,
        batchResultIds: nextBatch.map((h) => h.id),
        resultGridOpen: nextBatch.length > 1 && (patch.resultGridOpen ?? get().resultGridOpen),
      }),
    });
  },

  saveCurrentImageAs: async () => {
    const cur = await ensureFullHistoryItem(get().currentImage);
    if (!cur) return;
    const suggested = `image-${cur.mode}-${cur.id.slice(0, 8)}.png`;
    try {
      const saved = await saveImageForPlatform(cur.imageB64, suggested, SaveImageAs);
      if (saved) get().pushToast(`已保存:${saved.split(/[\\/]/).pop()}`, "success");
    } catch (e: any) {
      const msg = `保存失败:${e?.message ?? e}`;
      set({ errorMessage: msg, errorRawPath: null });
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
    // 网络通道(全局)
    let transport: TransportKind = "auto";
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

    // ---- v0.1.6 profile 列表加载 / 迁移 -----------------------------------
    // 1) 优先读新格式 gptcodex.profiles。
    // 2) 缺失时尝试从老 gptcodex.{responses,images}.* + 老 keyring 项合成 0-2
    //    个 profile,顺手清理老 localStorage 键。
    let profiles = loadStoredProfiles();
    let activeProfileId = loadStoredActiveProfileId();
    if (profiles.length === 0) {
      // 检测老格式
      let legacyApiMode: APIMode = "responses";
      try {
        const v = localStorage.getItem("gptcodex.apiMode");
        if (v === "images" || v === "responses") legacyApiMode = v;
      } catch {}
      const legacyResponses = loadModeConfig("responses");
      const legacyImages = loadModeConfig("images");
      // 沿用 v0.1.5 那套 legacy-shared 字段(更老的 gptcodex.baseURL 等)
      const legacyBaseURL  = (() => { try { return localStorage.getItem("gptcodex.baseURL") ?? ""; } catch { return ""; } })();
      const legacyTextID   = (() => { try { return localStorage.getItem("gptcodex.textModelID") ?? ""; } catch { return ""; } })();
      const legacyImageID  = (() => { try { return localStorage.getItem("gptcodex.imageModelID") ?? ""; } catch { return ""; } })();
      if (legacyApiMode === "responses" && legacyBaseURL && !legacyResponses.baseURL) {
        legacyResponses.baseURL = cleanBaseURL(legacyBaseURL);
        legacyResponses.textModelID = legacyTextID;
        legacyResponses.imageModelID = legacyImageID;
      } else if (legacyApiMode === "images" && legacyBaseURL && !legacyImages.baseURL) {
        legacyImages.baseURL = cleanBaseURL(legacyBaseURL);
        legacyImages.imageModelID = legacyImageID;
      }
      const legacySharedKey = loadLegacySharedAPIKey();
      const legacyResponsesKey = await GetStoredAPIKey("responses").catch(() => "")
        || loadLegacyModeAPIKey("responses")
        || (legacyApiMode === "responses" ? legacySharedKey : "");
      const legacyImagesKey = await GetStoredAPIKey("images").catch(() => "")
        || loadLegacyModeAPIKey("images")
        || (legacyApiMode === "images" ? legacySharedKey : "");
      const synth: UpstreamProfile[] = [];
      if (legacyResponses.baseURL || legacyResponsesKey) {
        const id = genProfileId();
        synth.push({
          id,
          name: "Responses · 默认",
          apiMode: "responses",
          baseURL: legacyResponses.baseURL,
          textModelID: legacyResponses.textModelID,
          imageModelID: legacyResponses.imageModelID,
          concurrencyLimit: normalizeConcurrencyLimit(legacyResponses.concurrencyLimit),
          createdAt: Date.now(),
          lastUsedAt: legacyApiMode === "responses" ? Date.now() : undefined,
        });
        if (legacyResponsesKey) {
          try { await SetStoredAPIKey(keyringUserFor(id), legacyResponsesKey); } catch {}
        }
      }
      if (legacyImages.baseURL || legacyImagesKey) {
        const id = genProfileId();
        synth.push({
          id,
          name: "Images · 默认",
          apiMode: "images",
          baseURL: legacyImages.baseURL,
          textModelID: legacyImages.textModelID,
          imageModelID: legacyImages.imageModelID,
          concurrencyLimit: normalizeConcurrencyLimit(legacyImages.concurrencyLimit),
          createdAt: Date.now(),
          lastUsedAt: legacyApiMode === "images" ? Date.now() : undefined,
        });
        if (legacyImagesKey) {
          try { await SetStoredAPIKey(keyringUserFor(id), legacyImagesKey); } catch {}
        }
      }
      if (synth.length > 0) {
        profiles = synth;
        // active = 跟老 apiMode 对应的那个
        const matching = synth.find((p) => p.apiMode === legacyApiMode);
        activeProfileId = (matching ?? synth[0]).id;
        persistProfiles(profiles);
        persistActiveProfileId(activeProfileId);
        // 清掉老的 keyring 项 + localStorage 键(避免下次启动重复迁移)
        try { await DeleteStoredAPIKey("responses"); } catch {}
        try { await DeleteStoredAPIKey("images"); } catch {}
        clearLegacyAPIKeys();
        clearLegacyModeLocalStorage();
      }
    }

    // 决定 active profile 与对应顶层镜像。空列表 → 全置空,后面会自动弹首次配置。
    const activeProfile = pickActiveProfile(profiles, activeProfileId);
    if (activeProfile && activeProfile.id !== activeProfileId) {
      activeProfileId = activeProfile.id;
      persistActiveProfileId(activeProfileId);
    }
    const apiMode: APIMode = activeProfile?.apiMode ?? "responses";
    const baseURL = activeProfile?.baseURL ?? "";
    const textModelID = activeProfile?.textModelID ?? "";
    const imageModelID = activeProfile?.imageModelID ?? "";
    const activeKey = activeProfile
      ? await GetStoredAPIKey(keyringUserFor(activeProfile.id)).catch(() => "")
      : "";
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
      batchResultIds: [],
      resultGridOpen: false,
      runningJobIds: [],
      jobsTotal: 0,
      jobsCompleted: 0,
      progress: null,
      lastLogLine: "",
      errorMessage: null,
      errorRawPath: null,
      lastPayload: null,
    };
    set({
      apiKey: activeKey, history: trimHistory(items), promptHistory, presets, theme, fontScale,
      apiMode, baseURL, textModelID, imageModelID, transport, noPromptRevision,
      outputFormat,
      profiles,
      activeProfileId,
      workspaces: [initialWorkspace],
      activeWorkspaceId: wsId,
      // 没 active profile 或 active profile 缺 key/baseURL → 弹首次配置。
      upstreamModalOpen: !activeProfile || !activeKey.trim() || !baseURL.trim(),
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

  openResultGrid: () => {
    const ids = get().batchResults.map((item) => item.id);
    if (ids.length <= 1) return;
    set({
      resultGridOpen: true,
      compareB: null,
      workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, { resultGridOpen: true }),
    });
  },
  closeResultGrid: () => {
    set({
      resultGridOpen: false,
      workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, { resultGridOpen: false }),
    });
  },
  selectBatchResult: async (item) => {
    const full = await ensureFullBatchItem(item);
    set({
      currentImage: full,
      resultGridOpen: false,
      compareB: null,
      maskDataURL: null,
      annotations: [],
      tool: "pan",
      workspaces: patchWorkspaceRuntime(get().workspaces, get().activeWorkspaceId, {
        currentImageId: full.id,
        resultGridOpen: false,
      }),
    });
  },

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
      const dst = await exportHistoryForPlatform(JSON.stringify(payload, null, 2), ExportHistoryToFile);
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

  optimizePrompt: async () => {
    const s = get();
    if (s.isRunning || s.isOptimizingPrompt) return;
    // prompt 优化必须走 Responses(它要文本模型),如果用户 active 的是 Images
    // profile,要回头找一个 Responses profile 来跑;它的 key 还是从 keyring 拿。
    let optimizeAPIKey = s.apiKey;
    let optimizeBaseURL = s.baseURL;
    let optimizeTextModelID = s.textModelID;
    if (s.apiMode !== "responses") {
      const responsesProfile = s.profiles.find((p) => p.apiMode === "responses" && p.baseURL);
      if (responsesProfile) {
        optimizeBaseURL = responsesProfile.baseURL;
        optimizeTextModelID = responsesProfile.textModelID;
        const k = await GetStoredAPIKey(keyringUserFor(responsesProfile.id)).catch(() => "");
        if (k) optimizeAPIKey = k;
      }
    }
    optimizeAPIKey = optimizeAPIKey.trim();
    optimizeBaseURL = cleanBaseURL(optimizeBaseURL);
    optimizeTextModelID = optimizeTextModelID.trim();
    if (!optimizeAPIKey) {
      s.pushToast("先填入 API Key", "warn");
      return;
    }
    if (!optimizeBaseURL) {
      s.pushToast("先在上游配置里填入可用于 llmapi 的 Responses API 地址", "warn", 5000);
      return;
    }
    if (!s.prompt.trim()) {
      s.pushToast("先输入 prompt", "warn");
      return;
    }
    const baseURLError = validateBaseURL(optimizeBaseURL);
    if (baseURLError) {
      s.pushToast(baseURLError, "error", 6000);
      return;
    }
    const sourcePaths = s.mode === "edit"
      ? s.sources.map((src) => src.path).filter(Boolean)
      : [];
    if (s.mode === "edit" && sourcePaths.length === 0 && s.currentImage?.savedPath) {
      sourcePaths.push(s.currentImage.savedPath);
    }
    set({ isOptimizingPrompt: true, errorMessage: null, errorRawPath: null });
    try {
      const optimized = await wailsOptimizePrompt({
        apiKey: optimizeAPIKey,
        prompt: s.prompt,
        mode: s.mode,
        baseURL: optimizeBaseURL,
        textModelID: optimizeTextModelID,
        imagePaths: sourcePaths,
        imagePath: "",
      } satisfies PromptOptimizeRequest);
      const trimmed = optimized.trim();
      if (!trimmed) {
        throw new Error("上游没有返回可用的优化结果");
      }
      set({ prompt: trimmed });
      s.pushToast("已优化提示词", "success");
    } catch (e: any) {
      const msg = `优化失败:${e?.message ?? e}`;
      set({ errorMessage: msg, errorRawPath: null });
      s.pushToast(msg, "error", 6000);
    } finally {
      set({ isOptimizingPrompt: false });
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
      batchResultIds: [],
      resultGridOpen: false,
      runningJobIds: [],
      jobsTotal: 0,
      jobsCompleted: 0,
      progress: null,
      lastLogLine: "",
      errorMessage: null,
      errorRawPath: null,
      lastPayload: null,
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
      batchResults: [],
      resultGridOpen: false,
      annotations: [],
      strokes: [],
      maskDataURL: null,
      runningJobs: [],
      jobsTotal: 0,
      jobsCompleted: 0,
      progress: null,
      lastLogLine: "",
      errorMessage: null,
      errorRawPath: null,
      isRunning: false,
      lastPayload: null,
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
    const batchResults = historyItemsByIds(s.history, target.batchResultIds ?? []);
    const runningJobs = target.runningJobIds ?? [];
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
      batchResults,
      resultGridOpen: !!target.resultGridOpen,
      annotations: [],
      strokes: [],
      maskDataURL: null,
      runningJobs,
      jobsTotal: target.jobsTotal ?? 0,
      jobsCompleted: target.jobsCompleted ?? 0,
      progress: target.progress ?? null,
      lastLogLine: target.lastLogLine ?? "",
      errorMessage: target.errorMessage ?? null,
      errorRawPath: target.errorRawPath ?? null,
      isRunning: runningJobs.length > 0,
      lastPayload: target.lastPayload ?? null,
    });
  },

  closeWorkspace: (id) => {
    const s = get();
    if (s.workspaces.length <= 1) {
      s.pushToast("至少保留一个标签页", "warn");
      return;
    }
    const closingJobIds = s.workspaces.find((w) => w.id === id)?.runningJobIds ?? [];
    for (const jobId of closingJobIds) {
      try { void wailsCancel(jobId); } catch { /* ignore */ }
      EventsOff(`progress:${jobId}`, `log:${jobId}`, `result:${jobId}`, `error:${jobId}`);
    }
    const nextMeta = { ...s.runningJobMeta };
    for (const jobId of closingJobIds) delete nextMeta[jobId];
    const remaining = s.workspaces.filter((w) => w.id !== id);
    // If we're closing the active one, switch to a neighbour first.
    if (s.activeWorkspaceId === id) {
      const next = remaining[0];
      const newCurrent = next.currentImageId
        ? s.history.find((h) => h.id === next.currentImageId) ?? null
        : null;
      const batchResults = historyItemsByIds(s.history, next.batchResultIds ?? []);
      const runningJobs = next.runningJobIds ?? [];
      set({
        workspaces: remaining,
        runningJobMeta: nextMeta,
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
        batchResults,
        resultGridOpen: !!next.resultGridOpen,
        annotations: [],
        strokes: [],
        maskDataURL: null,
        runningJobs,
        jobsTotal: next.jobsTotal ?? 0,
        jobsCompleted: next.jobsCompleted ?? 0,
        progress: next.progress ?? null,
        lastLogLine: next.lastLogLine ?? "",
        errorMessage: next.errorMessage ?? null,
        errorRawPath: next.errorRawPath ?? null,
        isRunning: runningJobs.length > 0,
        lastPayload: next.lastPayload ?? null,
      });
    } else {
      set({ workspaces: remaining, runningJobMeta: nextMeta });
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
    set({ errorMessage: null, errorRawPath: null });
    // Re-invoke submit, which will rebuild the payload from current state.
    // (We don't reuse lastPayload verbatim so any tweaks the user made
    // after the failure — different seed, different prompt — take effect.)
    await get().submit();
  },

  importImageFile: async (file) => {
    try {
      if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
        set({ errorMessage: `不支持的图片类型:${file.type || "(未知)"},请用 PNG/JPG/WebP`, errorRawPath: null });
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
        batchResults: [],
        resultGridOpen: false,
        mode: "edit",
        sources: alreadyIn
          ? existingSources
          : [...existingSources, { path: result.path, name: file.name, size: file.size, imageB64: b64 }],
        errorMessage: null,
        errorRawPath: null,
      });
      persistTrimmedHistory(trimmed);
    } catch (e: any) {
      set({ errorMessage: `导入失败:${e?.message ?? e}`, errorRawPath: null });
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
    workspaceId: string;
    apiMode: APIModeValue;
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
    store.setState((state) => {
      const runtime = workspaceRuntimeFromState(state, snapshot.workspaceId);
      const runningJobs = runtime.runningJobs.includes(jobId)
        ? runtime.runningJobs
        : [...runtime.runningJobs, jobId];
      const patch: WorkspacePatch = { runningJobs };
      return {
        runningJobMeta: {
          ...state.runningJobMeta,
          [jobId]: { workspaceId: snapshot.workspaceId, apiMode: snapshot.apiMode },
        },
        workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, patch),
        ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(patch) : {}),
      } as Partial<StudioState>;
    });

    let offProgress = () => {};
    let offLog = () => {};
    let offResult = () => {};
    let offError = () => {};
    const cleanup = () => { offProgress(); offLog(); offResult(); offError(); };
    const removeFromRunning = () => {
      let completed = 0;
      let total = 0;
      store.setState((state) => {
        const runtime = workspaceRuntimeFromState(state, snapshot.workspaceId);
        const remaining = runtime.runningJobs.filter((id) => id !== jobId);
        completed = runtime.jobsCompleted + 1;
        total = runtime.jobsTotal;
        const patch: WorkspacePatch = {
          runningJobs: remaining,
          jobsCompleted: completed,
          progress: remaining.length === 0 ? null : runtime.progress,
        };
        const nextMeta = { ...state.runningJobMeta };
        delete nextMeta[jobId];
        return {
          runningJobMeta: nextMeta,
          workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, patch),
          ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(patch) : {}),
        } as Partial<StudioState>;
      });
      return { completed, total };
    };

    offProgress = EventsOn(`progress:${jobId}`, (p: ProgressInfo) => {
      const patch: WorkspacePatch = { progress: p };
      store.setState((state) => ({
        workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, patch),
        ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(patch) : {}),
      } as Partial<StudioState>));
    });
    offLog = EventsOn(`log:${jobId}`, (line: string) => {
      const patch: WorkspacePatch = { lastLogLine: line };
      store.setState((state) => ({
        workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, patch),
        ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(patch) : {}),
      } as Partial<StudioState>));
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
        const trimmed = trimHistory([item, ...store.getState().history]);
        store.setState((state) => {
          const workspace = state.workspaces.find((w) => w.id === snapshot.workspaceId);
          const existingBatchIDs = state.activeWorkspaceId === snapshot.workspaceId
            ? state.batchResults.map((b) => b.id)
            : workspace?.batchResultIds ?? [];
          const gridWasOpen = state.activeWorkspaceId === snapshot.workspaceId
            ? state.resultGridOpen
            : workspace?.resultGridOpen ?? false;
          const nextBatchIDs = existingBatchIDs.includes(item.id)
            ? existingBatchIDs
            : [...existingBatchIDs, item.id];
          const nextGridOpen = gridWasOpen;
          const batchResults = state.activeWorkspaceId === snapshot.workspaceId
            ? [...state.batchResults, fullItem]
            : state.batchResults;
          return {
            history: trimmed,
            recentDurations: rd,
            workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, {
              currentImageId: item.id,
              batchResultIds: nextBatchIDs,
              resultGridOpen: nextGridOpen,
            }),
            ...(state.activeWorkspaceId === snapshot.workspaceId
              ? {
                  currentImage: fullItem,
                  batchResults,
                  resultGridOpen: nextGridOpen,
                  maskDataURL: null,
                  annotations: [],
                  tool: "pan",
                }
              : {}),
          } as Partial<StudioState>;
        });
        persistTrimmedHistory(trimmed);
        // 桌面通知 —— 点击拉前台 + 直达详情抽屉
        if (willNotify) {
          tryNotify("Image Studio · 已完成", r.prompt ?? "", () => {
            store.getState().openResultDetail(fullItem);
          });
        }
        const runtime = workspaceRuntimeFromState(store.getState(), snapshot.workspaceId);
        const total = runtime.jobsTotal;
        const completedAfter = runtime.jobsCompleted + 1;
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
        const patch: WorkspacePatch = {
          errorMessage: `处理结果失败:${err?.message ?? err}`,
          errorRawPath: null,
        };
        store.setState((state) => ({
          workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, patch),
          ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(patch) : {}),
        } as Partial<StudioState>));
        removeFromRunning();
      }
      })();
    });
    offError = EventsOn(`error:${jobId}`, (e: { message: string; rawPath?: string }) => {
      cleanup();
      const patch: WorkspacePatch = {
        errorMessage: e?.message ?? "未知错误",
        errorRawPath: (typeof e?.rawPath === "string" && e.rawPath) ? e.rawPath : null,
      };
      store.setState((state) => ({
        workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, patch),
        ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(patch) : {}),
      } as Partial<StudioState>));
      removeFromRunning();
    });
  } catch (e: any) {
    const patch: WorkspacePatch = {
      errorMessage: `提交失败:${e?.message ?? e}`,
      errorRawPath: null,
    };
    store.setState((state) => {
      const runtime = workspaceRuntimeFromState(state, snapshot.workspaceId);
      const nextPatch: WorkspacePatch = {
        ...patch,
        runningJobs: runtime.runningJobs,
        jobsCompleted: Math.min(runtime.jobsTotal, runtime.jobsCompleted + 1),
        progress: runtime.runningJobs.length === 0 ? null : runtime.progress,
      };
      return {
        workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, nextPatch),
        ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(nextPatch) : {}),
      } as Partial<StudioState>;
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
      batchResultIds: s.batchResults.map((item) => item.id),
      resultGridOpen: s.resultGridOpen,
      runningJobIds: s.runningJobs,
      jobsTotal: s.jobsTotal,
      jobsCompleted: s.jobsCompleted,
      progress: s.progress,
      lastLogLine: s.lastLogLine,
      errorMessage: s.errorMessage,
      lastPayload: s.lastPayload,
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
