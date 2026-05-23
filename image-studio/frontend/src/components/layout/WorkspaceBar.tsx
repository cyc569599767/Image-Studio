import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { isAndroidPhone, isWindows, usesAppleUI } from "../../lib/platform";

// Browser-tab style strip. 每个 tab = 独立 workspace,历史栏共享。
// 单 workspace 时不显示。
export function WorkspaceBar() {
  const { workspaces, activeWorkspaceId, newWorkspace, switchWorkspace, closeWorkspace, renameWorkspace, fullscreen } = useStudioStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  if (fullscreen) return null;
  if (isAndroidPhone) return null;
  if (workspaces.length <= 1) return null;

  function startRename(id: string, currentName: string) {
    setEditingId(id);
    setEditingName(currentName);
  }
  function commitRename() {
    if (editingId) {
      renameWorkspace(editingId, editingName.trim() || "未命名");
    }
    setEditingId(null);
  }

  return (
    <div className={`drag-region flex items-center overflow-x-auto border-b border-[var(--border)] bg-[var(--toolbar)] backdrop-blur-2xl ${usesAppleUI ? "liquid-glass-bar" : ""} ${isWindows ? "gap-1 px-3 py-1.5" : "gap-1.5 px-4 py-2"}`}>
      {workspaces.map((w) => {
        const active = w.id === activeWorkspaceId;
        const isEditing = editingId === w.id;
        return (
          <div
            key={w.id}
            onClick={() => !isEditing && switchWorkspace(w.id)}
            onDoubleClick={() => startRename(w.id, w.name)}
            title="双击重命名"
            className={
              `platform-tab no-drag group flex shrink-0 items-center gap-2 text-[12px] transition-all cursor-pointer ${isWindows ? "h-8 rounded-[10px] px-3" : "h-8 rounded-full px-3"} ` +
              (active
                ? "active bg-white text-zinc-900 shadow-sm ring-1 ring-black/[0.06] dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/[0.08]"
                : "text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200")
            }
          >
            {isEditing ? (
              <input
                className="no-drag w-24 bg-transparent text-[12px] outline-none"
                value={editingName}
                autoFocus
                onChange={(e) => setEditingName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <>
                <span className="max-w-[132px] truncate">{w.name}</span>
                {w.runningJobIds.length > 0 && (
                  <span
                    title={`运行中 ${w.runningJobIds.length}`}
                    className="h-1.5 w-1.5 rounded-full bg-[var(--accent)] shadow-[0_0_6px_rgb(0_122_255_/_0.55)]"
                  />
                )}
              </>
            )}
            {!isEditing && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeWorkspace(w.id);
                }}
                title="关闭"
                className={`no-drag opacity-0 transition-opacity group-hover:opacity-100 -mr-1 p-1 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ${isWindows ? "rounded-[6px]" : "rounded-full"}`}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => newWorkspace()}
        title="新建标签页"
        className={`platform-icon-btn no-drag flex h-8 w-8 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
