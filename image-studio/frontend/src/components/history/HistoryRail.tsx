import { Suspense, lazy, useDeferredValue, useMemo, useState } from "react";
import { Clipboard, Copy, FileText, HelpCircle, Info, ListRestart, Plug, RotateCw, Settings, Sparkles, Split, Trash2, X } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import type { HistoryItem, Mode } from "../../types/domain";
import { ContextMenu, MenuItem } from "../common/ContextMenu";
import { RawResponseModal } from "./RawResponseModal";

const FAQModal = lazy(() => import("../panel/FAQModal").then((m) => ({ default: m.FAQModal })));

type ModeFilter = "all" | Mode;
type DateFilter = "all" | "today" | "week";

function inDateFilter(h: HistoryItem, f: DateFilter): boolean {
  if (f === "all") return true;
  const now = Date.now();
  const t = h.createdAt;
  if (f === "today") {
    const d1 = new Date(now); d1.setHours(0, 0, 0, 0);
    return t >= d1.getTime();
  }
  return now - t < 7 * 24 * 3600 * 1000;
}

export function HistoryRail() {
  const {
    history, currentImage, reuseAsSource, deleteHistoryItem, setField,
    compareB, setCompareB, pushToast, fullscreen,
    applyHistoryParams, regenerateFromHistory,
    openResultDetail, apiKey, baseURL, apiMode, responsesConfig, imagesConfig,
    openUpstreamConfig, testAPIKey, isTestingKey,
  } = useStudioStore();

  const [q, setQ] = useState("");
  const deferredQ = useDeferredValue(q);
  const [modeF, setModeF] = useState<ModeFilter>("all");
  const [dateF, setDateF] = useState<DateFilter>("all");
  const [menu, setMenu] = useState<{ x: number; y: number; h: HistoryItem } | null>(null);
  const [rawPath, setRawPath] = useState<string | null>(null);
  const [faqOpen, setFaqOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = deferredQ.trim().toLowerCase();
    return history.filter((h) => {
      if (modeF !== "all" && h.mode !== modeF) return false;
      if (!inDateFilter(h, dateF)) return false;
      if (!needle) return true;
      const hay = `${h.prompt ?? ""} ${h.revisedPrompt ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [history, deferredQ, modeF, dateF]);

  async function selectCurrent(h: HistoryItem) {
    if (h.savedPath && h.previewOnly) {
      try {
        const full = await useStudioStore.getState().materializeCurrentImage?.(h);
        setField("currentImage", full ?? h);
        return;
      } catch {
        // fallback to preview
      }
    }
    setField("currentImage", h);
  }

  function buildMenu(h: HistoryItem): MenuItem[] {
    return [
      { label: "详情", icon: "ℹ", onClick: () => openResultDetail(h) },
      {
        label: "复制 prompt",
        icon: "📋",
        separatorBefore: true,
        onClick: () => navigator.clipboard.writeText(h.prompt ?? "").then(
          () => pushToast("已复制 prompt", "success"),
          () => pushToast("复制失败", "error"),
        ),
      },
      {
        label: "复制本地路径",
        icon: "📁",
        disabled: !h.savedPath,
        onClick: () => navigator.clipboard.writeText(h.savedPath ?? "").then(
          () => pushToast("已复制路径", "success"),
          () => pushToast("复制失败", "error"),
        ),
      },
      { label: "查看 raw 响应", icon: "📄", disabled: !h.rawPath, onClick: () => setRawPath(h.rawPath ?? null) },
      { separatorBefore: true, label: "应用参数(不生成)", icon: "📥", onClick: () => applyHistoryParams(h) },
      { label: "以此参数重新生成", icon: "↻", onClick: () => regenerateFromHistory(h) },
      { separatorBefore: true, label: "设为源图", icon: "→", onClick: () => reuseAsSource(h), disabled: !h.savedPath },
      { label: "用作对比图 (B)", icon: "⇄", onClick: () => setCompareB(h), disabled: currentImage?.id === h.id },
      { label: "删除", icon: "✕", danger: true, separatorBefore: true, onClick: () => {
        if (window.confirm(`确定删除此历史项?\n\n${h.prompt?.slice(0, 60) || "(无 prompt)"}`)) {
          deleteHistoryItem(h.id);
        }
      } },
    ];
  }

  if (fullscreen) return null;

  return (
    <aside className="flex w-[292px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-black/[0.06] bg-[var(--inspector)] px-3 py-4 backdrop-blur-2xl dark:border-white/[0.06]">
      <div className="rounded-[18px] border border-black/[0.05] bg-white/70 p-3 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
              上游
            </h3>
            <span className={`h-1.5 w-1.5 rounded-full ${apiKey && baseURL ? "bg-[var(--accent)] shadow-[0_0_6px_rgb(0_122_255_/_0.55)]" : "bg-red-500"}`} />
            <span className={`text-[10px] ${apiKey && baseURL ? "text-[var(--accent)]" : "text-red-400"}`}>
              {apiKey && baseURL ? "已配置" : "未配置"}
            </span>
          </div>
          <button
            onClick={() => setFaqOpen(true)}
            title="关于 API Key 分组、模型选择等"
            className="inline-flex items-center gap-0.5 text-[11px] text-zinc-500 transition-colors hover:text-[var(--accent)]"
          >
            <HelpCircle className="h-3 w-3" /> FAQ
          </button>
        </div>

        <div className="mt-3 flex gap-1 rounded-full bg-black/[0.04] p-0.5 ring-1 ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06]">
          {(["responses", "images"] as const).map((m) => {
            const cfg = m === "responses" ? responsesConfig : imagesConfig;
            const ready = cfg.apiKey.trim() && cfg.baseURL.trim();
            const active = apiMode === m;
            return (
              <button
                key={m}
                onClick={() => setField("apiMode", m)}
                title={ready ? `${m} · 已配置 · ${cfg.baseURL.replace(/^https?:\/\//, "")}` : `${m} · 未配置`}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  active
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
                }`}
              >
                {m === "responses" ? "Responses" : "Images"}
                <span className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-[var(--accent)]" : "bg-zinc-400 dark:bg-zinc-600"}`} />
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex gap-1.5">
          <button
            onClick={openUpstreamConfig}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-full border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300"
          >
            <Settings className="h-3.5 w-3.5" /> 上游配置
          </button>
          <button
            onClick={testAPIKey}
            disabled={!apiKey.trim() || !baseURL.trim() || isTestingKey}
            title="发送一个最小请求验证 BASE_URL + API Key + 分组权限"
            className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-zinc-300"
          >
            <Plug className={`h-3.5 w-3.5 ${isTestingKey ? "animate-spin" : ""}`} /> {isTestingKey ? "测试中..." : "测试"}
          </button>
        </div>

        <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-500">
          {apiMode === "responses"
            ? "Responses API · key 需绑「拥有 gpt-5.5 模型的分组」(可防 CF 524)"
            : "Images API · 可使用标准 image-2 / image API 分组"}
        </p>
      </div>

      <div className="rounded-[18px] border border-black/[0.05] bg-white/70 p-3 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400">
            历史 <span className="font-mono-token text-zinc-500">({filtered.length}{filtered.length !== history.length && `/${history.length}`})</span>
          </h3>
          <button
            onClick={() => setField("currentImage", null)}
            title="清空画板(不删历史)"
            className="text-[11px] text-zinc-500 transition-colors hover:text-[var(--accent)]"
          >
            清空画板
          </button>
        </div>

        <input
          placeholder="搜索 prompt..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="focus-ring mt-3 w-full rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <div className="mt-2 flex gap-1.5">
          <select
            value={modeF}
            onChange={(e) => setModeF(e.target.value as ModeFilter)}
            className="focus-ring flex-1 rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-[11px] text-zinc-700 dark:border-white/[0.08] dark:text-zinc-300"
          >
            <option value="all">全部模式</option>
            <option value="generate">文生图</option>
            <option value="edit">图生图</option>
          </select>
          <select
            value={dateF}
            onChange={(e) => setDateF(e.target.value as DateFilter)}
            className="focus-ring flex-1 rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-[11px] text-zinc-700 dark:border-white/[0.08] dark:text-zinc-300"
          >
            <option value="all">全部日期</option>
            <option value="today">今天</option>
            <option value="week">本周</option>
          </select>
        </div>

        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          点击查看 · Shift+点击对比 · 双击设源图 · 右键更多
        </p>
      </div>

      {compareB && (
        <button
          onClick={() => setCompareB(null)}
          className="inline-flex items-center justify-center gap-1.5 rounded-full border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] px-2.5 py-2 text-xs text-[var(--accent)] transition-colors hover:opacity-90"
        >
          <Split className="w-3 h-3" /> 退出对比
        </button>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[18px] border border-black/[0.05] bg-white/70 py-8 text-center text-xs text-zinc-500 shadow-[var(--shadow-card)] dark:border-white/[0.06] dark:bg-white/[0.03]">
          {q || modeF !== "all" || dateF !== "all" ? "没有匹配项" : "还没有结果"}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((h) => {
            const isCurrent = currentImage?.id === h.id;
            const isCompare = compareB?.id === h.id;
            return (
              <div
                key={h.id}
                title={h.prompt}
                onClick={(e) => {
                  if (e.shiftKey) {
                    if (isCompare) setCompareB(null);
                    else if (currentImage && currentImage.id !== h.id) setCompareB(h);
                  } else {
                    void selectCurrent(h);
                  }
                }}
                onDoubleClick={() => reuseAsSource(h)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, h });
                }}
                className={`group relative aspect-square cursor-pointer overflow-hidden rounded-[18px] border bg-white/70 shadow-[var(--shadow-card)] transition-all dark:bg-white/[0.03] ${
                  isCurrent
                    ? "border-[color:var(--accent)] shadow-[0_0_0_1px_var(--accent)]"
                    : isCompare
                      ? "border-blue-400 shadow-[0_0_0_1px_rgb(96_165_250)]"
                      : "border-black/[0.06] hover:border-[color:var(--accent)]/30 dark:border-white/[0.06]"
                }`}
              >
                <img
                  src={`data:image/png;base64,${h.imageB64}`}
                  alt={h.prompt}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
                <span className="absolute left-1.5 top-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] text-white backdrop-blur-sm">
                  {h.mode === "edit" ? "Edit" : "Generate"}
                </span>
                {isCompare && (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-blue-500 px-1.5 py-0.5 text-[9px] text-white">B</span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); deleteHistoryItem(h.id); }}
                  title="删除"
                  className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-all group-hover:opacity-100 hover:bg-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.h)} onClose={() => setMenu(null)} />}
      {rawPath && <RawResponseModal path={rawPath} onClose={() => setRawPath(null)} />}
      {faqOpen && (
        <Suspense fallback={null}>
          <FAQModal open={faqOpen} onClose={() => setFaqOpen(false)} />
        </Suspense>
      )}

      {/* 防止 lucide import 未使用警告 */}
      <Clipboard className="hidden" /><Copy className="hidden" /><FileText className="hidden" />
      <Info className="hidden" /><ListRestart className="hidden" /><RotateCw className="hidden" /><Sparkles className="hidden" />
      <Trash2 className="hidden" />
    </aside>
  );
}
