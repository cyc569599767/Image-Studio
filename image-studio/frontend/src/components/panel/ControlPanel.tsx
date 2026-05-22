import { lazy, Suspense, useState } from "react";
import {
  Dices, ImagePlus, ListPlus, RotateCw, Trash2, X,
} from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { SizeValue, QualityValue, Mode, OutputFormatValue, OUTPUT_FORMAT_OPTIONS } from "../../types/domain";
import { SettingsPanel } from "./SettingsPanel";
import { submitShortcutLabel } from "../../lib/platform";

const PromptPopover = lazy(() => import("./PromptPopover").then((m) => ({ default: m.PromptPopover })));

const STYLE_CHIPS: { id: string; label: string }[] = [
  { id: "cyberpunk", label: "赛博朋克" },
  { id: "anime",     label: "二次元" },
  { id: "illust",    label: "插画" },
  { id: "3d",        label: "3D 渲染" },
  { id: "chinese",   label: "国风" },
];

// auto 项不展示具体方框形状(让上游决定),用一个虚线方框作为视觉占位。
const ASPECT_OPTIONS: { value: SizeValue; label: string; w: number; h: number; auto?: boolean }[] = [
  { value: "auto",      label: "Auto", w: 18, h: 18, auto: true },
  { value: "1024x1024", label: "1:1",  w: 18, h: 18 },
  { value: "1024x1536", label: "2:3",  w: 14, h: 20 },
  { value: "1152x2048", label: "9:16", w: 12, h: 22 },
  { value: "1536x1024", label: "3:2",  w: 22, h: 14 },
  { value: "2048x1152", label: "16:9", w: 24, h: 13 },
];

const QUALITY_TIERS: { value: QualityValue; label: string }[] = [
  { value: "auto",   label: "Auto" },
  { value: "low",    label: "1K" },
  { value: "medium", label: "2K" },
  { value: "high",   label: "4K" },
];

export function ControlPanel() {
  const {
    apiKey, mode, prompt, negativePrompt, size, quality, seed, styleTag,
    outputFormat,
    sources, currentImage,
    errorMessage, isRunning, lastPayload, isTestingKey,
    apiMode, baseURL,
    noPromptRevision,
    setField,
    selectSourceImage, removeSource, clearSources,
    submit, cancel, retryLast,
  } = useStudioStore();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [promptPopover, setPromptPopover] = useState(false);

  const promptLen = prompt.length;

  return (
    <div className="flex w-[336px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-black/[0.06] bg-[var(--sidebar)] px-4 py-4 backdrop-blur-2xl dark:border-white/[0.06]">
      <section className="rounded-[18px] border border-black/[0.05] bg-white/70 px-4 py-3 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-100">
              图像工作台
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              保持界面简洁，把注意力留给 prompt、参考图和结果。
            </p>
          </div>
          <div className="rounded-2xl bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent)]">
            {mode === "edit" ? "Edit" : "Generate"}
          </div>
        </div>
      </section>

      {errorMessage && (
        <div className="rounded-[18px] border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-700 shadow-[var(--shadow-card)] dark:text-red-200">
          <div className="flex items-start gap-2">
            <div className="flex-1 whitespace-pre-wrap leading-relaxed">{errorMessage}</div>
            <button
              onClick={() => setField("errorMessage", null)}
              className="-m-1 rounded-full p-1 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              title="关闭"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {lastPayload && !isRunning && (
            <button
              onClick={retryLast}
              className="mt-2 inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-1 text-[11px] transition-colors hover:bg-red-500/25"
            >
              <RotateCw className="w-3 h-3" /> 重试上次请求
            </button>
          )}
        </div>
      )}

      {/* 模式 */}
      <Section label="模式">
        <Seg>
          {(["generate", "edit"] as Mode[]).map((m) => (
            <SegItem
              key={m}
              active={mode === m}
              onClick={() => setField("mode", m)}
            >
              {m === "generate" ? "📝 文生图" : "🖼 图生图"}
            </SegItem>
          ))}
        </Seg>
      </Section>

      {/* Prompt */}
      <section className="relative rounded-[18px] border border-black/[0.05] bg-white/70 p-4 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[11px] uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
            {mode === "edit" ? "修改要求" : "Prompt 提示词"}
          </label>
          <span className="font-mono-token text-zinc-400 dark:text-zinc-600 tabular-nums">{promptLen}</span>
        </div>
        <textarea
          value={prompt}
          placeholder={mode === "edit"
            ? "描述如何修改源图(例如:把背景换成夜空,人物保持不变)..."
            : "描述你想要生成的画面内容,越详细越好..."}
          onChange={(e) => setField("prompt", e.target.value)}
          className="focus-ring w-full min-h-[124px] resize-y rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-3 text-[14px] leading-relaxed text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <div className="flex items-center justify-between mt-1.5 gap-2">
          <button
            type="button"
            onClick={() => setPromptPopover((v) => !v)}
            title="prompt 模板与历史"
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
          >
            <ListPlus className="w-3 h-3" /> 模板 / 历史
          </button>
          <label
            title={apiMode === "responses"
              ? "勾上后 Responses API 文本模型不会优化你的 prompt,逐字传给图像模型"
              : "Images API 形态本就不优化 prompt,此开关无效"}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 transition-colors ${
              noPromptRevision
                ? "bg-[var(--accent-soft)] text-[var(--accent)] ring-[color:var(--accent)]/20"
                : "text-zinc-500 dark:text-zinc-400 ring-transparent hover:ring-black/[0.08] dark:hover:ring-white/[0.06]"
            } ${apiMode !== "responses" ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              checked={noPromptRevision}
              disabled={apiMode !== "responses"}
              onChange={(e) => setField("noPromptRevision", e.target.checked)}
              className="sr-only peer"
            />
            <span className={`flex h-3.5 w-3.5 items-center justify-center rounded border transition-colors ${noPromptRevision ? "border-[var(--accent)] bg-[var(--accent)]" : "border-zinc-400 dark:border-zinc-600"}`}>
              {noPromptRevision && <span className="h-1.5 w-1.5 rounded-sm bg-white" />}
            </span>
            不优化提示词
          </label>
          <span className="text-[10px] text-zinc-400 dark:text-zinc-600">{submitShortcutLabel}</span>
        </div>
        {promptPopover && (
          <Suspense fallback={null}>
            <PromptPopover
              onClose={() => setPromptPopover(false)}
              onPick={(text) => {
                const current = useStudioStore.getState().prompt;
                setField("prompt", current ? `${current}\n${text}` : text);
              }}
            />
          </Suspense>
        )}
      </section>

      {/* 风格 */}
      <Section label="风格" trailing={styleTag ? (
        <button onClick={() => setField("styleTag", "")} className="text-[11px] text-[var(--accent)] hover:opacity-80">清除</button>
      ) : null}>
        <div className="flex flex-wrap gap-1.5">
          {STYLE_CHIPS.map((s) => {
            const active = styleTag === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setField("styleTag", active ? "" : s.id)}
                className={`rounded-full px-2.5 py-1.5 text-xs ring-1 transition-colors ${
                  active
                    ? "bg-[var(--accent-soft)] text-[var(--accent)] ring-[color:var(--accent)]/20"
                    : "text-zinc-600 dark:text-zinc-400 ring-black/[0.08] dark:ring-white/[0.08] hover:text-zinc-900 dark:hover:text-zinc-200 hover:ring-[color:var(--accent)]/30"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </Section>

      {/* 比例 */}
      <Section label="比例">
        <div className="grid grid-cols-6 gap-1.5">
          {ASPECT_OPTIONS.map((a) => {
            const active = size === a.value;
            return (
              <button
                key={a.value}
                onClick={() => setField("size", a.value)}
                title={a.auto ? "让上游决定尺寸 / 比例" : a.value}
                className={`flex flex-col items-center gap-1 rounded-[14px] py-2 ring-1 transition-colors ${
                  active
                    ? "bg-[var(--accent-soft)] ring-[color:var(--accent)]/35"
                    : "ring-black/[0.08] dark:ring-white/[0.08] hover:ring-[color:var(--accent)]/30"
                }`}
              >
                <span
                  className={`block rounded-sm border-2 ${a.auto ? "border-dashed" : ""} ${
                    active ? "border-[var(--accent)]" : "border-zinc-400 dark:border-zinc-600"
                  }`}
                  style={{ width: a.w, height: a.h }}
                />
                <span className={`text-[10px] ${active ? "text-[var(--accent)]" : "text-zinc-500"}`}>{a.label}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* 质量 */}
      <Section label="质量">
        <Seg>
          {QUALITY_TIERS.map((q) => (
            <SegItem
              key={q.value}
              active={quality === q.value}
              onClick={() => setField("quality", q.value as QualityValue)}
            >
              {q.label}
            </SegItem>
          ))}
        </Seg>
      </Section>

      {/* 源图(只在 edit 模式)*/}
      {mode === "edit" && (
        <Section
          label={`源图片 / 参考图${sources.length > 0 ? ` · ${sources.length} 张` : ""}`}
        >
          <div className="flex flex-col gap-1.5">
            {sources.length === 0 && currentImage?.savedPath && (
              <div className="rounded-[14px] border border-black/[0.06] bg-[var(--surface)] px-3 py-2 text-xs italic text-zinc-500 dark:border-white/[0.04] dark:text-zinc-500">
                (画板当前图 · 隐式源图)
              </div>
            )}
            {sources.map((src, i) => (
              <div key={src.path} className="flex items-center gap-1 rounded-[14px] border border-black/[0.06] bg-[var(--surface)] px-2.5 py-2 dark:border-white/[0.06]">
                <span className="flex-1 text-xs text-zinc-700 dark:text-zinc-300 truncate" title={src.path}>
                  {i + 1}. {src.name}
                </span>
                <button
                  onClick={() => removeSource(i)}
                  title="移除"
                  className="-m-1 rounded-full p-1 text-zinc-400 hover:bg-red-500/10 hover:text-red-400"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <button onClick={selectSourceImage} className="flex-1 inline-flex items-center justify-center gap-1 rounded-full border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300">
                <ImagePlus className="w-3.5 h-3.5" /> 添加图片
              </button>
              {sources.length > 0 && (
                <button onClick={clearSources} className="inline-flex items-center gap-1 rounded-full border border-black/[0.08] px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-red-400/40 hover:text-red-400 dark:border-white/[0.08]">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </Section>
      )}

      {/* 高级参数(可折叠)*/}
      <section>
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          type="button"
          className="flex w-full items-center justify-between rounded-[14px] border border-black/[0.05] bg-white/70 px-4 py-3 text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:border-white/[0.06] dark:bg-white/[0.03] dark:hover:text-zinc-200"
        >
          <span className="uppercase tracking-[0.12em]">高级参数</span>
          <span className="text-[10px] opacity-60">{advancedOpen ? "收起 ▾" : "展开 ▸"}</span>
        </button>
        {advancedOpen && (
          <div className="mt-2 flex flex-col gap-2 rounded-[18px] border border-black/[0.05] bg-white/70 p-4 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
            <textarea
              value={negativePrompt}
              placeholder="负向提示词(不希望出现的元素)..."
              onChange={(e) => setField("negativePrompt", e.target.value)}
              className="focus-ring min-h-[56px] w-full resize-y rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">输出格式</label>
              <Seg>
                {OUTPUT_FORMAT_OPTIONS.map((f) => (
                  <SegItem
                    key={f.value}
                    active={outputFormat === f.value}
                    onClick={() => setField("outputFormat", f.value as OutputFormatValue)}
                  >
                    {f.label}
                  </SegItem>
                ))}
              </Seg>
              <p className="text-[10px] text-zinc-500 mt-1">JPEG/WebP 体积更小;落盘扩展名 jpeg→.jpg</p>
            </div>
            <div className="flex gap-1.5">
              <input
                type="number"
                value={seed || ""}
                placeholder="seed (留空=随机)"
                min={0}
                onChange={(e) => setField("seed", Number(e.target.value) || 0)}
                className="focus-ring flex-1 rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-xs font-mono-token text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500"
              />
              <button
                onClick={() => setField("seed", Math.floor(Math.random() * 2_000_000_000))}
                title="随机 seed"
                className="rounded-full border border-black/[0.08] px-2.5 py-2 text-zinc-600 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-400"
              >
                <Dices className="w-3.5 h-3.5" />
              </button>
              {seed > 0 && (
                <button
                  onClick={() => setField("seed", 0)}
                  title="清除"
                  className="rounded-full border border-black/[0.08] px-2.5 py-2 text-zinc-500 transition-colors hover:border-red-400/40 hover:text-red-400 dark:border-white/[0.08]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      {/* 生成按钮 */}
      <div className="sticky bottom-0 -mx-4 mt-auto bg-gradient-to-t from-[var(--sidebar)] via-[color:var(--sidebar)]/96 to-transparent px-4 pb-4 pt-2">
        {isRunning ? (
          <button
            onClick={cancel}
            className="w-full rounded-full border border-red-500/30 bg-red-500/10 py-3 font-medium text-red-500 transition-colors hover:bg-red-500/16"
          >
            取消生成
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!apiKey || !prompt}
            className="w-full rounded-full bg-[var(--accent)] py-3 font-semibold text-white transition-colors hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-800"
          >
            {mode === "edit" ? "编辑" : "生成"}
          </button>
        )}
        {(!apiKey || !baseURL) && (
          <p className="mt-2 text-[11px] text-zinc-500 text-center">
            首次使用请先在右侧工作栏顶部配置上游
          </p>
        )}
      </div>

      <SettingsPanel />
    </div>
  );
}

// ---- 内部 helpers ----

function Section({
  label, trailing, children,
}: {
  label: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[18px] border border-black/[0.05] bg-white/70 p-4 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-[11px] uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">{label}</label>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function Seg({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-1 rounded-full bg-black/[0.04] p-0.5 ring-1 ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06]">
      {children}
    </div>
  );
}

function SegItem({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-full px-2 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}
