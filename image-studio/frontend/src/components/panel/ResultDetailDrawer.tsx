import { useEffect } from "react";
import { ClipboardCopy, Folder, RotateCw, Save, Sparkles, X } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import type { HistoryItem, SizeValue } from "../../types/domain";
import { SaveImageAs, OpenOutputDir } from "../../../wailsjs/go/backend/Service";
import { isWindows, submitShortcutLabel, usesAppleUI } from "../../lib/platform";
import { useBlobURL } from "../../lib/images";
import { androidSaveHint, androidTarget, openOutputLocationForPlatform, saveImageForPlatform } from "../../lib/androidBridge";

const ASPECT_LABEL: Record<SizeValue, string> = {
  auto: "auto",
  "1024x1024": "1:1",
  "1024x1536": "2:3",
  "1152x2048": "9:16",
  "1536x1024": "3:2",
  "2048x1152": "16:9",
};

const QUALITY_LABEL: Record<string, string> = {
  low: "1K (low)",
  medium: "2K (medium)",
  high: "4K (high)",
  auto: "auto",
};

export function ResultDetailDrawer() {
  const item = useStudioStore((s) => s.resultDetail);
  const close = useStudioStore((s) => s.closeResultDetail);
  const setField = useStudioStore((s) => s.setField);
  const pushToast = useStudioStore((s) => s.pushToast);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, close]);

  if (!item) return null;

  const aspect = ASPECT_LABEL[item.size as SizeValue] ?? "";
  const quality = QUALITY_LABEL[item.quality] ?? item.quality;
  const created = new Date(item.createdAt).toLocaleString();
  const previewURL = useBlobURL(item.imageBlob ?? null, item.previewOnly ? item.imageB64 : null);

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => pushToast(`已复制${label}`, "success"),
      () => pushToast("复制失败", "error"),
    );
  }

  function useAsNextPrompt(text: string) {
    setField("prompt", text);
    pushToast(`已应用为下次 prompt,${submitShortcutLabel} 生成`, "success");
    close();
  }

  function openSaveDialog() {
    const it = item!;
    const suggested = `image-${it.mode}-${it.id.slice(0, 8)}.png`;
    saveImageForPlatform(it.imageB64, suggested, SaveImageAs).then(
      (p) => p && pushToast(`已保存:${p.split(/[\\/]/).pop()}`, "success"),
      (e) => pushToast(`保存失败:${e?.message ?? e}`, "error"),
    );
  }

  function openOutputLocation() {
    openOutputLocationForPlatform(OpenOutputDir).catch((e) => pushToast(e?.message ?? "无法打开保存位置", "warn"));
  }

  return (
    <aside
      role="dialog"
      aria-label="生成详情"
      className={`fixed bottom-0 right-0 top-0 z-[9000] flex w-[420px] flex-col border-l border-black/[0.08] bg-white/92 shadow-[0_26px_80px_rgb(15_23_42_/_0.18)] backdrop-blur-2xl animate-[rd-in_180ms_ease-out] dark:border-white/[0.08] dark:bg-zinc-900/92 ${usesAppleUI ? "liquid-sidebar" : ""}`}
      style={{ animation: "rd-in 180ms ease-out" }}
    >
      <style>{`@keyframes rd-in { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
      <header className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.04]">
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">生成详情</span>
        <button
          onClick={close}
          title="关闭 (Esc)"
          className={`-mr-1 p-1.5 text-zinc-500 hover:bg-black/[0.05] hover:text-zinc-900 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 预览 */}
        <div className={`flex items-center justify-center border border-black/[0.08] bg-[var(--surface)] p-2 dark:border-white/[0.06] ${isWindows ? "rounded-[12px]" : "rounded-[18px]"}`}>
          <img
            src={previewURL ?? `data:image/png;base64,${item.imageB64}`}
            alt="生成结果"
            decoding="async"
            className={`max-h-[280px] max-w-full object-contain ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
          />
        </div>

        {/* 参数 */}
        <Section title="参数">
          <Kv label="模式" value={item.mode === "edit" ? "图生图" : "文生图"} />
          <Kv label="尺寸" value={`${item.size}${aspect ? ` · ${aspect}` : ""}`} />
          <Kv label="质量" value={quality} />
          {item.seed ? <Kv label="seed" value={String(item.seed)} mono /> : null}
          {item.styleTag ? <Kv label="风格" value={`#${item.styleTag}`} /> : null}
          {typeof item.elapsedSec === "number" ? <Kv label="耗时" value={`${item.elapsedSec.toFixed(1)}s`} /> : null}
          <Kv label="创建时间" value={created} />
          {item.transport ? <Kv label="通道" value={item.transport} /> : null}
        </Section>

        {/* 原 prompt */}
        <Section title="原 prompt">
          <PromptBlock>{item.prompt || <em className="opacity-60">(空)</em>}</PromptBlock>
          {item.prompt && (
            <div className="flex flex-wrap gap-1.5">
              <Btn onClick={() => copy(item.prompt, "原 prompt")}><ClipboardCopy className="w-3 h-3" /> 复制</Btn>
              <Btn onClick={() => useAsNextPrompt(item.prompt)}><RotateCw className="w-3 h-3" /> 用作下次 prompt</Btn>
            </div>
          )}
        </Section>

        {item.negativePrompt && (
          <Section title="负向 prompt">
            <PromptBlock muted>{item.negativePrompt}</PromptBlock>
            <div className="flex flex-wrap gap-1.5">
              <Btn onClick={() => copy(item.negativePrompt!, "负向 prompt")}><ClipboardCopy className="w-3 h-3" /> 复制</Btn>
            </div>
          </Section>
        )}

        {item.revisedPrompt && (
          <Section
            title={<span className="inline-flex items-center gap-1.5"><Sparkles className="w-3 h-3 text-[var(--accent)]" /> 模型优化后</span>}
            hint="Responses API 模式下文本模型会优化原 prompt 再生图。要逐字使用,可在 prompt 框下勾「不优化提示词」。"
          >
            <PromptBlock highlight>{item.revisedPrompt}</PromptBlock>
            <div className="flex flex-wrap gap-1.5">
              <Btn onClick={() => copy(item.revisedPrompt!, "优化版 prompt")}><ClipboardCopy className="w-3 h-3" /> 复制</Btn>
              <Btn primary onClick={() => useAsNextPrompt(item.revisedPrompt!)}><RotateCw className="w-3 h-3" /> 用作下次 prompt</Btn>
            </div>
          </Section>
        )}

        <Section title="文件">
          {item.savedPath ? (
            <p className={`font-mono-token break-all border border-black/[0.06] bg-[var(--surface)] px-2.5 py-1.5 text-[11px] text-zinc-600 dark:border-white/[0.04] dark:text-zinc-400 ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`} title={item.savedPath}>
              {item.savedPath}
            </p>
          ) : (
            <p className="text-xs text-zinc-500 italic">(本次未落盘 / 路径丢失)</p>
          )}
          {androidTarget.isAndroid && (
            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">{androidSaveHint()}</p>
          )}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {item.savedPath && (
              <Btn onClick={() => copy(item.savedPath!, "路径")}><ClipboardCopy className="w-3 h-3" /> 复制路径</Btn>
            )}
            <Btn onClick={openOutputLocation}><Folder className="w-3 h-3" /> {androidTarget.isAndroid ? "保存位置" : "打开文件夹"}</Btn>
            <Btn onClick={openSaveDialog}><Save className="w-3 h-3" /> 另存为</Btn>
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, hint, children }: {
  title: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`platform-card border border-black/[0.05] bg-white/70 p-4 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03] ${isWindows ? "rounded-[12px]" : "rounded-[18px]"}`}>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">{title}</h3>
      {hint && <p className="text-[10px] text-zinc-500 mb-2 leading-relaxed">{hint}</p>}
      {children}
    </section>
  );
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex text-xs py-0.5 border-b border-dashed border-black/[0.05] dark:border-white/[0.04] last:border-b-0">
      <span className="w-16 text-zinc-500 shrink-0">{label}</span>
      <span className={`flex-1 text-zinc-700 dark:text-zinc-300 break-words ${mono ? "font-mono-token" : ""}`}>
        {value}
      </span>
    </div>
  );
}

function PromptBlock({ children, muted, highlight }: {
  children: React.ReactNode;
  muted?: boolean;
  highlight?: boolean;
}) {
  return (
    <p className={`mb-2 whitespace-pre-wrap break-words px-3 py-2 text-xs leading-relaxed ${
      highlight
        ? "border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] text-[var(--accent)]"
        : muted
          ? "border border-black/[0.06] bg-[var(--surface)] text-zinc-500 dark:border-white/[0.04]"
          : "border border-black/[0.06] bg-[var(--surface)] text-zinc-700 dark:border-white/[0.04] dark:text-zinc-300"
    } ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}>
      {children}
    </p>
  );
}

function Btn({ children, onClick, primary }: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] transition-colors ${
        primary
          ? "border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90"
          : "border border-black/[0.08] text-zinc-700 hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.06] dark:text-zinc-300"
      } ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
    >
      {children}
    </button>
  );
}

// ensure HistoryItem import is treated as used by TS
export type _UnusedHi = HistoryItem;
