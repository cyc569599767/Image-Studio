import { create } from "zustand";
import {
  EventsOn,
  EventsOff,
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
  SetOutputDir,
  probeCurrentUpstream,
  setKernelRuntimeMode,
} from "../platform/runtime/host";
import type { backend } from "../../wailsjs/go/models";
import {
  APIMode,
  HistoryItem,
  KernelRuntimeMode,
  Mode,
  OutputFormatValue,
  Preset,
  ProgressInfo,
  QualityValue,
  RequestPolicy,
  SizeValue,
  SourceImage,
  ThemeMode,
  Toast,
  UpstreamProfile,
  Workspace,
} from "../types/domain";
import {
  clearLegacyAPIKeys,
  loadLegacyModeAPIKey,
  loadLegacySharedAPIKey,
  loadTrustedOutputRoots,
  persistHistoryFullImage,
  persistHistoryItem,
  rememberTrustedOutputRoot,
  removeHistoryItem,
  loadAllHistory,
} from "../lib/storage";
import {
  cleanBaseURL,
  validateBaseURL,
} from "../lib/security";
import {
  duplicateProfile as cloneProfile,
  genProfileId,
  keyringUserFor,
  pickActiveProfile,
} from "../lib/profiles";
import { base64ToBlob } from "../lib/images";
import { isMac, readRuntimePlatformState } from "../platform";
import { saveImageForPlatform } from "../platform/android/bridge";
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
import { normalizeSizeSelection } from "../components/panel/sizeCapabilities";
import { buildMacWorkspacePreview, readPreviewScenario } from "../app/dev/previewData";
import {
  applyTheme,
  augmentPromptWithAnnotations,
  buildMaskPNGDataURL,
  clearLegacyModeLocalStorage,
  genId,
  imageDims,
  loadModeConfig,
  loadStoredActiveProfileId,
  loadStoredProfiles,
  persistActiveProfileId,
  persistProfiles,
  persistTrimmedHistory,
  registerTrustedOutputRoots,
  stripDataURLPrefix,
  tempDataURLFromB64,
  trimHistory,
} from "./studioStore.shared";
import type { ModeConfig, PromptOptimizeRequest, Stroke, StudioState, UndoEntry } from "./studioStore.types";
import {
  createPreviewB64,
  cryptoIDFallback,
  fileToBase64,
  ensureFullHistoryItem as ensureFullHistoryItemRuntime,
  materializeHistoryItem as materializeHistoryItemRuntime,
  STYLE_SUFFIXES,
  tryNotify,
} from "./studioStore.runtime";
import { createMediaActions } from "./studioStore.media";
import { createProfileActions } from "./studioStore.profiles";
import { createWorkspaceActions } from "./studioStore.workspaces";
import { createImageActions } from "./studioStore.images";

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

const mediaActions = createMediaActions({
  getState: () => useStudioStore.getState(),
  setState: (patch) => {
    if (typeof patch === "function") {
      useStudioStore.setState((state) => patch(state));
      return;
    }
    useStudioStore.setState(patch);
  },
});

const profileActions = createProfileActions({
  getState: () => useStudioStore.getState(),
  setState: (patch) => {
    if (typeof patch === "function") {
      useStudioStore.setState((state) => patch(state));
      return;
    }
    useStudioStore.setState(patch);
  },
});

const workspaceActions = createWorkspaceActions({
  getState: () => useStudioStore.getState(),
  setState: (patch) => {
    if (typeof patch === "function") {
      useStudioStore.setState((state) => patch(state));
      return;
    }
    useStudioStore.setState(patch);
  },
});

const imageActions = createImageActions({
  getState: () => useStudioStore.getState(),
  setState: (patch) => {
    if (typeof patch === "function") {
      useStudioStore.setState((state) => patch(state));
      return;
    }
    useStudioStore.setState(patch);
  },
});

export const useStudioStore = create<StudioState>((set, get) => ({
  apiKey: "",
  mode: "generate",
  prompt: "",
  negativePrompt: "",
  size: "1024x1024",
  quality: "medium",
  outputFormat: "png",
  seed: 0,
  kernelRuntimeMode: "auto",
  baseURL: "",
  textModelID: "",
  imageModelID: "",
  apiMode: "responses",
  requestPolicy: "openai",
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
  historyRailCollapsed: false,
  historyTimelineOpen: false,

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
  starPromptOpen: false,
  starPromptSource: "auto",
  promptHistory: [],
  batchCount: 1,
  presets: [],
  theme: "system",
  fontScale: 1,
  settingsOpen: false,
  openSettings: () => set({ settingsOpen: true, upstreamModalOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  isTestingKey: false,
  isOptimizingPrompt: false,
  upstreamModalOpen: false,
  upstreamReturnTarget: "app",
  openUpstreamConfig: (returnTarget = "app") => set({
    upstreamModalOpen: true,
    upstreamReturnTarget: returnTarget,
    settingsOpen: false,
  }),
  closeUpstreamConfig: () => {
    const { upstreamReturnTarget } = get();
    set({
      upstreamModalOpen: false,
      settingsOpen: upstreamReturnTarget === "settings",
      upstreamReturnTarget: "app",
    });
  },
  openStarPrompt: () => {
    if (isMac) return;
    set({ starPromptOpen: true, starPromptSource: "manual" });
  },
  dismissStarPrompt: () => {
    set({ starPromptOpen: false });
    try { localStorage.setItem("gptcodex.starPrompted", "1"); } catch {}
  },
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
    if (key === "kernelRuntimeMode") {
      try { localStorage.setItem("gptcodex.kernelRuntimeMode", String(value)); } catch {}
      setKernelRuntimeMode(value as KernelRuntimeMode);
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

  createProfile: async (input) => profileActions.createProfile(input),
  updateProfile: async (id, patch) => profileActions.updateProfile(id, patch),
  deleteProfile: async (id) => profileActions.deleteProfile(id),
  duplicateProfile: async (id) => profileActions.duplicateProfile(id),
  setActiveProfile: async (id) => profileActions.setActiveProfile(id),

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

  selectSourceImage: async () => imageActions.selectSourceImage(),
  removeSource: (index) => imageActions.removeSource(index),
  clearSources: () => imageActions.clearSources(),
  reorderSources: (from, to) => imageActions.reorderSources(from, to),

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
        const platform = readRuntimePlatformState();
        set({
          errorMessage: platform.isAndroid
            ? "图生图模式需要先从相册或历史添加源图"
            : "图生图模式需要先添加源图(或从文件管理器拖图到画板)",
          errorRawPath: null,
        });
        return;
      }
    }

    const workspaceId = s.activeWorkspaceId;
    const clearCurrentForNewRun = s.mode === "generate";
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
      compareB: null,
      currentImage: clearCurrentForNewRun ? null : s.currentImage,
      maskDataURL: null,
      annotations: [],
      strokes: [],
      workspaces: patchWorkspaceRuntime(s.workspaces, workspaceId, {
        ...runPatch,
        currentImageId: clearCurrentForNewRun ? null : s.currentImage?.id ?? null,
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

    const resolvedSize = normalizeSizeSelection(s.size, {
      apiMode: s.apiMode,
      requestPolicy: s.requestPolicy,
      imageModelID: s.imageModelID,
    });

    const basePayload: backend.GenerateOptions = {
      apiKey: s.apiKey,
      mode: s.mode,
      requestedJobId: "",
      prompt: augmentedPrompt,
      size: resolvedSize,
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
      requestPolicy: s.requestPolicy,
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

  applyHistoryParams: (item) => imageActions.applyHistoryParams(item),
  regenerateFromHistory: async (item) => imageActions.regenerateFromHistory(item),
  reuseAsSource: async (item) => imageActions.reuseAsSource(item),
  deleteHistoryItem: async (id) => imageActions.deleteHistoryItem(id),
  saveCurrentImageAs: async () => imageActions.saveCurrentImageAs(),

  bootstrap: async () => {
    const previewScenario = readPreviewScenario();
    if (previewScenario === "mac-workspace") {
      const workspaceId = genId();
      const preview = buildMacWorkspacePreview(workspaceId);
      applyTheme("dark");
      document.documentElement.style.setProperty("--font-scale", "1");
      setKernelRuntimeMode("auto");
      set({
        apiKey: "sk-preview",
        mode: "edit",
        prompt: preview.currentImage.prompt,
        negativePrompt: preview.currentImage.negativePrompt ?? "",
        size: preview.currentImage.size,
        quality: preview.currentImage.quality,
        outputFormat: "png",
        seed: preview.currentImage.seed ?? 3200,
        kernelRuntimeMode: "auto",
        baseURL: preview.profile.baseURL,
        textModelID: preview.profile.textModelID,
        imageModelID: preview.profile.imageModelID,
        apiMode: preview.profile.apiMode,
        requestPolicy: preview.profile.requestPolicy,
        noPromptRevision: false,
        profiles: [preview.profile],
        activeProfileId: preview.profile.id,
        sources: preview.sources,
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
        currentImage: preview.currentImage,
        history: preview.history,
        batchResults: [],
        resultGridOpen: false,
        historyRailCollapsed: false,
        historyTimelineOpen: false,
        tool: "pan",
        brushSize: 24,
        brushMode: "paint",
        annotationKind: "rect",
        annotationColor: "#ff4d4d",
        selectedAnnotationId: null,
        maskDataURL: null,
        strokes: [],
        annotations: [],
        compareB: null,
        compareSplit: 0.5,
        toasts: [],
        recentDurations: preview.history.map((item) => item.elapsedSec ?? 0).filter((value) => value > 0),
        viewZoom: 1,
        canvasViewResetTick: 0,
        fullscreen: false,
        promptHistory: [],
        batchCount: 1,
        presets: [],
        theme: "dark",
        fontScale: 1,
        workspaces: [preview.workspace],
        activeWorkspaceId: workspaceId,
        styleTag: preview.currentImage.styleTag ?? "",
        undoStack: [],
        redoStack: [],
        resultDetail: null,
        settingsOpen: false,
        isTestingKey: false,
        isOptimizingPrompt: false,
        upstreamModalOpen: false,
        upstreamReturnTarget: "app",
        starPromptOpen: false,
        starPromptSource: "auto",
      });
      return;
    }

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
    let kernelRuntimeMode: KernelRuntimeMode = "auto";
    try {
      const v = localStorage.getItem("gptcodex.kernelRuntimeMode");
      if (v === "auto" || v === "local" || v === "remote") kernelRuntimeMode = v;
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
          requestPolicy: "openai",
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
          requestPolicy: "openai",
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
    const requestPolicy: RequestPolicy = activeProfile?.requestPolicy ?? "openai";
    const baseURL = activeProfile?.baseURL ?? "";
    const textModelID = activeProfile?.textModelID ?? "";
    const imageModelID = activeProfile?.imageModelID ?? "";
    const activeKey = activeProfile
      ? await GetStoredAPIKey(keyringUserFor(activeProfile.id)).catch(() => "")
      : "";
    // Apply theme + font scale to root immediately.
    applyTheme(theme);
    document.documentElement.style.setProperty("--font-scale", String(fontScale));
    setKernelRuntimeMode(kernelRuntimeMode);
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
    const runtimePlatform = readRuntimePlatformState();
    const shouldAutoOpenSettings = runtimePlatform.isAndroid
      ? false
      : !activeProfile || !activeKey.trim() || !baseURL.trim();
    set({
      apiKey: activeKey, history: trimHistory(items), promptHistory, presets, theme, fontScale,
      apiMode, requestPolicy, baseURL, textModelID, imageModelID, kernelRuntimeMode, noPromptRevision,
      outputFormat,
      profiles,
      activeProfileId,
      workspaces: [initialWorkspace],
      activeWorkspaceId: wsId,
      // Android 走首页 hero 引导，不用启动即弹设置；桌面仍保留首次引导。
      settingsOpen: shouldAutoOpenSettings,
      upstreamModalOpen: false,
      upstreamReturnTarget: shouldAutoOpenSettings ? "settings" : "app",
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

  setCompareB: (item) => mediaActions.setCompareB(item),
  setCompareSplit: (v) => mediaActions.setCompareSplit(v),
  openResultGrid: () => mediaActions.openResultGrid(),
  closeResultGrid: () => mediaActions.closeResultGrid(),
  selectBatchResult: async (item) => mediaActions.selectBatchResult(item),
  pushToast: (text, kind = "info", ttl = 3500, action) => mediaActions.pushToast(text, kind, ttl, action),
  dismissToast: (id) => mediaActions.dismissToast(id),
  resultDetail: null,
  openResultDetail: async (item) => mediaActions.openResultDetail(item),
  closeResultDetail: () => mediaActions.closeResultDetail(),
  materializeCurrentImage: async (item) => mediaActions.materializeCurrentImage(item),
  setHistoryRailCollapsed: (collapsed) => mediaActions.setHistoryRailCollapsed(collapsed),
  openHistoryTimeline: () => mediaActions.openHistoryTimeline(),
  closeHistoryTimeline: () => mediaActions.closeHistoryTimeline(),
  pruneHistoryOlderThanDays: async (days) => mediaActions.pruneHistoryOlderThanDays(days),
  rotateCurrent: async (degrees) => mediaActions.rotateCurrent(degrees),
  flipCurrent: async (horizontal) => mediaActions.flipCurrent(horizontal),
  cropToRect: async (x, y, w, h) => mediaActions.cropToRect(x, y, w, h),
  savePreset: (name) => mediaActions.savePreset(name),
  applyPreset: (id) => mediaActions.applyPreset(id),
  deletePreset: (id) => mediaActions.deletePreset(id),
  exportHistory: async () => mediaActions.exportHistory(),

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
      s.pushToast("先在「上游配置」里填入中转站地址", "warn", 5000);
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
      await probeCurrentUpstream(cleanedBaseURL, s.apiKey.trim());
      set({ isTestingKey: false });
      s.pushToast("连接 OK · 上游 models 列表可访问", "success");
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

  newWorkspace: (name) => workspaceActions.newWorkspace(name),
  switchWorkspace: (id) => workspaceActions.switchWorkspace(id),
  closeWorkspace: (id) => workspaceActions.closeWorkspace(id),
  renameWorkspace: (id, name) => workspaceActions.renameWorkspace(id, name),

  importHistory: async () => mediaActions.importHistory(),

  retryLast: async () => {
    const s = get();
    if (!s.lastPayload || s.isRunning) return;
    set({ errorMessage: null, errorRawPath: null });
    // Re-invoke submit, which will rebuild the payload from current state.
    // (We don't reuse lastPayload verbatim so any tweaks the user made
    // after the failure — different seed, different prompt — take effect.)
    await get().submit();
  },

  importImageFile: async (file) => imageActions.importImageFile(file),
}));

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
  },
): Promise<void> {
  const store = useStudioStore;
  const jobId = cryptoIDFallback();
  let offProgress = () => {};
  let offLog = () => {};
  let offResult = () => {};
  let offError = () => {};
  const cleanup = () => { offProgress(); offLog(); offResult(); offError(); };
  try {
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
          jobsTotal: remaining.length === 0 ? 0 : runtime.jobsTotal,
          progress: remaining.length === 0 ? null : runtime.progress,
          lastLogLine: remaining.length === 0 ? "" : runtime.lastLogLine,
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
        const fullBlob = base64ToBlob(r.imageB64);
        const fullItem: HistoryItem = {
          id: cryptoIDFallback(),
          imageB64: r.imageB64,
          imageBlob: fullBlob,
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
          elapsedSec: Number(elapsedSec.toFixed(1)),
          savedPath: r.savedPath,
          rawPath: r.rawPath,
        };
        const historyItem: HistoryItem = {
          ...fullItem,
          previewOnly: false,
        };
        const { completed: completedNow, total: totalNow } = removeFromRunning();
        const trimmed = trimHistory([historyItem, ...store.getState().history]);
        store.setState((state) => {
          const workspace = state.workspaces.find((w) => w.id === snapshot.workspaceId);
          const existingBatchIDs = state.activeWorkspaceId === snapshot.workspaceId
            ? state.batchResults.map((b) => b.id)
            : workspace?.batchResultIds ?? [];
          const gridWasOpen = state.activeWorkspaceId === snapshot.workspaceId
            ? state.resultGridOpen
            : workspace?.resultGridOpen ?? false;
          const nextBatchIDs = existingBatchIDs.includes(historyItem.id)
            ? existingBatchIDs
            : [...existingBatchIDs, historyItem.id];
          const nextGridOpen = gridWasOpen;
          const batchResults = state.activeWorkspaceId === snapshot.workspaceId
            ? [...state.batchResults, fullItem]
            : state.batchResults;
          return {
            history: trimmed,
            recentDurations: rd,
            workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, {
              currentImageId: historyItem.id,
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
        persistHistoryItem(historyItem).catch(() => undefined);
        persistHistoryFullImage(historyItem.id, r.imageB64).catch(() => undefined);
        // 桌面通知 —— 点击拉前台 + 直达详情抽屉
        if (willNotify) {
          tryNotify("Image Studio · 已完成", r.prompt ?? "", () => {
            store.getState().openResultDetail(fullItem);
          });
        }
        store.getState().pushToast(
          totalNow > 1
            ? `已完成 (${completedNow}/${totalNow}) · ${elapsedSec.toFixed(0)}s`
            : `已${fullItem.mode === "edit" ? "编辑" : "生成"} · ${elapsedSec.toFixed(0)}s`,
          "success",
          6000,
          { label: "查看详情", onClick: () => store.getState().openResultDetail(fullItem) },
        );
        // 首次成功生图 → 延迟 2s 弹 GitHub Star 引导。localStorage 标志一旦
        // 写入就再也不弹(无论用户点 star 还是关闭)。延迟是为了让用户先看
        // 到图,然后再被礼貌打扰。
        try {
          if (!isMac
              && localStorage.getItem("gptcodex.starPrompted") !== "1"
              && !store.getState().starPromptOpen) {
            setTimeout(() => {
              const snapshot = store.getState();
              const overlayBusy =
                snapshot.upstreamModalOpen ||
                snapshot.resultDetail !== null ||
                document.querySelector('[role="dialog"]') !== null;
              if (!overlayBusy && localStorage.getItem("gptcodex.starPrompted") !== "1") {
                store.setState({ starPromptOpen: true, starPromptSource: "auto" });
              }
            }, 3500);
          }
        } catch { /* localStorage 不可用 → 静默跳过 */ }
        void (async () => {
          try {
            const previewB64 = await createPreviewB64(r.imageB64);
            if (previewB64 === r.imageB64) return;
            const previewBlob = base64ToBlob(previewB64);
            store.setState((state) => {
              const patchHistoryItem = (entry: HistoryItem): HistoryItem => (
                entry.id === historyItem.id
                  ? { ...entry, imageB64: previewB64, previewBlob, previewOnly: true }
                  : entry
              );
              return {
                history: state.history.map(patchHistoryItem),
              } as Partial<StudioState>;
            });
            persistHistoryItem({
              ...historyItem,
              imageB64: previewB64,
              previewBlob,
              previewOnly: true,
            }).catch(() => undefined);
          } catch {
            // 缩略图生成失败不影响主流程，保留全图即可。
          }
        })();
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
    const started = mode === "edit"
      ? await wailsEdit({ ...payload, requestedJobId: jobId } as backend.GenerateOptions)
      : await wailsGenerate({ ...payload, requestedJobId: jobId } as backend.GenerateOptions);
    if (started.jobId && started.jobId !== jobId) {
      cleanup();
      throw new Error(`job id 不一致: expected ${jobId}, got ${started.jobId}`);
    }
  } catch (e: any) {
    cleanup();
    const patch: WorkspacePatch = {
      errorMessage: `提交失败:${e?.message ?? e}`,
      errorRawPath: null,
    };
    store.setState((state) => {
      const runtime = workspaceRuntimeFromState(state, snapshot.workspaceId);
      const nextMeta = { ...state.runningJobMeta };
      delete nextMeta[jobId];
      const remaining = runtime.runningJobs.filter((id) => id !== jobId);
      const nextPatch: WorkspacePatch = {
        ...patch,
        runningJobs: remaining,
        jobsTotal: remaining.length === 0 ? 0 : runtime.jobsTotal,
        jobsCompleted: remaining.length === 0 ? 0 : runtime.jobsCompleted,
        progress: remaining.length === 0 ? null : runtime.progress,
        lastLogLine: remaining.length === 0 ? "" : runtime.lastLogLine,
      };
      return {
        runningJobMeta: nextMeta,
        workspaces: patchWorkspaceRuntime(state.workspaces, snapshot.workspaceId, nextPatch),
        ...(state.activeWorkspaceId === snapshot.workspaceId ? activeRuntimePatch(nextPatch) : {}),
      } as Partial<StudioState>;
    });
  }
}

export { tempDataURLFromB64, writeBase64ToTempFile };

async function materializeHistoryItem(item: HistoryItem): Promise<HistoryItem> {
  return materializeHistoryItemRuntime(item, {
    setState: (fn) => useStudioStore.setState((state) => fn(state)),
  });
}

async function ensureFullHistoryItem(item: HistoryItem | null): Promise<HistoryItem | null> {
  return ensureFullHistoryItemRuntime(item, {
    setState: (fn) => useStudioStore.setState((state) => fn(state)),
  });
}
