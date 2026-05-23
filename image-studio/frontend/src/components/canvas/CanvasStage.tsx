import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line, Rect, Arrow, Text, Group } from "react-konva";
import Konva from "konva";
import { useStudioStore } from "../../state/studioStore";
import { Annotation } from "../../types/domain";
import { isMac } from "../../lib/platform";
import { blobToObjectURL, useBlobURL } from "../../lib/images";

async function copyImageToClipboard(b64: string): Promise<boolean> {
  try {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

// Convert a Blob/base64 PNG to an HTMLImageElement (lazy).
// Clears the previous image synchronously when b64 changes so the rest of the
// component never renders with a stale-image / new-view mismatch.
function useImageFromSource(blob: Blob | null | undefined, b64: string | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!blob && !b64) { setImg(null); return; }
    setImg(null); // drop the stale element immediately
    const el = new Image();
    const objectURL = blob ? URL.createObjectURL(blob) : b64 ? b64ToObjectURL(b64) : null;
    if (!objectURL) return;
    el.onload = () => setImg(el);
    el.onerror = () => setImg(null);
    el.src = objectURL;
    return () => {
      el.onload = null;
      el.onerror = null;
      URL.revokeObjectURL(objectURL);
    };
  }, [b64]);
  return img;
}

function b64ToObjectURL(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    return null;
  }
}

import type { Stroke } from "../../state/studioStore";
import { EmptyState } from "./EmptyState";

export function CanvasStage() {
  const {
    currentImage, tool, brushSize, brushMode,
    annotationKind, annotationColor,
    selectedAnnotationId,
    annotations, addAnnotation, removeAnnotation, clearAnnotations,
    setMaskDataURL,
    strokes, pushStroke,
    undoStack, redoStack, undo, redo,
    compareB, compareSplit, setCompareSplit, setCompareB,
    isRunning, cancel, errorMessage, setField,
    canvasViewResetTick,
  } = useStudioStore();

  // Hold-space-for-pan: while space is held, override tool to "pan".
  const [spacePan, setSpacePan] = useState(false);
  const effectiveTool = spacePan ? "pan" : tool;

  const stageRef = useRef<Konva.Stage | null>(null);
  const imageLayerRef = useRef<Konva.Layer | null>(null);
  const maskLayerRef = useRef<Konva.Layer | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  const image = useImageFromSource(currentImage?.imageBlob ?? null, currentImage?.imageB64);

  // ★ Measure the OUTER wrapper (.stage-host) — which is a normal grid item
  // bounded by its parent shell — instead of the inner absolute container.
  // This breaks the feedback loop where the Konva canvas width (= hostSize.w)
  // would otherwise expand its parent in normal flow and push hostSize → ∞.
  const [hostSize, setHostSize] = useState({ w: 0, h: 0 });
  const hostRef = useCallback((node: HTMLDivElement | null) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    if (!node) return;
    const update = () => {
      const w = node.clientWidth;
      const h = node.clientHeight;
      if (w > 0 && h > 0) setHostSize({ w, h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    roRef.current = ro;
  }, []);

  // Plain function — not useMemo — so it is always computed with the very
  // latest hostSize / image references on every render. Avoids the closure
  // race we saw with useMemo deps.
  function computeFit(img: HTMLImageElement | null, hw: number, hh: number) {
    if (!img || hw === 0 || hh === 0) return { scale: 1, x: 0, y: 0, w: 0, h: 0 };
    const pad = 40;
    const sw = (hw - pad * 2) / img.width;
    const sh = (hh - pad * 2) / img.height;
    const scale = Math.min(sw, sh, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    return { scale, x: (hw - w) / 2, y: (hh - h) / 2, w, h };
  }
  const fit = computeFit(image, hostSize.w, hostSize.h);

  // `userView` only holds explicit user manipulation (pan / wheel zoom).
  // The effective view is `userView ?? fit`, so the displayed image is always
  // centered by default. userView is reset whenever currentImage.id changes.
  const [userView, setUserView] = useState<{ scale: number; x: number; y: number } | null>(null);
  const view = userView ?? { scale: fit.scale, x: fit.x, y: fit.y };

  // Imperatively push the latest fit onto the Konva Stage *after* React commits
  // and *before* paint. This is the belt-and-suspenders fix: even if React
  // props somehow lag a frame behind, this guarantees the visible stage is at
  // the right position whenever image / hostSize / userView changes.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.x(view.x);
    stage.y(view.y);
    stage.scaleX(view.scale);
    stage.scaleY(view.scale);
    stage.batchDraw();
    setField("viewZoom", view.scale);
  }, [view.x, view.y, view.scale, image, hostSize.w, hostSize.h]);

  // Double-click on the stage: cycle between fit and 100%.
  function onStageDblClick() {
    if (!image || hostSize.w === 0) return;
    if (!userView || Math.abs(userView.scale - 1) > 0.001) {
      // Currently fit (or not at 100%) → snap to 100% centred on image.
      const cx = (hostSize.w - image.width) / 2;
      const cy = (hostSize.h - image.height) / 2;
      setUserView({ scale: 1, x: cx, y: cy });
    } else {
      setUserView(null); // back to fit
    }
  }

  // Local "in-flight" stroke buffer — only the completed strokes live in the
  // store (so we don't spam zustand on every mousemove). Forces re-render via
  // a tick counter when the in-progress stroke needs to redraw.
  const drawingRef = useRef<{ active: boolean; current: Stroke | null }>({ active: false, current: null });
  const [, setDrawingTick] = useState(0);

  // Annotation drag state.
  const [drag, setDrag] = useState<null | { kind: "rect" | "arrow" | "freehand" | "text"; sx: number; sy: number; x: number; y: number }>(null);

  // When the displayed image identity changes, clear the user's manual view
  // and per-image canvas state. This guarantees the new image starts at fit.
  // canvasViewResetTick 触发同样的重置 —— 用于 旋转 / 翻转 / 裁剪 这些「就地编辑」
  // 操作:currentImage.id 没变(就是原来那张),但底图尺寸 / 坐标已变,残留的 pan/zoom
  // 与蒙版坐标系都失效了。
  useEffect(() => {
    setUserView(null);
    setMaskDataURL(null);
    drawingRef.current = { active: false, current: null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImage?.id, canvasViewResetTick]);

  // setView is the only writer of userView. Treat any explicit pan/zoom as a
  // user override; auto-recenter happens by resetting to null elsewhere.
  function setView(v: { scale: number; x: number; y: number }) {
    setUserView(v);
  }

  // Mouse wheel zoom around cursor.
  function onWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const oldScale = view.scale;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const mousePointTo = {
      x: (pointer.x - view.x) / oldScale,
      y: (pointer.y - view.y) / oldScale,
    };
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const factor = 1.15;
    const newScale = Math.max(0.05, Math.min(8, direction > 0 ? oldScale * factor : oldScale / factor));
    setView({
      scale: newScale,
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
  }

  function stagePointerToImageCoord(): { x: number; y: number } | null {
    const stage = stageRef.current;
    if (!stage || !image) return null;
    const p = stage.getPointerPosition();
    if (!p) return null;
    return {
      x: (p.x - view.x) / view.scale,
      y: (p.y - view.y) / view.scale,
    };
  }

  // In-progress freehand annotation buffer (kept in ref to keep mousemove cheap).
  const freehandRef = useRef<number[] | null>(null);

  function onMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (!image) return;
    const local = stagePointerToImageCoord();
    if (!local) return;
    if (effectiveTool === "mask") {
      drawingRef.current = { active: true, current: { points: [local.x, local.y], size: brushSize, erase: brushMode === "erase" } };
    } else if (effectiveTool === "annotate") {
      // Click on empty area while in annotate mode clears any selection.
      // Click on an annotation shape is handled by the shape's own onClick.
      const target = e.target;
      if (target === stageRef.current || target.getClassName?.() === "Image") {
        setField("selectedAnnotationId", null);
      }
      if (annotationKind === "freehand") {
        freehandRef.current = [local.x, local.y];
        setDrawingTick((n) => n + 1);
      } else if (annotationKind === "text") {
        // Text annotations are created via a prompt on mouse down (no drag).
        const text = window.prompt("文字标注内容:");
        if (text && text.trim()) {
          addAnnotation({
            id: crypto.randomUUID(),
            kind: "text",
            x: local.x,
            y: local.y,
            text: text.trim(),
            color: annotationColor,
          });
        }
      } else {
        setDrag({ kind: annotationKind, sx: local.x, sy: local.y, x: local.x, y: local.y });
      }
    }
  }

  function onMouseMove() {
    if (!image) return;
    const local = stagePointerToImageCoord();
    if (!local) return;
    if (effectiveTool === "mask" && drawingRef.current.active && drawingRef.current.current) {
      drawingRef.current.current.points.push(local.x, local.y);
      setDrawingTick((n) => n + 1);
    } else if (effectiveTool === "annotate" && annotationKind === "freehand" && freehandRef.current) {
      freehandRef.current.push(local.x, local.y);
      setDrawingTick((n) => n + 1);
    } else if (effectiveTool === "annotate" && drag) {
      setDrag({ ...drag, x: local.x, y: local.y });
    }
  }

  function onMouseUp() {
    if (effectiveTool === "mask" && drawingRef.current.active && drawingRef.current.current) {
      const finished = drawingRef.current.current;
      drawingRef.current = { active: false, current: null };
      pushStroke(finished);
    } else if (effectiveTool === "annotate" && annotationKind === "freehand" && freehandRef.current) {
      const pts = freehandRef.current;
      freehandRef.current = null;
      if (pts.length >= 4) {
        addAnnotation({
          id: crypto.randomUUID(),
          kind: "freehand",
          x: 0,
          y: 0,
          color: annotationColor,
          points: pts,
        });
      }
    } else if (effectiveTool === "annotate" && drag) {
      const w = drag.x - drag.sx;
      const h = drag.y - drag.sy;
      if (Math.abs(w) > 3 && Math.abs(h) > 3) {
        if (drag.kind === "rect") {
          addAnnotation({
            id: crypto.randomUUID(),
            kind: "rect",
            x: Math.min(drag.sx, drag.x),
            y: Math.min(drag.sy, drag.y),
            width: Math.abs(w),
            height: Math.abs(h),
            color: annotationColor,
          });
        } else if (drag.kind === "arrow") {
          addAnnotation({
            id: crypto.randomUUID(),
            kind: "arrow",
            x: drag.sx,
            y: drag.sy,
            width: drag.x - drag.sx,
            height: drag.y - drag.sy,
            color: annotationColor,
          });
        }
      }
      setDrag(null);
    }
  }

  // Keep the store flag in sync so submit can cheaply know whether any mask
  // exists, but defer the expensive PNG export until the user actually submits.
  useEffect(() => {
    if (!image || strokes.length === 0) {
      setMaskDataURL(null);
      return;
    }
    const hasWhite = strokes.some((s) => !s.erase);
    setMaskDataURL(hasWhite ? "__PENDING_MASK__" : null);
  }, [strokes, image, setMaskDataURL]);

  function resetView() {
    setUserView(null);
  }

  // Expose helpers via window for the toolbar reset buttons.
  useEffect(() => {
    (window as any).__canvasResetView = resetView;
    return () => {
      delete (window as any).__canvasResetView;
    };
  }, [fit.scale, fit.x, fit.y]);

  // Keyboard shortcuts. Skipped when the user is typing in an input/textarea.
  useEffect(() => {
    const isTypingInField = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingInField(e)) return;
      const meta = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      // Primary-modifier shortcuts
      if (meta && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (meta && ((k === "z" && e.shiftKey) || k === "y")) { e.preventDefault(); redo(); return; }

      // Space → temporary pan (don't react to autorepeat).
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpacePan(true);
        return;
      }

      // Esc → cancel running job → exit compare → clear selection → dismiss error
      if (k === "escape") {
        if (isRunning) cancel();
        else if (compareB) setCompareB(null);
        else if (selectedAnnotationId) setField("selectedAnnotationId", null);
        else if (errorMessage) setField("errorMessage", null);
        return;
      }

      // Delete / Backspace → remove selected annotation
      if ((k === "delete" || k === "backspace") && selectedAnnotationId) {
        e.preventDefault();
        removeAnnotation(selectedAnnotationId);
        return;
      }

      // F11 on non-macOS, or Control+Command+F on macOS → toggle fullscreen.
      if ((!isMac && k === "f11") || (isMac && e.ctrlKey && e.metaKey && k === "f")) {
        e.preventDefault();
        const { fullscreen } = useStudioStore.getState();
        setField("fullscreen", !fullscreen);
        return;
      }

      // Ctrl+C → copy current image to clipboard
      if (meta && k === "c" && currentImage) {
        e.preventDefault();
        copyImageToClipboard(currentImage.imageB64).then((ok) => {
          const t = useStudioStore.getState().pushToast;
          if (ok) t("已复制图片到剪贴板", "success");
          else t("复制失败,当前运行环境拒绝写剪贴板", "error");
        });
        return;
      }

      // F → fit to screen
      if (k === "f") { e.preventDefault(); setUserView(null); return; }

      // 1/2/3 → tool switch
      if (currentImage) {
        if (k === "1") { e.preventDefault(); setField("tool", "pan"); return; }
        if (k === "2") { e.preventDefault(); setField("tool", "mask"); return; }
        if (k === "3") { e.preventDefault(); setField("tool", "annotate"); return; }
      }

      // [ / ] → brush size
      if (k === "[" || k === "]") {
        e.preventDefault();
        const delta = k === "[" ? -5 : 5;
        setField("brushSize", Math.max(5, Math.min(120, brushSize + delta)));
        return;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePan(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [undo, redo, isRunning, cancel, compareB, setCompareB, errorMessage, setField, currentImage, brushSize, selectedAnnotationId, removeAnnotation]);

  // Host div is rendered unconditionally so its ref (and the ResizeObserver
  // attached to it) survives the empty-state → has-image transition. Previously
  // the empty branch had its own <div ref={hostRef}>, the host unmounted on
  // first generate, and the observer kept reporting the stale initial size.
  return (
    <div
      ref={hostRef}
      className="stage-host"
      style={{ cursor: !currentImage ? "default" : (effectiveTool === "pan" ? (spacePan ? "grabbing" : "grab") : "crosshair") }}
    >
      {!currentImage && <EmptyState />}
      {currentImage && compareB && (
        <CompareOverlay
          aBlob={currentImage.imageBlob ?? null}
          aB64={currentImage.imageB64}
          bBlob={compareB.imageBlob ?? null}
          bB64={compareB.imageB64}
          split={compareSplit}
          onSplit={setCompareSplit}
        />
      )}
      {currentImage && !compareB && hostSize.w > 0 && hostSize.h > 0 && (
      // The Stage canvas is wrapped in an absolutely positioned container so
      // its (potentially very large) layout footprint cannot push back on the
      // stage-host's grid-derived width. stage-host stays bounded by the grid
      // track; this wrapper takes whatever size stage-host gives it via inset:0.
      <div className="stage-canvas-wrap" style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <Stage
        ref={stageRef}
        width={hostSize.w}
        height={hostSize.h}
        x={view.x}
        y={view.y}
        scaleX={view.scale}
        scaleY={view.scale}
        draggable={effectiveTool === "pan"}
        onDragEnd={(e) => setView({ ...view, x: e.target.x(), y: e.target.y() })}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDblClick={onStageDblClick}
      >
        <Layer ref={imageLayerRef}>
          {image && <KonvaImage image={image} listening={false} />}
        </Layer>

        <Layer ref={maskLayerRef}>
          {strokes.map((s, i) => (
            <Line
              key={i}
              points={s.points}
              stroke={s.erase ? "rgba(226,85,85,0.55)" : "rgba(77,124,255,0.55)"}
              strokeWidth={s.size}
              lineCap="round"
              lineJoin="round"
              tension={0.4}
              dash={s.erase ? [s.size * 0.4, s.size * 0.4] : undefined}
              listening={false}
              globalCompositeOperation={s.erase ? "destination-out" : "source-over"}
            />
          ))}
          {drawingRef.current.current && (
            <Line
              // ★ 必须 .slice() 出新数组引用 —— onMouseMove 原地 push 不会改变
              // points 数组引用,react-konva 走 prop 浅比较会跳过更新,导致
              // 拖拽期间只画起点 / 终点,松手才一次性补全所有中间点。
              points={drawingRef.current.current.points.slice()}
              stroke={drawingRef.current.current.erase ? "rgba(226,85,85,0.55)" : "rgba(77,124,255,0.55)"}
              strokeWidth={drawingRef.current.current.size}
              lineCap="round"
              lineJoin="round"
              tension={0.4}
              dash={drawingRef.current.current.erase ? [drawingRef.current.current.size * 0.4, drawingRef.current.current.size * 0.4] : undefined}
              listening={false}
              globalCompositeOperation={drawingRef.current.current.erase ? "destination-out" : "source-over"}
            />
          )}
        </Layer>

        <Layer>
          {annotations.map((a) => (
            <AnnotationShape
              key={a.id}
              a={a}
              selected={selectedAnnotationId === a.id}
              onSelect={() => setField("selectedAnnotationId", a.id)}
            />
          ))}
          {drag && drag.kind === "rect" && (
            <Rect
              x={Math.min(drag.sx, drag.x)}
              y={Math.min(drag.sy, drag.y)}
              width={Math.abs(drag.x - drag.sx)}
              height={Math.abs(drag.y - drag.sy)}
              stroke={annotationColor}
              strokeWidth={2 / view.scale}
              dash={[6 / view.scale, 4 / view.scale]}
              listening={false}
            />
          )}
          {drag && drag.kind === "arrow" && (
            <Arrow
              points={[drag.sx, drag.sy, drag.x, drag.y]}
              stroke={annotationColor}
              strokeWidth={2 / view.scale}
              fill={annotationColor}
              pointerLength={12 / view.scale}
              pointerWidth={12 / view.scale}
              listening={false}
            />
          )}
          {freehandRef.current && freehandRef.current.length >= 4 && (
            <Line
              // 同上:.slice() 强制每帧新引用,绕过 react-konva 的浅比较跳更新。
              points={freehandRef.current.slice()}
              stroke={annotationColor}
              strokeWidth={3 / view.scale}
              lineCap="round"
              lineJoin="round"
              tension={0.4}
              listening={false}
            />
          )}
        </Layer>
      </Stage>
      </div>
      )}
    </div>
  );
}

function CompareOverlay({
  aBlob, aB64, bBlob, bB64, split, onSplit,
}: {
  aBlob: Blob | null;
  aB64: string;
  bBlob: Blob | null;
  bB64: string;
  split: number;
  onSplit: (v: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!draggingRef.current || !wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      const x = e.clientX - r.left;
      onSplit(x / r.width);
    };
    const up = () => { draggingRef.current = false; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [onSplit]);

  const pct = Math.round(split * 100);
  return (
    <div ref={wrapRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <img
        src={aBlob ? blobToObjectURL(aBlob) : `data:image/png;base64,${aB64}`}
        draggable={false}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "contain", userSelect: "none",
          clipPath: `inset(0 ${100 - pct}% 0 0)`,
        }}
      />
      <img
        src={bBlob ? blobToObjectURL(bBlob) : `data:image/png;base64,${bB64}`}
        draggable={false}
        style={{
          position: "absolute", inset: 0, width: "100%", height: "100%",
          objectFit: "contain", userSelect: "none",
          clipPath: `inset(0 0 0 ${pct}%)`,
        }}
      />
      {/* Split bar handle */}
      <div
        onMouseDown={(e) => { e.preventDefault(); draggingRef.current = true; }}
        style={{
          position: "absolute",
          top: 0, bottom: 0,
          left: `${pct}%`,
          width: 3, marginLeft: -1.5,
          background: "#7e5cff",
          cursor: "ew-resize",
          boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{
          position: "absolute",
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          width: 24, height: 24, borderRadius: "50%",
          background: "#7e5cff",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: "#fff", fontSize: 12,
        }}>⇆</div>
      </div>
      {/* Labels */}
      <div style={{ position: "absolute", top: 8, left: 8, background: "rgba(0,0,0,0.55)", padding: "2px 8px", borderRadius: 4, fontSize: 11, color: "#9ec5ff" }}>A · 当前图</div>
      <div style={{ position: "absolute", top: 8, right: 8, background: "rgba(0,0,0,0.55)", padding: "2px 8px", borderRadius: 4, fontSize: 11, color: "#cdb8ff" }}>B · 对比图</div>
    </div>
  );
}

function AnnotationShape({ a, selected, onSelect }: { a: Annotation; selected: boolean; onSelect: () => void }) {
  const halo = selected ? "#4d7cff" : undefined;
  const onClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    e.cancelBubble = true;
    onSelect();
  };
  if (a.kind === "rect") {
    return (
      <Rect
        x={a.x}
        y={a.y}
        width={a.width ?? 0}
        height={a.height ?? 0}
        stroke={a.color}
        strokeWidth={3}
        shadowColor={halo}
        shadowBlur={selected ? 12 : 0}
        shadowOpacity={selected ? 0.9 : 0}
        onClick={onClick}
      />
    );
  }
  if (a.kind === "arrow") {
    return (
      <Arrow
        points={[a.x, a.y, (a.x + (a.width ?? 0)), (a.y + (a.height ?? 0))]}
        stroke={a.color}
        strokeWidth={3}
        fill={a.color}
        pointerLength={12}
        pointerWidth={12}
        shadowColor={halo}
        shadowBlur={selected ? 12 : 0}
        shadowOpacity={selected ? 0.9 : 0}
        onClick={onClick}
      />
    );
  }
  if (a.kind === "freehand") {
    return (
      <Line
        points={a.points ?? []}
        stroke={a.color}
        strokeWidth={3}
        lineCap="round"
        lineJoin="round"
        tension={0.4}
        shadowColor={halo}
        shadowBlur={selected ? 12 : 0}
        shadowOpacity={selected ? 0.9 : 0}
        hitStrokeWidth={10}
        onClick={onClick}
      />
    );
  }
  // text
  return (
    <Text
      x={a.x}
      y={a.y}
      text={a.text ?? ""}
      fill={a.color}
      fontSize={20}
      shadowColor={halo}
      shadowBlur={selected ? 8 : 0}
      shadowOpacity={selected ? 0.9 : 0}
      onClick={onClick}
    />
  );
}
