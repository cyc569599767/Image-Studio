import { Github, Monitor, Moon, Plus, Sun } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { OpenExternalURL } from "../../../wailsjs/go/backend/Service";
import { HitokotoStrip } from "./HitokotoStrip";
import { isMac } from "../../lib/platform";

const REPO_URL = "https://github.com/RoseKhlifa/Image-Studio";

export function AppHeader() {
  const { fullscreen, theme, setTheme, pushToast, workspaces, newWorkspace } = useStudioStore();
  if (fullscreen) return null;

  return (
    <header
      className={`drag-region sticky top-0 z-40 flex items-center gap-3 border-b border-black/[0.06] bg-[var(--toolbar)] backdrop-blur-2xl dark:border-white/[0.06] ${
        isMac ? "min-h-[58px] pl-[92px] pr-5 pb-2 pt-3" : "min-h-12 px-4"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-100">
          Image Studio
        </div>
        <div className="mt-0.5 flex min-w-0 items-center text-[11px] text-zinc-500 dark:text-zinc-400">
          <HitokotoStrip />
        </div>
      </div>

      <div className="no-drag ml-auto flex items-center gap-1.5">
        <HeaderIconBtn
          onClick={() => newWorkspace()}
          title={workspaces.length > 1 ? `${workspaces.length} 个标签 · 新建` : "新建标签"}
        >
          <Plus className="h-4 w-4" />
          {workspaces.length > 1 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[9px] font-semibold text-white">
              {workspaces.length}
            </span>
          )}
        </HeaderIconBtn>
        <div className="flex items-center rounded-full bg-black/[0.04] p-0.5 ring-1 ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06]">
          <HeaderToggleBtn
            active={theme === "system"}
            onClick={() => setTheme("system")}
            title="跟随系统"
          >
            <Monitor className="h-3.5 w-3.5" />
          </HeaderToggleBtn>
          <HeaderToggleBtn
            active={theme === "light"}
            onClick={() => setTheme("light")}
            title="浅色外观"
          >
            <Sun className="h-3.5 w-3.5" />
          </HeaderToggleBtn>
          <HeaderToggleBtn
            active={theme === "dark"}
            onClick={() => setTheme("dark")}
            title="深色外观"
          >
            <Moon className="h-3.5 w-3.5" />
          </HeaderToggleBtn>
        </div>
        <HeaderIconBtn
          onClick={() => OpenExternalURL(REPO_URL).catch(() => pushToast("无法打开浏览器", "error"))}
          title="GitHub"
        >
          <Github className="h-4 w-4" />
        </HeaderIconBtn>
      </div>
    </header>
  );
}

function HeaderIconBtn({ children, onClick, title }: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="no-drag relative flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

function HeaderToggleBtn({ active, children, onClick, title }: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`no-drag flex h-7 w-7 items-center justify-center rounded-full transition-all ${
        active
          ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}
