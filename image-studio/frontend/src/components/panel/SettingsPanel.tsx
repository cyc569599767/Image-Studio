import { useEffect, useState } from "react";
import {
  Download, Folder, FolderEdit, Github, Info, KeyRound,
  MessageSquare, Monitor, Moon, RotateCw, Sun, Trash2, Upload, X,
} from "lucide-react";
import { useStudioStore } from "../../state/studioStore";
import {
  GetOutputDir, OpenOutputDir, OpenExternalURL, ChooseOutputDir, SetOutputDir,
} from "../../../wailsjs/go/backend/Service";
import type { TransportKind } from "../../types/domain";
import { Modal } from "../common/Modal";
import { rememberTrustedOutputRoot } from "../../lib/storage";
import { isWindows, platformOutputRootLabel, platformRuntimeLabel, undoShortcutLabel } from "../../lib/platform";

const REPO_URL = "https://github.com/RoseKhlifa/Image-Studio";
const MIT_URL = "https://opensource.org/licenses/MIT";

function PresetsRow() {
  const { presets, savePreset, applyPreset, deletePreset } = useStudioStore();
  function onSave() {
    const name = prompt("预设名:");
    if (name) savePreset(name);
  }
  return (
    <div className="flex flex-col gap-1.5">
      {presets.map((p) => (
        <div key={p.id} className="flex items-center gap-1">
          <button
            onClick={() => applyPreset(p.id)}
            title={`${p.size} · ${p.quality}`}
            className={`flex-1 border border-black/[0.08] px-3 py-2 text-left text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            {p.name}
          </button>
          <button
            onClick={() => deletePreset(p.id)}
            title="删除"
            className={`p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      <button
        onClick={onSave}
        className={`border border-dashed border-black/[0.12] px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.1] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
      >
        + 保存当前参数
      </button>
    </div>
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    transport,
    theme, fontScale,
    setField, setAPIKey,
    history,
    exportHistory, importHistory,
    setTheme, setFontScale,
    pushToast,
  } = useStudioStore();

  const [outputDir, setOutputDir] = useState("");
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    GetOutputDir().then(setOutputDir).catch(() => undefined);
  }, [open]);

  async function clearAPIKey() {
    if (!confirm("确定清除已保存的 API Key 吗?")) return;
    try {
      await setAPIKey("");
      pushToast("已清除安全存储中的 API Key", "success");
    } catch (e: any) {
      pushToast(`清除失败:${e?.message ?? e}`, "error", 5000);
    }
  }

  async function clearHistory() {
    if (!confirm(`确定清除 ${history.length} 条历史记录吗?(本地数据库也会删除)`)) return;
    for (const h of history) {
      await useStudioStore.getState().deleteHistoryItem(h.id);
    }
  }

  function closeSettings() {
    setAboutOpen(false);
    onClose();
  }

  return (
    <>
      <Modal open={open} onClose={closeSettings} title="设置" width={540}>
        <div className="flex flex-col gap-3.5">
          {/* 网络通道 */}
          <Row label="网络通道">
            <select
              value={transport}
              onChange={(e) => setField("transport", e.target.value as TransportKind)}
              className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-xs text-zinc-900 dark:border-white/[0.08] dark:text-zinc-100 ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
            >
              <option value="auto">auto(原生 HTTP)</option>
              <option value="native">native(强制原生)</option>
              <option value="curl">curl(子进程兜底)</option>
            </select>
            <p className="text-[10px] text-zinc-500 mt-1">
              如果遇到网络问题(Cloudflare TLS / 公司代理),试 curl
            </p>
          </Row>

          {/* 输出目录 */}
          <Row label="输出目录">
            <div className={`flex items-center gap-1 border border-black/[0.08] bg-[var(--surface)] px-3 py-2 dark:border-white/[0.08] ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}>
              <span title={outputDir} className="flex-1 text-[11px] font-mono-token text-zinc-700 dark:text-zinc-300 truncate">
                {outputDir || "..."}
              </span>
              <button
                onClick={() => OpenOutputDir().catch(() => undefined)}
                title="在系统文件管理器中打开"
                className={`p-1 text-zinc-500 hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] ${isWindows ? "rounded-[6px]" : "rounded-full"}`}
              >
                <Folder className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-1.5 mt-1.5">
              <button
                onClick={async () => {
                  try {
                    const chosen = await ChooseOutputDir();
                    if (chosen) {
                      try { localStorage.setItem("gptcodex.outputDir", chosen); } catch {}
                      rememberTrustedOutputRoot(chosen);
                      setOutputDir(chosen);
                      pushToast(`输出目录已切换:${chosen}`, "success");
                    }
                  } catch (e: any) {
                    pushToast(`切换失败:${e?.message ?? e}`, "error", 5000);
                  }
                }}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
              >
                <FolderEdit className="w-3 h-3" /> 修改
              </button>
              <button
                onClick={async () => {
                  try {
                    await SetOutputDir("");
                    try { localStorage.removeItem("gptcodex.outputDir"); } catch {}
                    const def = await GetOutputDir();
                    rememberTrustedOutputRoot(def);
                    setOutputDir(def);
                    pushToast("已恢复默认输出目录", "success");
                  } catch (e: any) {
                    pushToast(`重置失败:${e?.message ?? e}`, "error", 5000);
                  }
                }}
                title={`清除自定义路径,回到 ${platformOutputRootLabel()}/images`}
                className={`inline-flex items-center gap-1 border border-black/[0.08] px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
              >
                <RotateCw className="w-3 h-3" /> 默认
              </button>
            </div>
          </Row>

          {/* 主题 */}
          <Row label="主题">
            <div className={`platform-seg flex gap-1 bg-black/[0.04] p-0.5 ring-1 ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06] ${isWindows ? "rounded-[10px]" : "rounded-full"}`}>
              <SegBtn active={theme === "system"} onClick={() => setTheme("system")}>
                <Monitor className="w-3 h-3" /> 系统
              </SegBtn>
              <SegBtn active={theme === "dark"} onClick={() => setTheme("dark")}>
                <Moon className="w-3 h-3" /> 深色
              </SegBtn>
              <SegBtn active={theme === "light"} onClick={() => setTheme("light")}>
                <Sun className="w-3 h-3" /> 浅色
              </SegBtn>
            </div>
          </Row>

          {/* 字号 */}
          <Row label={`字号 ${Math.round(fontScale * 100)}%`}>
            <div className={`platform-seg flex gap-1 bg-black/[0.04] p-0.5 ring-1 ring-black/[0.05] dark:bg-white/[0.06] dark:ring-white/[0.06] ${isWindows ? "rounded-[10px]" : "rounded-full"}`}>
              {[0.85, 1, 1.15].map((v) => (
                <SegBtn key={v} active={Math.abs(fontScale - v) < 0.01} onClick={() => setFontScale(v)}>
                  {v === 0.85 ? "小" : v === 1 ? "中" : "大"}
                </SegBtn>
              ))}
            </div>
          </Row>

          {/* 预设 */}
          <Row label="参数预设">
            <PresetsRow />
          </Row>

          {/* 历史 import / export */}
          <div className="flex gap-1.5">
            <button
              onClick={exportHistory}
              title="导出全部历史为 JSON"
              className={`flex-1 inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Upload className="w-3 h-3" /> 导出历史
            </button>
            <button
              onClick={importHistory}
              title="从 JSON 文件导入"
              className={`flex-1 inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Download className="w-3 h-3" /> 导入历史
            </button>
          </div>

          {/* 危险动作 */}
          <div className="flex gap-1.5">
            <button
              onClick={clearAPIKey}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-red-400/40 hover:text-red-400 dark:border-white/[0.08] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <KeyRound className="w-3 h-3" /> 清除 API Key
            </button>
            <button
              onClick={clearHistory}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-red-400/40 hover:text-red-400 dark:border-white/[0.08] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Trash2 className="w-3 h-3" /> 清空历史
            </button>
          </div>

          <button
            onClick={() => setAboutOpen(true)}
            className={`inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-500 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            <Info className="w-3 h-3" /> 关于 Image Studio
          </button>

          <p className="text-[10px] text-zinc-500 leading-relaxed">
            {`快捷键:1/2/3 切工具 · 空格临时拖动 · F 重置视图 · [ ] 调笔刷 · ${undoShortcutLabel} 撤销 · Esc 取消/退出对比 · Shift+点击历史 进入对比`}
          </p>
        </div>
      </Modal>

      {/* 关于 modal */}
      <Modal open={aboutOpen} onClose={() => setAboutOpen(false)} title="关于 Image Studio" width={460}>
        <div className="text-center mb-5">
          <div className={`w-14 h-14 mx-auto mb-2 bg-white dark:bg-zinc-100 ring-1 ring-black/15 dark:ring-white/20 flex items-center justify-center ${isWindows ? "rounded-[12px]" : "rounded-2xl"}`}>
            <svg width="40" height="40" viewBox="0 0 1024 1024" fill="none" aria-hidden>
              <rect x="160" y="270" width="704" height="490" rx="56" stroke="#18181b" strokeWidth="56" />
              <path d="M 200 740 L 420 470 L 560 600 L 460 740 Z" fill="#52525b" />
              <path d="M 380 740 L 580 490 L 670 580 L 770 480 L 824 740 Z" fill="#18181b" />
              <circle cx="700" cy="420" r="55" stroke="#18181b" strokeWidth="48" />
              <polygon points="820,200 836,240 820,280 804,240" fill="#18181b" />
              <polygon points="780,240 820,224 860,240 820,256" fill="#18181b" />
            </svg>
          </div>
          <div className="text-lg font-bold">Image Studio</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            v0.1.4 · <span onClick={() => OpenExternalURL(MIT_URL).catch(() => undefined)} className="cursor-pointer text-[var(--accent)] hover:opacity-80">MIT License</span>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          一个开源的图片生成 / 编辑桌面客户端,基于 Wails(Go + React/TS)。
          所有数据(API Key、历史记录、生成图)都保存在本地机器,不上传任何服务器。API Key 走系统安全存储,不再保存在 localStorage。
        </p>
        <div className="mt-3.5 text-xs text-zinc-500 leading-relaxed space-y-0.5">
          <div><strong className="text-zinc-700 dark:text-zinc-300">技术栈:</strong></div>
          <div>· 后端:Go ≥ 1.25 / net/http SSE / pkg/client</div>
          <div>· 前端:React 18 + TypeScript / Tailwind v4 / zustand / react-konva</div>
          <div>· 打包:{platformRuntimeLabel()}</div>
          <div className="pt-1.5"><strong className="text-zinc-700 dark:text-zinc-300">支持的上游:</strong></div>
          <div>· 任何兼容 OpenAI <strong className="text-zinc-700 dark:text-zinc-300">Responses API</strong> 形态的中转站</div>
          <div>· 标准 <strong className="text-zinc-700 dark:text-zinc-300">Images API</strong>(generations + edits)</div>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => OpenExternalURL(REPO_URL).catch(() => undefined)}
            className={`liquid-primary-button flex-1 inline-flex items-center justify-center gap-1.5 bg-[var(--accent)] px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--accent-2)] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            <Github className="w-3.5 h-3.5" /> GitHub 仓库
          </button>
          <button
            onClick={() => OpenExternalURL(REPO_URL + "/issues").catch(() => undefined)}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 border border-black/[0.08] px-3 py-2 text-xs text-zinc-700 transition-colors hover:bg-black/[0.04] dark:border-white/[0.08] dark:text-zinc-300 dark:hover:bg-white/[0.06] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
          >
            <MessageSquare className="w-3.5 h-3.5" /> 反馈
          </button>
        </div>
        <hr className="border-black/[0.06] dark:border-white/[0.04] mt-4 mb-3" />
        <div className="text-[10px] text-zinc-500 text-center leading-relaxed">
          100% 本地数据 · 无遥测 · 无云端账户 · 无内购<br />
          Copyright © 2026 · Released under MIT
        </div>
      </Modal>
    </>
  );
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">{label}</label>
      {children}
    </div>
  );
}

function SegBtn({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`platform-chip flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] font-medium transition-colors ${
        active
          ? "active bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200"
      } ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
    >
      {children}
    </button>
  );
}
