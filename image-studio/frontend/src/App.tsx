import { lazy, Suspense, useEffect, useState } from "react";
import { AppHeader } from "./components/layout/AppHeader";
import { WorkspaceBar } from "./components/layout/WorkspaceBar";
import { FooterBar } from "./components/layout/FooterBar";
import { ControlPanel } from "./components/panel/ControlPanel";
import { CanvasStage } from "./components/canvas/CanvasStage";
import { Toolbar } from "./components/canvas/Toolbar";
import { SourceStrip } from "./components/canvas/SourceStrip";
import { StatusBar } from "./components/canvas/StatusBar";
import { HistoryRail } from "./components/history/HistoryRail";
import { ToastContainer } from "./components/common/ToastContainer";
import { useStudioStore } from "./state/studioStore";
import { isMac, isWindows } from "./lib/platform";

const UpstreamConfigModal = lazy(() => import("./components/panel/UpstreamConfigModal").then((m) => ({ default: m.UpstreamConfigModal })));
const ResultDetailDrawer = lazy(() => import("./components/panel/ResultDetailDrawer").then((m) => ({ default: m.ResultDetailDrawer })));

function App() {
  const bootstrap = useStudioStore((s) => s.bootstrap);
  const importImageFile = useStudioStore((s) => s.importImageFile);
  const fullscreen = useStudioStore((s) => s.fullscreen);
  useEffect(() => { bootstrap(); }, [bootstrap]);

  // Global app-level shortcuts. Canvas-scoped shortcuts (undo/redo, tool
  // switching, Esc) stay in CanvasStage so they don't fire when no image is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      const target = e.target as HTMLElement | null;
      const inField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const k = e.key.toLowerCase();
      const st = useStudioStore.getState();

      // Primary-modifier + Enter: submit. Works inside the prompt textarea too.
      if (k === "enter") {
        e.preventDefault();
        if (!st.isRunning) st.submit();
        return;
      }
      // The rest only fire when NOT typing in a field.
      if (inField) return;
      if (k === "n") {
        e.preventDefault();
        st.newWorkspace();
      } else if (k === "w") {
        e.preventDefault();
        if (st.workspaces.length > 1) st.closeWorkspace(st.activeWorkspaceId);
      } else if (isMac && e.ctrlKey && e.metaKey && k === "f") {
        e.preventDefault();
        st.setField("fullscreen", !st.fullscreen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drop / paste → import to canvas.
  const [dragHover, setDragHover] = useState(false);
  useEffect(() => {
    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      depth++;
      setDragHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragHover(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragHover(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) importImageFile(file);
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return; // let the user paste text into form fields normally
      }
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            importImageFile(file);
            return;
          }
        }
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [importImageFile]);

  return (
    <div className="app-root relative">
      {/* Ambient background blobs — 模糊圆球点缀,主界面之下永远不挡 */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden -z-10">
        {isWindows ? (
          <>
            <div className="absolute inset-x-0 top-0 h-[220px] bg-linear-to-b from-white/18 to-transparent dark:from-white/5" />
            <div className="absolute left-[12%] top-[10%] h-[320px] w-[320px] rounded-[28px] bg-sky-500/[0.035] blur-3xl" />
            <div className="absolute right-[6%] top-[18%] h-[260px] w-[420px] rounded-[36px] bg-cyan-400/[0.03] blur-3xl" />
          </>
        ) : (
          <>
            <div className="absolute left-[18%] top-[-8%] h-[460px] w-[460px] rounded-full bg-sky-500/[0.05] blur-3xl" />
            <div className="absolute right-[-8%] top-[55%] h-[400px] w-[400px] rounded-full bg-cyan-400/[0.035] blur-3xl" />
          </>
        )}
      </div>

      <AppHeader />
      <WorkspaceBar />
      <div className={`studio ${fullscreen ? "fullscreen" : ""}`}>
        <ControlPanel />
        <div className="canvas-shell">
          <Toolbar />
          <SourceStrip />
          <CanvasStage />
          <StatusBar />
        </div>
        <HistoryRail />
        <ToastContainer />
        {dragHover && (
          <div className="drop-overlay">
            <div className="drop-message">
              <div style={{ fontSize: 48, marginBottom: 12 }}>📥</div>
              松开鼠标导入图片到画板
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 8 }}>支持 PNG / JPG / WebP,最大 50MB</div>
            </div>
          </div>
        )}
      </div>
      <FooterBar />
      <UpstreamConfigGate />
      <Suspense fallback={null}>
        <ResultDetailDrawer />
      </Suspense>
    </div>
  );
}

// Render the upstream-config modal driven by store state.
// Split out so the read of `upstreamModalOpen` only re-renders this subtree,
// not the whole App.
function UpstreamConfigGate() {
  const open = useStudioStore((s) => s.upstreamModalOpen);
  const close = useStudioStore((s) => s.closeUpstreamConfig);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <UpstreamConfigModal open={open} onClose={close} />
    </Suspense>
  );
}

export default App;
