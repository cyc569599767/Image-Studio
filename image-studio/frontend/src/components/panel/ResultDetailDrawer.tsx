import { useEffect } from "react";
import { useStudioStore } from "../../state/studioStore";
import type { HistoryItem, SizeValue } from "../../types/domain";
import { SaveImageAs, OpenOutputDir } from "../../../wailsjs/go/backend/Service";

// ResultDetailDrawer —— 右侧抽屉,显示某张已生成图的全部细节。
//
// 形态:非 modal,主界面仍可交互(切 tab、改参数都不影响抽屉)。
// 锁定:打开时记下的是用户点击「查看详情」时的那一张,之后即使 currentImage 切换、
//       历史栏滚动、批量后续完成,抽屉显示的内容也不变,直到用户主动关闭或换张。

const ASPECT_LABEL: Record<SizeValue, string> = {
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

  // Esc 关闭
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, close]);

  if (!item) return null;

  const aspect = ASPECT_LABEL[item.size as SizeValue] ?? "";
  const quality = QUALITY_LABEL[item.quality] ?? item.quality;
  const created = new Date(item.createdAt).toLocaleString();

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(
      () => pushToast(`已复制${label}`, "success"),
      () => pushToast("复制失败", "error"),
    );
  }

  function useAsNextPrompt(text: string) {
    setField("prompt", text);
    pushToast("已应用为下次 prompt,Ctrl+Enter 生成", "success");
    close();
  }

  function openSaveDialog() {
    const it = item!;
    const suggested = `image-${it.mode}-${it.id.slice(0, 8)}.png`;
    SaveImageAs(it.imageB64, suggested).then(
      (p) => p && pushToast(`已保存:${p.split(/[\\/]/).pop()}`, "success"),
      (e) => pushToast(`保存失败:${e?.message ?? e}`, "error"),
    );
  }

  return (
    <aside className="result-drawer" role="dialog" aria-label="生成详情">
      <header className="result-drawer-head">
        <span className="result-drawer-title">生成详情</span>
        <button type="button" className="result-drawer-close" onClick={close} title="关闭 (Esc)">×</button>
      </header>

      <div className="result-drawer-body">
        {/* 图片预览 */}
        <div className="rd-preview">
          <img src={`data:image/png;base64,${item.imageB64}`} alt="生成结果" />
        </div>

        {/* 参数 */}
        <Section title="📐 参数">
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
        <Section title="💬 原 prompt">
          <p className="rd-prompt">{item.prompt || <em style={{ opacity: 0.6 }}>(空)</em>}</p>
          {item.prompt && (
            <div className="rd-actions">
              <button type="button" className="rd-btn" onClick={() => copy(item.prompt, "原 prompt")}>
                📋 复制
              </button>
              <button type="button" className="rd-btn" onClick={() => useAsNextPrompt(item.prompt)}>
                ↻ 用作下次 prompt
              </button>
            </div>
          )}
        </Section>

        {/* 负向 prompt */}
        {item.negativePrompt ? (
          <Section title="⛔ 负向 prompt">
            <p className="rd-prompt rd-prompt-muted">{item.negativePrompt}</p>
            <div className="rd-actions">
              <button type="button" className="rd-btn" onClick={() => copy(item.negativePrompt!, "负向 prompt")}>
                📋 复制
              </button>
            </div>
          </Section>
        ) : null}

        {/* 修订 prompt(仅 Responses API 才有)*/}
        {item.revisedPrompt ? (
          <Section title="✨ 模型修订后" hint="Responses API 模式下,模型会把原 prompt 改写成更具体的描述,然后再生图。">
            <p className="rd-prompt rd-prompt-revised">{item.revisedPrompt}</p>
            <div className="rd-actions">
              <button type="button" className="rd-btn" onClick={() => copy(item.revisedPrompt!, "修订 prompt")}>
                📋 复制
              </button>
              <button type="button" className="rd-btn rd-btn-primary" onClick={() => useAsNextPrompt(item.revisedPrompt!)}>
                ↻ 用作下次 prompt
              </button>
            </div>
          </Section>
        ) : null}

        {/* 文件 */}
        <Section title="🗂 文件">
          {item.savedPath ? (
            <p className="rd-path" title={item.savedPath}>{item.savedPath}</p>
          ) : (
            <p className="rd-prompt-muted"><em>(本次未落盘 / 路径丢失)</em></p>
          )}
          <div className="rd-actions">
            {item.savedPath && (
              <button type="button" className="rd-btn" onClick={() => copy(item.savedPath!, "路径")}>
                📋 复制路径
              </button>
            )}
            <button type="button" className="rd-btn" onClick={() => OpenOutputDir().catch(() => undefined)}>
              📂 打开文件夹
            </button>
            <button type="button" className="rd-btn" onClick={openSaveDialog}>
              💾 另存为
            </button>
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rd-section">
      <h3 className="rd-section-title">{title}</h3>
      {hint && <p className="rd-section-hint">{hint}</p>}
      {children}
    </section>
  );
}

function Kv({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rd-kv">
      <span className="rd-kv-label">{label}</span>
      <span className="rd-kv-value" style={mono ? { fontFamily: "'JetBrains Mono', ui-monospace, monospace" } : undefined}>{value}</span>
    </div>
  );
}

// ensure HistoryItem import is treated as used by TS
export type _UnusedHi = HistoryItem;
