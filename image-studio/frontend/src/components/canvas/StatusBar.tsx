import { CheckCircle2, Loader2 } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function StatusBar() {
  const { isRunning, progress, currentImage, lastLogLine, viewZoom, recentDurations, jobsTotal, jobsCompleted, runningJobs } = useStudioStore();
  const zoomLabel = currentImage ? `${Math.round(viewZoom * 100)}%` : "";
  const avg = recentDurations.length > 0
    ? recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length
    : 0;
  const eta = isRunning && progress && avg > 0
    ? Math.max(0, Math.round(avg - progress.elapsed))
    : null;

  if (isRunning) {
    return (
      <div className="relative flex items-center gap-3 overflow-hidden border-t border-black/[0.06] bg-[var(--toolbar)] px-3 py-2 text-[11px] text-zinc-700 backdrop-blur-2xl dark:border-white/[0.06] dark:text-zinc-300">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--accent)]" />
        <span className="font-medium">
          {progress ? `${progress.stage} · ${progress.elapsed}s · ${fmtBytes(progress.bytes)}` : "正在请求..."}
        </span>
        {jobsTotal > 1 && (
          <span className="font-medium text-[var(--accent)]">
            并发 {runningJobs.length} · {jobsCompleted}/{jobsTotal}
          </span>
        )}
        {eta !== null && <span className="text-zinc-500">≈ 剩余 {eta}s</span>}
        <div className="absolute bottom-0 left-0 right-0 h-px animate-pulse bg-[color:var(--accent)]/35" />
        <span className="text-zinc-500 truncate max-w-[30%] ml-auto" title={lastLogLine}>
          {lastLogLine}
        </span>
      </div>
    );
  }
  if (currentImage) {
    const created = new Date(currentImage.createdAt).toLocaleTimeString();
    const metaParts: string[] = [];
    metaParts.push(currentImage.mode === "edit" ? "编辑" : "生成");
    metaParts.push(currentImage.size);
    metaParts.push(currentImage.quality);
    if (currentImage.elapsedSec) metaParts.push(`${currentImage.elapsedSec}s`);
    if (currentImage.seed) metaParts.push(`seed ${currentImage.seed}`);
    if (currentImage.styleTag) metaParts.push(`#${currentImage.styleTag}`);
    return (
      <div className="flex items-center gap-3 overflow-hidden border-t border-black/[0.06] bg-[var(--toolbar)] px-3 py-2 text-[11px] text-zinc-600 backdrop-blur-2xl dark:border-white/[0.06] dark:text-zinc-400">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[var(--accent)]">
          <CheckCircle2 className="w-3 h-3" /> <span className="font-medium">{metaParts.join(" · ")}</span>
        </span>
        <span className="text-zinc-500 font-mono-token">{created}</span>
        {currentImage.revisedPrompt && (
          <span className="text-zinc-500 truncate flex-1 italic" title={currentImage.revisedPrompt}>
            ✨ {currentImage.revisedPrompt}
          </span>
        )}
        <span className="text-zinc-500 font-mono-token ml-auto shrink-0">{zoomLabel}</span>
      </div>
    );
  }
  return (
    <div className="border-t border-black/[0.06] bg-[var(--toolbar)] px-3 py-2 text-[11px] text-zinc-500 backdrop-blur-2xl dark:border-white/[0.06]">
      准备就绪
    </div>
  );
}
