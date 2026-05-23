// Domain types shared across components. Backend-emitted shapes live in
// wailsjs/go/models.ts; this file owns the frontend-only state.

export type Mode = "generate" | "edit";

export type SizeValue = "auto" | "1024x1024" | "1536x1024" | "1024x1536" | "2048x1152" | "1152x2048";
export type QualityValue = "auto" | "high" | "medium" | "low";
export type TransportKind = "auto" | "native" | "curl";
// 让上游做编码;落盘扩展名 jpeg → .jpg,其他原样。
export type OutputFormatValue = "png" | "jpeg" | "webp";
export type ThemeMode = "system" | "light" | "dark";

export interface SizeOption { value: SizeValue; label: string; }
export interface QualityOption { value: QualityValue; label: string; }
export interface OutputFormatOption { value: OutputFormatValue; label: string; }

export const SIZE_OPTIONS: SizeOption[] = [
  { value: "auto",      label: "自适应 auto" },
  { value: "1024x1024", label: "正方形 1024×1024" },
  { value: "1536x1024", label: "横版 1536×1024" },
  { value: "1024x1536", label: "竖版 1024×1536" },
  { value: "2048x1152", label: "宽屏 2048×1152" },
  { value: "1152x2048", label: "竖屏 1152×2048" },
];

export const QUALITY_OPTIONS: QualityOption[] = [
  { value: "auto",   label: "自适应 auto" },
  { value: "high",   label: "高质量 high" },
  { value: "medium", label: "中等 medium" },
  { value: "low",    label: "快速草稿 low" },
];

export const OUTPUT_FORMAT_OPTIONS: OutputFormatOption[] = [
  { value: "png",  label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

export interface SourceImage {
  // Local path on disk (path is what the Go backend ultimately reads).
  path: string;
  name: string;
  size: number;       // bytes; 0 when unknown (e.g. reused-from-history)
  imageBlob?: Blob | null;
  // Optional base64 for canvas preview, only kept when freshly imported.
  // Items added via OpenImageDialog don't carry b64 to keep memory bounded.
  imageB64?: string;
}

export interface HistoryItem {
  id: string;
  // For history entries this may be a compact preview; currentImage/resultDetail
  // may hold the full-resolution image.
  imageB64: string;
  imageBlob?: Blob | null;
  previewBlob?: Blob | null;
  previewOnly?: boolean;
  prompt: string;
  revisedPrompt?: string;
  mode: Mode;
  size: SizeValue;
  quality: QualityValue;
  outputFormat?: OutputFormatValue;
  parentId?: string;       // id of the source image (when mode === "edit")
  createdAt: number;       // unix ms

  // Extended params — captured at submit time so the item can be exactly
  // reproduced via "重新生成" or "应用参数" from the right-click menu.
  seed?: number;
  negativePrompt?: string;
  styleTag?: string;
  transport?: TransportKind;
  elapsedSec?: number;     // generation duration in seconds

  savedPath?: string;
  rawPath?: string;
}

export interface ProgressInfo {
  stage: string;
  elapsed: number;
  bytes: number;
}

export interface Workspace {
  id: string;
  name: string;
  // Fields whose value is workspace-scoped (different per tab).
  prompt: string;
  negativePrompt: string;
  mode: Mode;
  size: SizeValue;
  quality: QualityValue;
  outputFormat: OutputFormatValue;
  seed: number;
  batchCount: number;
  sources: SourceImage[];
  // We store currentImageId rather than the full HistoryItem so we don't
  // duplicate large base64 blobs. The history list is shared across tabs.
  currentImageId: string | null;
}

export interface Preset {
  id: string;
  name: string;
  size: SizeValue;
  quality: QualityValue;
  outputFormat?: OutputFormatValue;
  negativePrompt: string;
  transport: TransportKind;
  batchCount: number;
}

export interface Toast {
  id: string;
  text: string;
  kind: "info" | "success" | "error" | "warn";
  // Unix ms when the toast was created — used for ordering and auto-dismiss.
  createdAt: number;
  // Auto-dismiss timeout in ms; 0 = sticky (manual close only).
  ttl: number;
  // 可选 CTA。点击触发 onClick 后 toast 自动关闭。
  action?: { label: string; onClick: () => void };
}

export type AnnotationKind = "rect" | "arrow" | "text" | "freehand";

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  color: string;
  // For freehand: flat number[] of x,y,x,y,... in image-local coords.
  points?: number[];
}

export const ANNOTATION_COLORS = [
  "#ff4d4d", "#ff9c00", "#ffd400", "#7bd400",
  "#00c8ff", "#4d7cff", "#a060ff", "#ff60c8",
];
