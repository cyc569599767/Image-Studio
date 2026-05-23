import { ImageIcon, Upload } from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import { isWindows } from "../../lib/platform";

// EmptyState 中间的提示卡。背景动效不在这里实现 —— 它是 stage-host 自带的
// 棋盘格 + CSS keyframes 在 _canvas.css 里。这里只负责中央内容。
export function EmptyState() {
  const importImageFile = useStudioStore((s) => s.importImageFile);

  function onFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) importImageFile(f);
    e.target.value = "";
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center px-8 pointer-events-none">
      <div className={`relative z-10 max-w-sm border border-black/[0.06] bg-white/72 px-7 py-8 text-center shadow-[var(--shadow-card-hover)] backdrop-blur-2xl pointer-events-auto dark:border-white/[0.06] dark:bg-white/[0.04] ${isWindows ? "rounded-[16px]" : "rounded-[24px]"}`}>
        <div className={`mb-4 inline-flex h-16 w-16 items-center justify-center border border-[color:var(--accent)]/18 bg-[var(--accent-soft)] ${isWindows ? "rounded-[14px]" : "rounded-[20px]"}`}>
          <ImageIcon className="h-7 w-7 text-[var(--accent)]" />
        </div>
        <h2 className={`mb-1 text-zinc-900 dark:text-zinc-100 ${isWindows ? "text-[18px] font-semibold tracking-[0]" : "text-[20px] font-semibold tracking-[-0.02em]"}`}>还没有图片</h2>
        <p className="mb-4 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
          在左侧填好 prompt 后点「生成」, 或者拖一张本地图片到这里来编辑
        </p>
        <label className={`inline-flex cursor-pointer items-center gap-1.5 border border-black/[0.08] bg-white/70 px-4 py-2.5 text-sm text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-zinc-300 ${isWindows ? "rounded-[10px]" : "rounded-full"}`}>
          <Upload className="w-3.5 h-3.5" />
          选择本地图片
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onFilePick} className="hidden" />
        </label>
      </div>
    </div>
  );
}
