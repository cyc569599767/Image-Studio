import { useStudioStore } from "../../state/studioStore";
import { ANNOTATION_COLORS } from "../../types/domain";

export function Toolbar() {
  const {
    currentImage, tool, brushSize, brushMode,
    annotationKind, annotationColor,
    annotations, selectedAnnotationId,
    fullscreen,
    setField, saveCurrentImageAs,
    resetMask, clearAnnotations,
    undoStack, redoStack, undo, redo,
    rotateCurrent, flipCurrent, cropToRect,
    openResultDetail,
  } = useStudioStore();
  const selRect = annotations.find((a) => a.id === selectedAnnotationId && a.kind === "rect");

  const hasImage = !!currentImage;

  return (
    <div className="toolbar">
      <button
        className={`tool-btn ${tool === "pan" ? "active" : ""}`}
        onClick={() => setField("tool", "pan")}
        disabled={!hasImage}
        title="拖动 / 缩放 (1,按住空格临时切换)"
      >
        ✋ 拖动
      </button>
      <button
        className={`tool-btn ${tool === "mask" ? "active" : ""}`}
        onClick={() => setField("tool", "mask")}
        disabled={!hasImage}
        title="蒙版画笔 (2)"
      >
        🖌 蒙版
      </button>
      <button
        className={`tool-btn ${tool === "annotate" ? "active" : ""}`}
        onClick={() => setField("tool", "annotate")}
        disabled={!hasImage}
        title="画框标注 (3)"
      >
        ▭ 标注
      </button>

      <div className="sep" />

      <button
        className="tool-btn"
        onClick={undo}
        disabled={undoStack.length === 0}
        title="撤销 (Ctrl+Z)"
      >
        ↶
      </button>
      <button
        className="tool-btn"
        onClick={redo}
        disabled={redoStack.length === 0}
        title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
      >
        ↷
      </button>

      <div className="sep" />

      {tool === "mask" && (
        <>
          <button
            className={`tool-btn ${brushMode === "paint" ? "active" : ""}`}
            onClick={() => setField("brushMode", "paint")}
            title="画笔(标记要修改的区域)"
          >🖌</button>
          <button
            className={`tool-btn ${brushMode === "erase" ? "active" : ""}`}
            onClick={() => setField("brushMode", "erase")}
            title="橡皮(取消蒙版)"
          >🩹</button>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>大小</span>
          <input
            type="range"
            min={5}
            max={120}
            value={brushSize}
            onChange={(e) => setField("brushSize", Number(e.target.value))}
          />
          <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 24 }}>{brushSize}</span>
          <button className="tool-btn" onClick={resetMask}>清空</button>
        </>
      )}
      {tool === "annotate" && (
        <>
          <button
            className={`tool-btn ${annotationKind === "rect" ? "active" : ""}`}
            onClick={() => setField("annotationKind", "rect")}
            title="矩形框"
          >▭</button>
          <button
            className={`tool-btn ${annotationKind === "arrow" ? "active" : ""}`}
            onClick={() => setField("annotationKind", "arrow")}
            title="箭头"
          >➤</button>
          <button
            className={`tool-btn ${annotationKind === "freehand" ? "active" : ""}`}
            onClick={() => setField("annotationKind", "freehand")}
            title="自由画笔"
          >✎</button>
          <button
            className={`tool-btn ${annotationKind === "text" ? "active" : ""}`}
            onClick={() => setField("annotationKind", "text")}
            title="文字"
          >T</button>
          <div className="sep" />
          <div className="color-row">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c}
                className={`color-chip ${annotationColor === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => setField("annotationColor", c)}
                title={c}
              />
            ))}
          </div>
          <button className="tool-btn" onClick={clearAnnotations}>清空标注</button>
        </>
      )}
      {tool === "pan" && hasImage && (
        <button
          className="tool-btn"
          onClick={() => (window as any).__canvasResetView?.()}
          title="重置视图 (F)"
        >
          重置视图
        </button>
      )}

      {currentImage && (
        <>
          <div className="sep" />
          <button className="tool-btn" onClick={() => rotateCurrent(-90)} title="左转 90°" disabled={!currentImage.savedPath}>↶</button>
          <button className="tool-btn" onClick={() => rotateCurrent(90)} title="右转 90°" disabled={!currentImage.savedPath}>↷</button>
          <button className="tool-btn" onClick={() => flipCurrent(true)} title="水平翻转" disabled={!currentImage.savedPath}>⇋</button>
          <button className="tool-btn" onClick={() => flipCurrent(false)} title="竖直翻转" disabled={!currentImage.savedPath}>⇵</button>
          {selRect && selRect.width && selRect.height && (
            <button
              className="tool-btn active"
              onClick={() => cropToRect(selRect.x, selRect.y, selRect.width!, selRect.height!)}
              title="裁出选中矩形"
            >
              ✂ 裁出
            </button>
          )}
        </>
      )}

      <div className="right">
        {currentImage && <span>{currentImage.size}</span>}
        <button
          className="tool-btn"
          onClick={() => setField("fullscreen", !fullscreen)}
          title={fullscreen ? "退出全屏 (F11)" : "全屏模式 (F11)"}
        >
          {fullscreen ? "⤬" : "⛶"}
        </button>
        {currentImage && (
          <>
            <button
              className="tool-btn"
              onClick={() => openResultDetail(currentImage)}
              title="查看本张图的详细信息(参数 / prompt / 修订 / 文件路径)"
            >
              ℹ 详情
            </button>
            <button
              className="tool-btn"
              onClick={() => setField("currentImage", null)}
              title="清空画布(不删除历史记录)"
            >
              🗑 清空
            </button>
            <button className="tool-btn active" onClick={saveCurrentImageAs}>
              💾 另存为
            </button>
          </>
        )}
      </div>
    </div>
  );
}
