import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";

export function SourceStrip() {
  const sources = useStudioStore((s) => s.sources);
  const removeSource = useStudioStore((s) => s.removeSource);
  const reorderSources = useStudioStore((s) => s.reorderSources);
  const mode = useStudioStore((s) => s.mode);
  const selectSourceImage = useStudioStore((s) => s.selectSourceImage);

  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  if (mode !== "edit") return null;
  if (sources.length === 0) return null;

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-black/[0.06] bg-[var(--toolbar)] px-3 py-2 backdrop-blur-2xl dark:border-white/[0.06]">
      <span className="text-[11px] text-zinc-500 shrink-0">参考图 {sources.length} 张:</span>
      {sources.map((s, i) => (
        <div
          key={s.path}
          draggable
          onDragStart={() => setDragFrom(i)}
          onDragOver={(e) => { e.preventDefault(); setOverIdx(i); }}
          onDragLeave={() => setOverIdx(null)}
          onDrop={(e) => {
            e.preventDefault();
            if (dragFrom != null && dragFrom !== i) reorderSources(dragFrom, i);
            setDragFrom(null);
            setOverIdx(null);
          }}
          onDragEnd={() => { setDragFrom(null); setOverIdx(null); }}
          title={`${i + 1}. ${s.name}\n${s.path}`}
          className={`relative group h-12 w-12 shrink-0 cursor-grab overflow-hidden rounded-[14px] border transition-all ${
            overIdx === i
              ? "scale-105 border-[color:var(--accent)] shadow-[0_0_0_1px_var(--accent)]"
              : "border-black/[0.06] hover:border-[color:var(--accent)]/30 dark:border-white/[0.06]"
          }`}
        >
          <span className="absolute top-0 left-0 z-10 px-1 text-[9px] bg-zinc-950/70 text-white rounded-br">
            {i + 1}
          </span>
          {s.imageB64 ? (
            <img
              src={`data:image/png;base64,${s.imageB64}`}
              alt={s.name}
              loading="lazy"
              decoding="async"
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-500 bg-zinc-100 dark:bg-zinc-800">
              {s.name.split(".").slice(-1)[0].toUpperCase()}
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); removeSource(i); }}
            title="移除"
            className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center bg-zinc-950/70 text-white opacity-0 group-hover:opacity-100 hover:bg-red-500 rounded-bl transition-all"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
      <button
        onClick={selectSourceImage}
        title="添加参考图"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] border border-dashed border-zinc-300 text-zinc-500 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-zinc-700"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
