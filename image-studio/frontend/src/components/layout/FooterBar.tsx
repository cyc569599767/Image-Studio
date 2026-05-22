import { Folder, Github, MessageSquare } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { OpenExternalURL, OpenOutputDir } from "../../../wailsjs/go/backend/Service";

const REPO_URL = "https://github.com/RoseKhlifa/Image-Studio";
const ISSUES_URL = "https://github.com/RoseKhlifa/Image-Studio/issues";
const VERSION = "0.1.4";

export function FooterBar() {
  const { fullscreen, history, runningJobs, isRunning, pushToast } = useStudioStore();
  if (fullscreen) return null;

  // 今日已生图 = 本地日历当天 00:00 起的条目数,不是「最近 24h」滚动窗口。
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = history.filter((h) => h.createdAt >= todayStart.getTime()).length;

  function open(url: string) {
    OpenExternalURL(url).catch(() => pushToast("无法打开浏览器", "error"));
  }

  return (
    <footer className="flex min-h-10 items-center justify-between border-t border-black/[0.06] bg-[var(--toolbar)] px-4 text-[11px] text-zinc-500 backdrop-blur-2xl dark:border-white/[0.06] dark:text-zinc-400">
      <div className="flex items-center gap-1">
        <FooterBtn onClick={() => OpenOutputDir().catch(() => undefined)}>
          <Folder className="h-3 w-3" /> 输出目录
        </FooterBtn>
        <FooterBtn onClick={() => open(REPO_URL)}>
          <Github className="h-3 w-3" /> GitHub
        </FooterBtn>
        <FooterBtn onClick={() => open(ISSUES_URL)}>
          <MessageSquare className="h-3 w-3" /> 反馈
        </FooterBtn>
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-baseline gap-1">
          <span className="opacity-70">今日已生图:</span>
          <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">{todayCount}</span>
        </span>
        <span className="opacity-40">·</span>
        <span className="flex items-baseline gap-1">
          <span className="opacity-70">总生图:</span>
          <span className="font-medium text-zinc-700 dark:text-zinc-300 tabular-nums">{history.length}</span>
        </span>
        {isRunning && (
          <>
            <span className="opacity-40">·</span>
            <span className="flex items-baseline gap-1">
            <span className="opacity-70">并发</span>
              <span className="font-medium text-[var(--accent)] tabular-nums">{runningJobs.length}</span>
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span>{isRunning ? "运行中" : "就绪"}</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isRunning
              ? "bg-[var(--accent)] shadow-[0_0_6px_rgb(0_122_255_/_0.6)] animate-pulse"
              : "bg-zinc-400 dark:bg-zinc-600"
          }`}
        />
        <span className="font-mono-token text-zinc-400 dark:text-zinc-600">v{VERSION}</span>
      </div>
    </footer>
  );
}

function FooterBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
    >
      {children}
    </button>
  );
}
