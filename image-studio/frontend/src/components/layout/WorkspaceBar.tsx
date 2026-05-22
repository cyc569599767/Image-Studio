import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";

// Browser-tab style strip. 每个 tab = 独立 workspace,历史栏共享。
// 单 workspace 时不显示。
export function WorkspaceBar() {
  const { workspaces, activeWorkspaceId, newWorkspace, switchWorkspace, closeWorkspace, renameWorkspace, fullscreen } = useStudioStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  if (fullscreen) return null;
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
    <div className="drag-region flex items-center gap-1.5 overflow-x-auto border-b border-black/[0.06] bg-[var(--toolbar)] px-4 py-2 backdrop-blur-2xl dark:border-white/[0.06]">
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
              "no-drag group flex h-8 shrink-0 items-center gap-2 rounded-full px-3 text-[12px] transition-all cursor-pointer " +
              (active
                ? "bg-white text-zinc-900 shadow-sm ring-1 ring-black/[0.06] dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/[0.08]"
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
              <span className="max-w-[132px] truncate">{w.name}</span>
            )}
            {!isEditing && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeWorkspace(w.id);
                }}
                title="关闭"
                className="no-drag opacity-0 transition-opacity group-hover:opacity-100 -mr-1 rounded-full p-1 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
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
        className="no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-200"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
