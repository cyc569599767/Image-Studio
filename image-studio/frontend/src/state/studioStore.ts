import { create } from "zustand";
import { EventsOn, EventsOff } from "../../wailsjs/runtime/runtime";
import {
  Generate as wailsGenerate,
  Edit as wailsEdit,
  Cancel as wailsCancel,
  OpenImageDialog,
  SaveImageAs,
  ImportImageFromB64,
  RotateImage,
  FlipImage,
  CropImage,
  ReadImageAsBase64,
  ExportHistoryToFile,
  ImportHistoryFromFile,
  SetOutputDir,
} from "../../wailsjs/go/backend/Service";
import type { backend } from "../../wailsjs/go/models";
import {
  HistoryItem,
  Mode,
  Preset,
  ProgressInfo,
  QualityValue,
  SizeValue,
  SourceImage,
  Toast,
  TransportKind,
  Workspace,
  Annotation,
} from "../types/domain";
import {
  loadAPIKey,
  saveAPIKey,
  persistHistoryItem,
  removeHistoryItem,
  loadAllHistory,
} from "../lib/storage";

// 单个 API 形态的上游 5 字段(去掉 apiMode 本身)。两种形态各持有一份,在
// localStorage 里以 `gptcodex.<mode>.<field>` 命名持久化。
export interface ModeConfig {
  baseURL: string;
  apiKey: string;
  textModelID: string;
  imageModelID: string;
}

const EMPTY_MODE_CFG: ModeConfig = { baseURL: "", apiKey: "", textModelID: "", imageModelID: "" };

function loadModeConfig(mode: "responses" | "images"): ModeConfig {
  const r = (k: keyof ModeConfig): string => {
    try { return localStorage.getItem(`gptcodex.${mode}.${k}`) ?? ""; } catch { return ""; }
  };
  return {
    baseURL: r("baseURL"),
    apiKey: r("apiKey"),
    textModelID: r("textModelID"),
    imageModelID: r("imageModelID"),
  };
}

function saveModeField(mode: "responses" | "images", field: keyof ModeConfig, value: string) {
  try { localStorage.setItem(`gptcodex.${mode}.${field}`, value); } catch {}
}

// trim trailing slashes — Go 端虽然会兜底,UI 持久化也清一遍,展示更干净
function cleanBaseURL(v: string): string {
  return v.replace(/\/+$/, "").trim();
}

interface StudioState {
  // ---- Form state ----
  apiKey: string;
  mode: Mode;
  prompt: string;
  negativePrompt: string;
  size: SizeValue;
  quality: QualityValue;
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
  logLines: string[];
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
  // Toggled by F11; canvas-shell expands to full window and side panels hide.
  fullscreen: boolean;
  // List of recently used prompts (most recent first, capped).
  promptHistory: string[];

  // How many images to generate per "提交" click. 1 = single, 2-8 = batch.
  batchCount: number;
  // User-saved parameter presets, persisted to localStorage.
  presets: Preset[];

  // UI theme + font scale; persisted to localStorage and applied to <html>.
  theme: "dark" | "light";
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
  setAPIKey: (v: string) => void;
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
  openResultDetail: (item: HistoryItem) => void;
  closeResultDetail: () => void;
  retryLast: () => Promise<void>;
  savePreset: (name: string) => void;
  applyPreset: (id: string) => void;
  deletePreset: (id: string) => void;
  exportHistory: () => Promise<void>;
  importHistory: () => Promise<void>;
  setTheme: (t: "dark" | "light") => void;
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

// Compute image natural dimensions from a base64 PNG by reading the IHDR chunk.
// Cheap, sync, doesn't require a full image decode.
function imageDims(b64: string): { w: number; h: number } | null {
  try {
    const bin = atob(b64.slice(0, 64)); // first ~48 bytes is enough for IHDR
    // PNG signature (8) + length(4) + "IHDR"(4) + width(4) + height(4)
    const view = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
    const w = view.getUint32(16, false);
    const h = view.getUint32(20, false);
    if (w > 0 && h > 0 && w < 20000 && h < 20000) return { w, h };
  } catch { /* not a PNG or atob failed */ }
  return null;
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
  seed: 0,
  transport: "auto",
  baseURL: "",
  textModelID: "",
  imageModelID: "",
  apiMode: "responses",
  responsesConfig: EMPTY_MODE_CFG,
  imagesConfig: EMPTY_MODE_CFG,
  sources: [],

  runningJobs: [],
  jobsTotal: 0,
  jobsCompleted: 0,
  progress: null,
  logLines: [],
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
  fullscreen: false,
  promptHistory: [],
  batchCount: 1,
  presets: [],
  theme: "dark",
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
      saveAPIKey(cfg.apiKey); // 让旧的 gptcodex.apiKey 也跟着新 active 走,保持向后兼容
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
      saveModeField(mode, key as keyof ModeConfig, cleaned);
      return;
    }
    // transport 跟 apiMode/上游 4 字段不同 —— 它是全局的,不分形态
    set({ [key]: value } as any);
    if (key === "transport") {
      try { localStorage.setItem("gptcodex.transport", String(value)); } catch {}
    }
  },

  setAPIKey: (v) => {
    saveAPIKey(v); // legacy gptcodex.apiKey,保持向后兼容
    const mode = get().apiMode;
    const slot = mode === "responses" ? "responsesConfig" : "imagesConfig";
    const next: ModeConfig = { ...get()[slot], apiKey: v };
    set({ apiKey: v, [slot]: next } as any);
    saveModeField(mode, "apiKey", v);
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
      set({ errorMessage: "请在「设置 → 上游 BASE_URL」中填入你的中转站地址(必须兼容 OpenAI Responses API + image_generation 工具)" });
      return;
    }
    let editSourcePaths: string[] = [];
    if (s.mode === "edit") {
      editSourcePaths = s.sources.map((src) => src.path).filter(Boolean);
      if (editSourcePaths.length === 0 && s.currentImage?.savedPath) {
        editSourcePaths = [s.currentImage.savedPath];
      }
      if (editSourcePaths.length === 0) {
        set({ errorMessage: "图生图模式需要先添加源图(或从文件管理器拖图到画板)" });
        return;
      }
    }

    set({
      errorMessage: null,
      progress: null,
      logLines: [],
      isRunning: true,
      jobsTotal: 1,
      jobsCompleted: 0,
      runningJobs: [],
    });

    const maskB64 = s.mode === "edit" && s.maskDataURL ? stripDataURLPrefix(s.maskDataURL) : "";
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
      imagePaths: editSourcePaths,
      imagePath: "",
      maskB64: maskB64,
      seed: s.seed,
      negativePrompt: s.negativePrompt,
      baseURL: s.baseURL,
      textModelID: s.textModelID,
      imageModelID: s.imageModelID,
      transport: s.transport,
      apiMode: s.apiMode,
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
    if (!item.savedPath) {
      set({ errorMessage: "该历史项没有本地路径,无法作为源图复用" });
      return;
    }
    const baseName = item.savedPath.split(/[\\/]/).pop() ?? "source.png";
    const existing = get().sources;
    const alreadyIn = existing.some((s) => s.path === item.savedPath);
    set({
      mode: "edit",
      currentImage: item,
      sources: alreadyIn
        ? existing
        : [...existing, { path: item.savedPath, name: baseName, size: 0 }],
    });
  },

  deleteHistoryItem: async (id) => {
    await removeHistoryItem(id);
    set({ history: get().history.filter((h) => h.id !== id) });
    if (get().currentImage?.id === id) set({ currentImage: null });
  },

  saveCurrentImageAs: async () => {
    const cur = get().currentImage;
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
    const key = loadAPIKey();
    const items = await loadAllHistory();
    let promptHistory: string[] = [];
    let presets: Preset[] = [];
    let theme: "dark" | "light" = "dark";
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
      if (raw === "light" || raw === "dark") theme = raw;
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
    // 每个形态的独立上游槽
    let responsesConfig = loadModeConfig("responses");
    let imagesConfig = loadModeConfig("images");
    // 旧版本(共享单份配置)迁移:legacy 字段 → 当前形态的槽,只在该槽为空时迁入。
    // legacy apiKey 走 loadAPIKey,其他三个走旧的 gptcodex.<field>。
    const legacyBaseURL  = (() => { try { return localStorage.getItem("gptcodex.baseURL") ?? ""; } catch { return ""; } })();
    const legacyTextID   = (() => { try { return localStorage.getItem("gptcodex.textModelID") ?? ""; } catch { return ""; } })();
    const legacyImageID  = (() => { try { return localStorage.getItem("gptcodex.imageModelID") ?? ""; } catch { return ""; } })();
    const legacyKey = key; // loadAPIKey 上面已经取过
    const activeSlot = apiMode === "responses" ? responsesConfig : imagesConfig;
    let migrated = false;
    if (!activeSlot.baseURL && legacyBaseURL)     { activeSlot.baseURL = cleanBaseURL(legacyBaseURL); migrated = true; }
    if (!activeSlot.apiKey && legacyKey)          { activeSlot.apiKey = legacyKey; migrated = true; }
    if (!activeSlot.textModelID && legacyTextID)  { activeSlot.textModelID = legacyTextID; migrated = true; }
    if (!activeSlot.imageModelID && legacyImageID){ activeSlot.imageModelID = legacyImageID; migrated = true; }
    if (migrated) {
      saveModeField(apiMode, "baseURL", activeSlot.baseURL);
      saveModeField(apiMode, "apiKey", activeSlot.apiKey);
      saveModeField(apiMode, "textModelID", activeSlot.textModelID);
      saveModeField(apiMode, "imageModelID", activeSlot.imageModelID);
      if (apiMode === "responses") responsesConfig = activeSlot;
      else imagesConfig = activeSlot;
    }
    // 顶层镜像 = 当前形态的槽
    const baseURL = activeSlot.baseURL;
    const textModelID = activeSlot.textModelID;
    const imageModelID = activeSlot.imageModelID;
    const activeKey = activeSlot.apiKey || legacyKey; // 优先使用形态槽里的 key
    if (activeKey !== legacyKey) saveAPIKey(activeKey); // 同步 legacy 存储
    // Apply theme + font scale to root immediately.
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.setProperty("--font-scale", String(fontScale));
    // 用户自定义输出目录 —— 把 localStorage 里保存的路径推给 backend。
    try {
      const customOutput = localStorage.getItem("gptcodex.outputDir");
      if (customOutput && customOutput.trim()) {
        SetOutputDir(customOutput).catch(() => undefined);
      }
    } catch {}
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
      seed: 0,
      batchCount: 1,
      sources: [],
      currentImageId: null,
    };
    set({
      apiKey: activeKey, history: items, promptHistory, presets, theme, fontScale,
      apiMode, baseURL, textModelID, imageModelID, transport,
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

  setCompareB: (item) => set({ compareB: item, compareSplit: 0.5 }),
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
  openResultDetail: (item) => set({ resultDetail: item }),
  closeResultDetail: () => set({ resultDetail: null }),

  rotateCurrent: async (degrees) => {
    const cur = get().currentImage;
    if (!cur?.savedPath) {
      get().pushToast("当前图没有本地路径,无法变换", "warn");
      return;
    }
    try {
      const r = await RotateImage(cur.savedPath, degrees);
      await loadTransformedAsCurrent(r.path);
      get().pushToast(`已旋转 ${degrees}°`, "success");
    } catch (e: any) {
      get().pushToast(`旋转失败:${e?.message ?? e}`, "error");
    }
  },

  flipCurrent: async (horizontal) => {
    const cur = get().currentImage;
    if (!cur?.savedPath) {
      get().pushToast("当前图没有本地路径,无法变换", "warn");
      return;
    }
    try {
      const r = await FlipImage(cur.savedPath, horizontal);
      await loadTransformedAsCurrent(r.path);
      get().pushToast(horizontal ? "已水平翻转" : "已竖直翻转", "success");
    } catch (e: any) {
      get().pushToast(`翻转失败:${e?.message ?? e}`, "error");
    }
  },

  cropToRect: async (x, y, w, h) => {
    const cur = get().currentImage;
    if (!cur?.savedPath) {
      get().pushToast("当前图没有本地路径,无法裁剪", "warn");
      return;
    }
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
      items: s.history,
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
    document.documentElement.setAttribute("data-theme", t);
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
      s.pushToast("先在「设置 → 上游 BASE_URL」中填入中转站地址", "warn", 5000);
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
        imagePaths: [],
        imagePath: "",
        maskB64: "",
        seed: 0,
        negativePrompt: "",
        baseURL: s.baseURL,
        textModelID: s.textModelID,
        imageModelID: s.imageModelID,
        transport: s.transport,
        apiMode: s.apiMode,
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
        merged.push(item);
        await persistHistoryItem(item).catch(() => undefined);
        added++;
      }
      merged.sort((a, b) => b.createdAt - a.createdAt);
      set({ history: merged });
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
      const item: HistoryItem = {
        id: genId(),
        imageB64: b64,
        prompt: `(导入)${file.name}`,
        mode: "edit",
        size: "1024x1024",
        quality: "medium",
        createdAt: Date.now(),
        savedPath: result.path,
      };
      await persistHistoryItem(item);
      const existingSources = get().sources;
      const alreadyIn = existingSources.some((s) => s.path === result.path);
      set({
        currentImage: item,
        history: [item, ...get().history],
        mode: "edit",
        sources: alreadyIn
          ? existingSources
          : [...existingSources, { path: result.path, name: file.name, size: file.size, imageB64: b64 }],
        errorMessage: null,
      });
    } catch (e: any) {
      set({ errorMessage: `导入失败:${e?.message ?? e}` });
    }
  },
}));

// Toast actions inserted at end of store factory below via patch.
// Load a freshly-written transformed image (path under imports/) into the store
// as a new currentImage + history item, replacing source[0] so the user can
// immediately edit it again.
async function loadTransformedAsCurrent(path: string) {
  const store = useStudioStore.getState();
  try {
    const b64 = await ReadImageAsBase64(path);
    const baseName = path.split(/[\\/]/).pop() ?? "transformed.png";
    const item: HistoryItem = {
      id: cryptoIDFallback(),
      imageB64: b64,
      prompt: `(变换)${baseName}`,
      mode: "edit",
      size: store.size,
      quality: store.quality,
      createdAt: Date.now(),
      savedPath: path,
    };
    await persistHistoryItem(item);
    // Replace the first source with the new transformed file so the next
    // edit call uses it; keep the rest of sources intact.
    const nextSources = store.sources.length > 0
      ? [{ path, name: baseName, size: 0, imageB64: b64 }, ...store.sources.slice(1)]
      : [{ path, name: baseName, size: 0, imageB64: b64 }];
    useStudioStore.setState({
      currentImage: item,
      history: [item, ...useStudioStore.getState().history],
      sources: nextSources,
      mode: "edit",
    });
  } catch (e: any) {
    useStudioStore.getState().pushToast(`加载变换结果失败:${e?.message ?? e}`, "error");
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
      store.setState({ logLines: [...store.getState().logLines, line] });
    });

    const startedAt = Date.now();
    offResult = EventsOn(`result:${jobId}`, (r: any) => {
      cleanup();
      try {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const rd = [elapsedSec, ...store.getState().recentDurations].slice(0, 5);
        const willNotify = typeof document !== "undefined" && document.visibilityState !== "visible";
        const item: HistoryItem = {
          id: cryptoIDFallback(),
          imageB64: r.imageB64,
          prompt: r.prompt,
          revisedPrompt: r.revisedPrompt,
          mode: r.mode as Mode,
          size: snapshot.size,
          quality: snapshot.quality,
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
        persistHistoryItem(item).catch(() => undefined);
        // Always set the latest result as currentImage so the canvas updates
        // even when multiple jobs land within the same React tick.
        store.setState({
          currentImage: item,
          history: [item, ...store.getState().history],
          maskDataURL: null,
          annotations: [],
          tool: "pan",
          recentDurations: rd,
        });
        // 桌面通知 —— 点击拉前台 + 直达详情抽屉
        if (willNotify) {
          tryNotify("Image Studio · 已完成", r.prompt ?? "", () => {
            store.getState().openResultDetail(item);
          });
        }
        const total = store.getState().jobsTotal;
        const completedAfter = store.getState().jobsCompleted + 1;
        store.getState().pushToast(
          total > 1
            ? `已完成 (${completedAfter}/${total}) · ${elapsedSec.toFixed(0)}s`
            : `已${item.mode === "edit" ? "编辑" : "生成"} · ${elapsedSec.toFixed(0)}s`,
          "success",
          6000,
          { label: "查看详情", onClick: () => store.getState().openResultDetail(item) },
        );
        removeFromRunning();
      } catch (err: any) {
        store.setState({ errorMessage: `处理结果失败:${err?.message ?? err}` });
        removeFromRunning();
      }
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
