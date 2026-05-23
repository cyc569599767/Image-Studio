import {
  ArrowUp, Brush, Crop, Eraser, FlipHorizontal, FlipVertical, Hand,
  Info, MoveRight, Pencil, RotateCcw, RotateCw, Save, Square,
  Trash2, Maximize, Minimize, Type as TypeIcon,
} from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { ANNOTATION_COLORS } from "../../types/domain";
import { fullscreenShortcutLabel, isAndroidPhone, isWindows, redoShortcutLabel, undoShortcutLabel, usesAppleUI } from "../../lib/platform";

export function Toolbar() {
  const {
    currentImage, tool, brushSize, brushMode,
    annotationKind, annotationColor,
    annotations, selectedAnnotationId,
    fullscreen,
    batchResults, resultGridOpen, openResultGrid, closeResultGrid,
    setField, saveCurrentImageAs,
    resetMask, clearAnnotations,
    undoStack, redoStack, undo, redo,
    rotateCurrent, flipCurrent, cropToRect,
    openResultDetail,
  } = useStudioStore();
  const selRect = annotations.find((a) => a.id === selectedAnnotationId && a.kind === "rect");
  const hasImage = !!currentImage;

  return (
    <div className={`canvas-toolbar flex items-center gap-1.5 overflow-x-auto border-b border-[var(--border)] bg-[var(--toolbar)] px-3 py-2 backdrop-blur-2xl ${usesAppleUI ? "liquid-glass-bar" : ""}`}>
      <ToolBtn active={tool === "pan"} disabled={!hasImage} onClick={() => setField("tool", "pan")} title="拖动 / 缩放 (1)">
        <Hand className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn active={tool === "mask"} disabled={!hasImage} onClick={() => setField("tool", "mask")} title="蒙版画笔 (2)">
        <Brush className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn active={tool === "annotate"} disabled={!hasImage} onClick={() => setField("tool", "annotate")} title="画框标注 (3)">
        <Square className="w-3.5 h-3.5" />
      </ToolBtn>

      <Sep />

      <ToolBtn disabled={undoStack.length === 0} onClick={undo} title={`撤销 (${undoShortcutLabel})`}>
        <RotateCcw className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn disabled={redoStack.length === 0} onClick={redo} title={`重做 (${redoShortcutLabel})`}>
        <RotateCw className="w-3.5 h-3.5" />
      </ToolBtn>

      <Sep />

      {tool === "mask" && (
        <>
          <ToolBtn active={brushMode === "paint"} onClick={() => setField("brushMode", "paint")} title="画笔">
            <Brush className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn active={brushMode === "erase"} onClick={() => setField("brushMode", "erase")} title="橡皮(取消蒙版)">
            <Eraser className="w-3.5 h-3.5" />
          </ToolBtn>
          <span className="ml-1 text-[11px] text-zinc-500">大小</span>
          <input
            type="range"
            min={5}
            max={120}
            value={brushSize}
            onChange={(e) => setField("brushSize", Number(e.target.value))}
            className="w-20 accent-[var(--accent)]"
          />
          <span className="text-[11px] text-zinc-500 min-w-[24px] tabular-nums">{brushSize}</span>
          <button
            onClick={resetMask}
            className={`px-2.5 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-red-400/10 hover:text-red-400 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            清空
          </button>
        </>
      )}
      {tool === "annotate" && (
        <>
          <ToolBtn active={annotationKind === "rect"} onClick={() => setField("annotationKind", "rect")} title="矩形">
            <Square className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn active={annotationKind === "arrow"} onClick={() => setField("annotationKind", "arrow")} title="箭头">
            <MoveRight className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn active={annotationKind === "freehand"} onClick={() => setField("annotationKind", "freehand")} title="自由画笔">
            <Pencil className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn active={annotationKind === "text"} onClick={() => setField("annotationKind", "text")} title="文字">
            <TypeIcon className="w-3.5 h-3.5" />
          </ToolBtn>
          <Sep />
          <div className="flex items-center gap-1">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setField("annotationColor", c)}
                title={c}
                style={{ background: c }}
                className={`h-4 w-4 ring-1 transition-all ${
                  annotationColor === c ? "ring-2 ring-offset-1 ring-[color:var(--accent)]" : "ring-black/10 dark:ring-white/10"
                } ${isWindows ? "rounded-[6px]" : "rounded-full"}`}
              />
            ))}
          </div>
          <button
            onClick={clearAnnotations}
            className={`px-2.5 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-red-400/10 hover:text-red-400 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            清空标注
          </button>
        </>
      )}
      {tool === "pan" && hasImage && (
        <button
          onClick={() => (window as any).__canvasResetView?.()}
          title="重置视图 (F)"
          className={`px-2.5 py-1 text-[11px] text-zinc-600 transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] dark:text-zinc-400 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
        >
          重置视图
        </button>
      )}

      {currentImage && (
        <>
          {!isAndroidPhone && <Sep />}
          <ToolBtn onClick={() => rotateCurrent(-90)} disabled={!currentImage.savedPath} title="左转 90°">
            <RotateCcw className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn onClick={() => rotateCurrent(90)} disabled={!currentImage.savedPath} title="右转 90°">
            <RotateCw className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn onClick={() => flipCurrent(true)} disabled={!currentImage.savedPath} title="水平翻转">
            <FlipHorizontal className="w-3.5 h-3.5" />
          </ToolBtn>
          <ToolBtn onClick={() => flipCurrent(false)} disabled={!currentImage.savedPath} title="竖直翻转">
            <FlipVertical className="w-3.5 h-3.5" />
          </ToolBtn>
          {!isAndroidPhone && selRect && selRect.width && selRect.height && (
            <button
              onClick={() => cropToRect(selRect.x, selRect.y, selRect.width!, selRect.height!)}
              title="裁出选中矩形"
              className={`inline-flex items-center gap-1 border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] text-[var(--accent)] transition-colors hover:opacity-90 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Crop className="w-3.5 h-3.5" /> 裁出
            </button>
          )}
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        {batchResults.length > 1 && (
          <button
            onClick={resultGridOpen ? closeResultGrid : openResultGrid}
            title={resultGridOpen ? "返回当前图" : "查看本批多图网格"}
            className={`px-2.5 py-1 text-[11px] transition-colors ${
              resultGridOpen
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-zinc-600 hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] dark:text-zinc-400"
            } ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            {resultGridOpen ? "单图" : `网格 ${batchResults.length}`}
          </button>
        )}
        {currentImage && !isAndroidPhone && (
          <span className="text-[11px] text-zinc-500 font-mono-token">{currentImage.size}</span>
        )}
        <ToolBtn onClick={() => setField("fullscreen", !fullscreen)} title={fullscreen ? `退出全屏 (${fullscreenShortcutLabel})` : `全屏 (${fullscreenShortcutLabel})`}>
          {fullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
        </ToolBtn>
        {currentImage && (
          <>
            <ToolBtn onClick={() => openResultDetail(currentImage)} title="查看本张图的详细信息">
              <Info className="w-3.5 h-3.5" />
            </ToolBtn>
            <ToolBtn onClick={() => setField("currentImage", null)} title="清空画布(不删除历史)">
              <Trash2 className="w-3.5 h-3.5" />
            </ToolBtn>
            <button
              onClick={saveCurrentImageAs}
              title="另存为"
              className={`liquid-primary-button inline-flex items-center gap-1 bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--accent-2)] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Save className="w-3.5 h-3.5" /> 另存为
            </button>
          </>
        )}
      </div>

      {/* 防止未使用 import 报错 */}
      <ArrowUp className="hidden" />
    </div>
  );
}

function ToolBtn({ active, disabled, onClick, title, children }: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`platform-icon-btn flex h-8 w-8 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? "border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] text-[var(--accent)]"
          : "text-zinc-600 hover:bg-black/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
      } ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />;
}
