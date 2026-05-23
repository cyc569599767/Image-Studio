import { useEffect, useRef } from "react";
import { isWindows } from "../../lib/platform";

export interface MenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function ContextMenu({
  x, y, items, onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const w = 220;
  const ah = 32;
  const h = items.length * ah + 8;
  const left = Math.min(x, window.innerWidth - w - 8);
  const top = Math.min(y, window.innerHeight - h - 8);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left, top, width: w }}
      onContextMenu={(e) => e.preventDefault()}
      className={`z-[9200] overflow-hidden border border-black/[0.08] bg-white/95 py-1 shadow-[0_24px_60px_rgb(15_23_42_/_0.16)] backdrop-blur-2xl dark:border-white/[0.08] dark:bg-zinc-900/95 ${isWindows ? "rounded-[12px]" : "rounded-[18px]"}`}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.separatorBefore && <div className="h-px my-1 bg-black/5 dark:bg-white/5" />}
          <button
            onClick={() => { if (!it.disabled) { it.onClick(); onClose(); } }}
            disabled={it.disabled}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              it.danger
                ? "text-red-500 hover:bg-red-500/10"
                : "text-zinc-700 dark:text-zinc-300 hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
            }`}
          >
            {it.icon && <span className="w-4 text-center">{it.icon}</span>}
            <span>{it.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
