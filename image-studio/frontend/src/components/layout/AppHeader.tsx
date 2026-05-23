import { Github, Monitor, Moon, Plus, Settings, Sun } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { OpenExternalURL } from "../../../wailsjs/go/backend/Service";
import { HitokotoStrip } from "./HitokotoStrip";
import { isWindows, usesAppleUI } from "../../lib/platform";

const REPO_URL = "https://github.com/RoseKhlifa/Image-Studio";

export function AppHeader({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { fullscreen, theme, setTheme, pushToast, workspaces, newWorkspace } = useStudioStore();
  if (fullscreen) return null;

  return (
    <header
      className={`drag-region sticky top-0 z-40 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--toolbar)] backdrop-blur-2xl ${
        usesAppleUI ? "liquid-glass-bar" : ""
      } ${
        usesAppleUI
          ? "min-h-[58px] pl-[92px] pr-5 pb-2 pt-3"
          : isWindows
            ? "min-h-[48px] px-3"
            : "min-h-12 px-4"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div
          className={`text-zinc-900 dark:text-zinc-100 ${
            isWindows
              ? "font-[600] text-[14px] tracking-[0]"
              : "text-[13px] font-semibold tracking-[-0.01em]"
          }`}
          style={{ fontFamily: "var(--title-font)" }}
        >
          Image Studio
        </div>
        <div className={`flex min-w-0 items-center text-zinc-500 dark:text-zinc-400 ${isWindows ? "mt-0 text-[10px]" : "mt-0.5 text-[11px]"}`}>
          <HitokotoStrip />
        </div>
      </div>

      <div className={`no-drag ml-auto flex items-center ${isWindows ? "gap-1" : "gap-1.5"}`}>
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
        <div className={`platform-seg flex items-center p-0.5 ring-1 ${
          isWindows
            ? "bg-white/66 ring-black/[0.08] dark:bg-white/[0.04] dark:ring-white/[0.08]"
            : "rounded-full bg-black/[0.04] ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06]"
        }`}>
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
        <HeaderIconBtn
          onClick={onOpenSettings}
          title="设置"
        >
          <Settings className="h-4 w-4" />
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
      className={`platform-icon-btn no-drag relative flex items-center justify-center text-zinc-600 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100 ${
        isWindows ? "h-8 w-8 rounded-[8px]" : "h-8 w-8 rounded-full"
      }`}
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
      className={`platform-chip no-drag flex h-7 w-7 items-center justify-center transition-all ${
        active
          ? "active bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      } ${isWindows ? "rounded-[7px]" : "rounded-full"}`}
    >
      {children}
    </button>
  );
}
