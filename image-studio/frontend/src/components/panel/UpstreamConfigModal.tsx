import { useState, useEffect, useMemo } from "react";
import { Copy, Eye, EyeOff, Info, Plug, Plus, Trash2 } from "lucide-react";
import { Modal } from "../common/Modal";
import { useStudioStore } from "../../state/studioStore";
import { GetStoredAPIKey } from "../../../wailsjs/go/backend/Service";
import { validateBaseURL } from "../../lib/security";
import { keyringUserFor } from "../../lib/profiles";
import { isWindows, usesAppleUI } from "../../lib/platform";
import type { APIMode, UpstreamProfile } from "../../types/domain";

// v0.1.6 多 profile 配置 modal。左侧 profile 列表 + 右侧编辑表单。
// 列表点击 = 切 active(立即生效);右侧改字段 = 编辑当前选中,点保存才落盘。
export function UpstreamConfigModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    profiles, activeProfileId,
    createProfile, updateProfile, deleteProfile, duplicateProfile, setActiveProfile,
    testAPIKey, isTestingKey,
  } = useStudioStore();

  // selected = 当前编辑的 profile id(可以跟 active 不同 —— 用户在浏览/编辑
  // 别的 profile,但还没把它设为 active)。打开 modal 默认 selected = active。
  const [selectedId, setSelectedId] = useState<string>(activeProfileId);
  // 当前 selected 的草稿副本,改完字段后调 updateProfile 才生效
  const [draft, setDraft] = useState<UpstreamProfile | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savedKeyLoaded, setSavedKeyLoaded] = useState(false);

  // 打开 modal / 切 selected → 重新加载草稿与 keyring 里的 apiKey
  useEffect(() => {
    if (!open) return;
    const sid = selectedId && profiles.some((p) => p.id === selectedId)
      ? selectedId
      : (activeProfileId || profiles[0]?.id || "");
    setSelectedId(sid);
    const p = profiles.find((x) => x.id === sid) ?? null;
    setDraft(p);
    setDraftKey("");
    setSavedKeyLoaded(false);
    if (p) {
      GetStoredAPIKey(keyringUserFor(p.id))
        .then((k) => { setDraftKey(k ?? ""); setSavedKeyLoaded(true); })
        .catch(() => setSavedKeyLoaded(true));
    } else {
      setSavedKeyLoaded(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectedId, profiles.length]);

  // 列表切换 selected
  function selectProfile(id: string) {
    if (id === selectedId) return;
    setSelectedId(id);
  }

  const baseURLError = useMemo(() => {
    if (!draft) return null;
    return draft.baseURL.trim() ? validateBaseURL(draft.baseURL) : null;
  }, [draft?.baseURL]);

  const canSave = !!draft && !!draft.baseURL.trim() && !!draftKey.trim() && !baseURLError;

  function patchDraft(patch: Partial<UpstreamProfile>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
  }

  async function handleNew() {
    const id = await createProfile({
      name: "新配置",
      apiMode: "responses",
      setActive: profiles.length === 0, // 第一个自动 active,后续手动切
    });
    setSelectedId(id);
  }

  async function handleDuplicate() {
    if (!selectedId) return;
    const newId = await duplicateProfile(selectedId);
    if (newId) setSelectedId(newId);
  }

  async function handleDelete() {
    if (!draft) return;
    if (!window.confirm(`确认删除「${draft.name}」配置?对应的 API Key 也会从系统凭据存储清除。`)) return;
    const deletingId = draft.id;
    await deleteProfile(deletingId);
    // 删完 selected:切到第一个剩余(action 内部已经更新 active);UI 跟着
    const remaining = useStudioStore.getState().profiles;
    setSelectedId(remaining[0]?.id ?? "");
  }

  async function handleSave() {
    if (!draft) return;
    await updateProfile(draft.id, {
      name: draft.name,
      apiMode: draft.apiMode,
      baseURL: draft.baseURL,
      textModelID: draft.textModelID,
      imageModelID: draft.imageModelID,
      concurrencyLimit: draft.concurrencyLimit,
      apiKey: draftKey,
    });
    // 如果当前 selected 不是 active,问要不要切;不弹了,直接什么都不做
  }

  async function handleSetActive() {
    if (!draft) return;
    await setActiveProfile(draft.id);
  }

  async function handleTest() {
    if (!draft || !canSave) return;
    // 先保存,再测;testAPIKey 读 active profile 的字段,所以要让它先切到 selected
    await handleSave();
    if (draft.id !== activeProfileId) {
      await setActiveProfile(draft.id);
    }
    setTimeout(() => { void testAPIKey(); }, 0);
  }

  return (
    <Modal open={open} onClose={onClose} title="上游配置" width={760}>
      <div className="flex gap-4">
        {/* ---------------- 左侧 profile 列表 ---------------- */}
        <aside className="flex w-[240px] shrink-0 flex-col gap-2">
          <div className={`flex-1 overflow-y-auto border border-black/[0.08] bg-[var(--surface)] p-1.5 dark:border-white/[0.06] ${isWindows ? "rounded-[10px]" : "rounded-[16px]"}`} style={{ maxHeight: 460 }}>
            {profiles.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-zinc-500">还没有配置,点下方「+ 新建」开始。</p>
            ) : (
              profiles.map((p) => {
                const isSel = p.id === selectedId;
                const isActive = p.id === activeProfileId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectProfile(p.id)}
                    className={`platform-card group mb-1 flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors ${
                      isSel
                        ? "border-[color:var(--accent)]/35 bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "border-transparent text-zinc-700 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.04]"
                    } ${isWindows ? "rounded-[8px]" : "rounded-[12px]"}`}
                  >
                    <span
                      title={isActive ? "当前激活" : "点列表切换 selected;点「设为激活」激活"}
                      className={`h-2 w-2 shrink-0 rounded-full ${isActive ? "bg-[var(--accent)] shadow-[0_0_5px_rgb(0_122_255_/_0.6)]" : "bg-zinc-300 dark:bg-zinc-700"}`}
                    />
                    <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{p.name}</span>
                    <span className="shrink-0 text-[9px] uppercase tracking-wider opacity-70">
                      {p.apiMode === "responses" ? "R" : "I"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={handleNew}
              className={`platform-action-btn inline-flex flex-1 items-center justify-center gap-1 border border-black/[0.08] px-2.5 py-1.5 text-[11px] text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Plus className="h-3 w-3" /> 新建
            </button>
            <button
              type="button"
              onClick={handleDuplicate}
              disabled={!selectedId}
              title="复制当前选中"
              className={`platform-action-btn inline-flex items-center justify-center gap-1 border border-black/[0.08] px-2.5 py-1.5 text-[11px] text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Copy className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!selectedId}
              title="删除当前选中(连同凭据)"
              className={`platform-action-btn inline-flex items-center justify-center gap-1 border border-black/[0.08] px-2.5 py-1.5 text-[11px] text-zinc-500 transition-colors hover:border-red-400/45 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/[0.08] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
          {draft && draft.id !== activeProfileId && (
            <button
              type="button"
              onClick={handleSetActive}
              className={`platform-action-btn inline-flex items-center justify-center gap-1 border border-[color:var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--accent)] transition-colors hover:bg-[color:var(--accent)]/15 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
            >
              设为当前激活
            </button>
          )}
        </aside>

        {/* ---------------- 右侧编辑表单 ---------------- */}
        <section className="flex-1 min-w-0">
          {!draft ? (
            <div className="grid h-full place-items-center py-10 text-sm text-zinc-500">
              在左侧选一个配置,或新建一个。
            </div>
          ) : (
            <div className="flex flex-col gap-3.5">
              <Field label="名称">
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                  spellCheck={false}
                  className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
                />
              </Field>

              <Field label="API 形态">
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { id: "responses" as APIMode, title: "Responses API", sub: "SSE 保活(CF 超时推荐)" },
                    { id: "images" as APIMode, title: "Images API", sub: "标准 generations / edits" },
                  ]).map((o) => {
                    const active = draft.apiMode === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => patchDraft({ apiMode: o.id })}
                        className={`platform-card flex flex-col items-start gap-0.5 border p-2.5 text-left transition-colors ${
                          active
                            ? "active border-[color:var(--accent)]/25 bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "border-black/[0.08] text-zinc-700 hover:border-[color:var(--accent)]/30 dark:border-white/[0.06] dark:text-zinc-300"
                        } ${isWindows ? "rounded-[8px]" : "rounded-[14px]"}`}
                      >
                        <span className="text-[12px] font-semibold">{o.title}</span>
                        <span className={`text-[10px] ${active ? "text-[var(--accent)]/80" : "text-zinc-500"}`}>{o.sub}</span>
                      </button>
                    );
                  })}
                </div>
                <Hint>
                  {draft.apiMode === "responses" ? (
                    <>需要 key 绑定到「拥有 gpt-5.5 模型的分组」。SSE 保活可防 Cloudflare 524。</>
                  ) : (
                    <>使用标准 Images API,key 用 image-2 / image API 分组,兼容性最广。</>
                  )}
                </Hint>
              </Field>

              <Field label={<>上游 BASE_URL <Req /></>}>
                <input
                  type="text"
                  value={draft.baseURL}
                  placeholder="https://your-relay.example.com"
                  onChange={(e) => patchDraft({ baseURL: e.target.value })}
                  spellCheck={false}
                  className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
                />
                {baseURLError && <Hint>{baseURLError}</Hint>}
              </Field>

              <Field label={<>API Key <Req /></>}>
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={draftKey}
                    placeholder={savedKeyLoaded ? "sk-..." : "(加载中...)"}
                    onChange={(e) => setDraftKey(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] py-2 pl-3 pr-10 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((v) => !v)}
                    title={showKey ? "隐藏" : "显示"}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] ${isWindows ? "rounded-[6px]" : "rounded-full"}`}
                  >
                    {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <Hint>API Key 保存到系统凭据存储(Keychain / Credential Manager / Secret Service),不在 localStorage 中明文存放。</Hint>
              </Field>

              {draft.apiMode === "responses" && (
                <Field label="文本模型 ID">
                  <input
                    type="text"
                    value={draft.textModelID}
                    placeholder="留空=默认 gpt-5.5"
                    onChange={(e) => patchDraft({ textModelID: e.target.value })}
                    spellCheck={false}
                    className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
                  />
                </Field>
              )}

              <Field label="图像模型 ID">
                <input
                  type="text"
                  value={draft.imageModelID}
                  placeholder="留空=默认 gpt-image-2"
                  onChange={(e) => patchDraft({ imageModelID: e.target.value })}
                  spellCheck={false}
                  className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
                />
              </Field>

              <Field label="并发数量限制">
                <input
                  type="number"
                  value={draft.concurrencyLimit || ""}
                  placeholder="留空=不限制"
                  min={0}
                  step={1}
                  onChange={(e) => patchDraft({ concurrencyLimit: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                  className={`focus-ring w-full border border-black/[0.08] bg-[var(--surface)] px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}
                />
                <Hint>0/留空 = 不限制。填正整数后,此 profile 跨所有标签页最多同时运行这么多任务。</Hint>
              </Field>

              <button
                type="button"
                onClick={handleTest}
                disabled={!canSave || isTestingKey}
                className={`platform-action-btn w-full inline-flex items-center justify-center gap-2 border border-black/[0.08] px-3 py-2 text-sm text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-zinc-300 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
              >
                <Plug className={`h-3.5 w-3.5 ${isTestingKey ? "animate-spin" : ""}`} />
                {isTestingKey ? "测试中..." : "保存并测试连接"}
              </button>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={onClose}
                  className={`platform-action-btn border border-black/[0.08] px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-black/[0.04] dark:border-white/[0.08] dark:text-zinc-300 dark:hover:bg-white/[0.06] ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={async () => { await handleSave(); onClose(); }}
                  disabled={!canSave}
                  className={`liquid-primary-button bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 dark:disabled:bg-zinc-800 ${isWindows ? "rounded-[8px]" : "rounded-full"}`}
                >
                  保存
                </button>
              </div>

              {!canSave && draft && (
                <p className="text-[11px] text-zinc-500">BASE_URL 和 API Key 必须填齐才能保存。</p>
              )}

              {draft.apiMode === "images" && (
                <div className={`${usesAppleUI ? "liquid-glass-panel" : ""} flex items-start gap-2 border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent)] ${isWindows ? "rounded-[10px]" : "rounded-[14px]"}`}>
                  <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>Images API 路径走标准 <code className="font-mono-token">/v1/images/generations</code> + <code className="font-mono-token">/v1/images/edits</code>,无 SSE 保活,长推理 CF 524 风险更高,但兼容性最广。</span>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs text-zinc-600 dark:text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-500">{children}</p>
  );
}

function Req() {
  return <span className="text-red-500">*</span>;
}
