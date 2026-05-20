import { useMemo, useState } from "react";
import { useStudioStore } from "../../state/studioStore";
import type { HistoryItem, Mode } from "../../types/domain";
import { ContextMenu, MenuItem } from "../common/ContextMenu";
import { RawResponseModal } from "./RawResponseModal";

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
    openResultDetail,
  } = useStudioStore();

  const [q, setQ] = useState("");
  const [modeF, setModeF] = useState<ModeFilter>("all");
  const [dateF, setDateF] = useState<DateFilter>("all");
  const [menu, setMenu] = useState<{ x: number; y: number; h: HistoryItem } | null>(null);
  const [rawPath, setRawPath] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return history.filter((h) => {
      if (modeF !== "all" && h.mode !== modeF) return false;
      if (!inDateFilter(h, dateF)) return false;
      if (!needle) return true;
      const hay = `${h.prompt ?? ""} ${h.revisedPrompt ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [history, q, modeF, dateF]);

  function buildMenu(h: HistoryItem): MenuItem[] {
    return [
      {
        label: "详情",
        icon: "ℹ",
        onClick: () => openResultDetail(h),
      },
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
    <div className="history">
      <div className="history-section-head">
        <h3>
          历史 ({filtered.length}
          {filtered.length !== history.length && <span style={{ color: "var(--text-dim)", fontWeight: "normal" }}>/{history.length}</span>})
        </h3>
        <span className="head-link" onClick={() => setField("currentImage", null)} title="清空画板(不删历史)">清空画布</span>
      </div>

      <input
        className="input"
        style={{ fontSize: 11, padding: "5px 8px" }}
        placeholder="搜索 prompt..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="row" style={{ gap: 4 }}>
        <select className="select" style={{ fontSize: 11, padding: "4px 6px" }} value={modeF} onChange={(e) => setModeF(e.target.value as ModeFilter)}>
          <option value="all">全部模式</option>
          <option value="generate">文生图</option>
          <option value="edit">图生图</option>
        </select>
        <select className="select" style={{ fontSize: 11, padding: "4px 6px" }} value={dateF} onChange={(e) => setDateF(e.target.value as DateFilter)}>
          <option value="all">全部日期</option>
          <option value="today">今天</option>
          <option value="week">本周</option>
        </select>
      </div>

      <p style={{ fontSize: 10, color: "var(--text-dim)", margin: "2px 0 4px", lineHeight: 1.4 }}>
        点击查看 · Shift+点击对比 · 双击设为源 · 右键更多
      </p>

      {compareB && (
        <button className="tool-btn" style={{ marginBottom: 6 }} onClick={() => setCompareB(null)}>
          ✕ 退出对比
        </button>
      )}

      {filtered.length === 0 && (
        <div className="empty">{q || modeF !== "all" || dateF !== "all" ? "没有匹配项" : "还没有结果"}</div>
      )}

      <div className="thumb-grid">
        {filtered.map((h) => {
          const isCurrent = currentImage?.id === h.id;
          const isCompare = compareB?.id === h.id;
          return (
            <div
              key={h.id}
              className={`thumb ${isCurrent ? "active" : ""} ${isCompare ? "compare" : ""}`}
              title={h.prompt}
              onClick={(e) => {
                if (e.shiftKey) {
                  if (isCompare) setCompareB(null);
                  else if (currentImage && currentImage.id !== h.id) setCompareB(h);
                } else {
                  setField("currentImage", h);
                }
              }}
              onDoubleClick={() => reuseAsSource(h)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, h });
              }}
            >
              <img src={`data:image/png;base64,${h.imageB64}`} alt={h.prompt} />
              <span className="tag">{h.mode === "edit" ? "✎" : "✨"}</span>
              {isCompare && <span className="tag" style={{ right: 4, left: "auto", background: "var(--pink)" }}>B</span>}
              <button
                className="del"
                onClick={(e) => { e.stopPropagation(); deleteHistoryItem(h.id); }}
                title="删除"
              >×</button>
            </div>
          );
        })}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.h)} onClose={() => setMenu(null)} />}
      {rawPath && <RawResponseModal path={rawPath} onClose={() => setRawPath(null)} />}
    </div>
  );
}
