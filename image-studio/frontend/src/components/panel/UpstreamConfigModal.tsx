import { useState, useEffect } from "react";
import { Eye, EyeOff, Info, Plug } from "lucide-react";
import { Modal } from "../common/Modal";
import { useStudioStore } from "../../state/studioStore";
import { cleanBaseURL, validateBaseURL } from "../../lib/security";

export function UpstreamConfigModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    apiMode, responsesConfig, imagesConfig,
    setField, setAPIKey,
    testAPIKey, isTestingKey,
  } = useStudioStore();

  const [draftApiMode, setDraftApiMode] = useState<"responses" | "images">(apiMode);
  const [draftResponses, setDraftResponses] = useState(responsesConfig);
  const [draftImages, setDraftImages] = useState(imagesConfig);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftApiMode(apiMode);
      setDraftResponses(responsesConfig);
      setDraftImages(imagesConfig);
    }
  }, [open, apiMode, responsesConfig, imagesConfig]);

  const cur = draftApiMode === "responses" ? draftResponses : draftImages;
  const setCur = (patch: Partial<typeof cur>) => {
    if (draftApiMode === "responses") setDraftResponses({ ...draftResponses, ...patch });
    else setDraftImages({ ...draftImages, ...patch });
  };

  const draftBaseURL = cur.baseURL;
  const draftApiKey = cur.apiKey;
  const draftTextModel = cur.textModelID;
  const draftImageModel = cur.imageModelID;

  const baseURLError = draftBaseURL.trim() ? validateBaseURL(draftBaseURL) : null;
  const canSave = !baseURLError && !!draftBaseURL.trim() && !!draftApiKey.trim();

  async function commit() {
    const writeMode = (m: "responses" | "images", cfg: typeof cur) => {
      setField("apiMode", m);
      setField("baseURL", cleanBaseURL(cfg.baseURL));
      setField("textModelID", cfg.textModelID.trim());
      setField("imageModelID", cfg.imageModelID.trim());
    };
    writeMode("responses", draftResponses);
    await setAPIKey(draftResponses.apiKey.trim());
    writeMode("images", draftImages);
    await setAPIKey(draftImages.apiKey.trim());
    setField("apiMode", draftApiMode);
  }

  async function save() {
    try {
      await commit();
      onClose();
    } catch (e) {
      console.error(e);
    }
  }

  async function testWithCurrentDraft() {
    if (!canSave) return;
    await commit();
    setTimeout(() => testAPIKey(), 0);
  }

  return (
    <Modal open={open} onClose={onClose} title="上游配置" width={520}>
      <div className="flex flex-col gap-4">
        {/* API 形态选择 */}
        <Field label="API 形态">
          <div className="grid grid-cols-2 gap-2">
            {([
              { id: "responses" as const, title: "Responses API", sub: "SSE 保活(CF 超时推荐)" },
              { id: "images" as const, title: "Images API", sub: "标准 generations / edits" },
            ]).map((o) => {
              const active = draftApiMode === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setDraftApiMode(o.id)}
                  className={`flex flex-col items-start gap-0.5 rounded-[16px] border p-3 text-left transition-colors ${
                    active
                      ? "border-[color:var(--accent)]/25 bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-black/[0.08] text-zinc-700 hover:border-[color:var(--accent)]/30 dark:border-white/[0.06] dark:text-zinc-300"
                  }`}
                >
                  <span className="text-sm font-semibold">{o.title}</span>
                  <span className={`text-[10px] ${active ? "text-[var(--accent)]/80" : "text-zinc-500"}`}>{o.sub}</span>
                </button>
              );
            })}
          </div>
          <Hint>
            {draftApiMode === "responses" ? (
              <>通过 <code className="font-mono-token">/v1/responses</code> 调用模型内置的 <code className="font-mono-token">image_generation</code> 工具,SSE 流式接收 —— 能防 Cloudflare 524/504 超时截断。<br />
              <strong className="text-zinc-700 dark:text-zinc-300">需要 key 绑定到「拥有 gpt-5.5 模型的分组」</strong>(余额/套餐),不是 image-2 分组。</>
            ) : (
              <>通过标准 <code className="font-mono-token">/v1/images/generations</code>(文生图)+ <code className="font-mono-token">/v1/images/edits</code>(图生图)。一次性 JSON 响应,无 SSE 保活,但兼容性最广。<br />
              <strong className="text-zinc-700 dark:text-zinc-300">可使用标准的 image-2 / image API 分组</strong>(不需要 gpt-5.5 权限)。</>
            )}
          </Hint>
        </Field>

        <div className="flex items-start gap-2 rounded-[16px] border border-[color:var(--accent)]/20 bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent)]">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            下方编辑的是 <strong>{draftApiMode === "responses" ? "Responses API" : "Images API"}</strong> 的配置 —— 两种形态各存一份,切换时另一份不动。
          </span>
        </div>

        {/* BASE_URL */}
        <Field label={<>上游 BASE_URL <Req /></>}>
          <input
            type="text"
            value={draftBaseURL}
            placeholder="https://your-relay.example.com"
            onChange={(e) => setCur({ baseURL: e.target.value })}
            spellCheck={false}
            autoFocus={!draftBaseURL}
            className="focus-ring w-full rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token"
          />
          {baseURLError && <Hint>{baseURLError}</Hint>}
        </Field>

        {/* API Key */}
        <Field label={<>API Key <Req /></>}>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={draftApiKey}
              placeholder="sk-..."
              onChange={(e) => setCur({ apiKey: e.target.value })}
              spellCheck={false}
              autoComplete="off"
              className="focus-ring w-full rounded-[14px] border border-black/[0.08] bg-[var(--surface)] py-2.5 pl-3 pr-10 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? "隐藏" : "显示"}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-zinc-500 hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]"
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          <Hint>保存后会写入系统凭据存储(Keychain / Credential Manager / Secret Service),不再放进浏览器 localStorage。</Hint>
        </Field>

        {draftApiMode === "responses" && (
          <Field label="文本模型 ID">
            <input
              type="text"
              value={draftTextModel}
              placeholder="留空=默认 gpt-5.5"
              onChange={(e) => setCur({ textModelID: e.target.value })}
              spellCheck={false}
              className="focus-ring w-full rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token"
            />
          </Field>
        )}

        <Field label="图像模型 ID">
          <input
            type="text"
            value={draftImageModel}
            placeholder={draftApiMode === "responses"
              ? "留空=默认 gpt-image-2(由 image_generation 工具触发)"
              : "留空=默认 gpt-image-2(直接传给 Images API)"}
            onChange={(e) => setCur({ imageModelID: e.target.value })}
            spellCheck={false}
            className="focus-ring w-full rounded-[14px] border border-black/[0.08] bg-[var(--surface)] px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-white/[0.08] dark:text-zinc-100 dark:placeholder:text-zinc-500 font-mono-token"
          />
        </Field>

        <button
          type="button"
          onClick={testWithCurrentDraft}
          disabled={!canSave || isTestingKey}
          className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-black/[0.08] px-3 py-2.5 text-sm text-zinc-700 transition-colors hover:border-[color:var(--accent)]/35 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:text-zinc-300"
        >
          <Plug className={`w-3.5 h-3.5 ${isTestingKey ? "animate-spin" : ""}`} />
          {isTestingKey ? "测试中..." : "测试连接(会先保存草稿)"}
        </button>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-black/[0.08] px-4 py-2 text-sm text-zinc-700 transition-colors hover:bg-black/[0.04] dark:border-white/[0.08] dark:text-zinc-300 dark:hover:bg-white/[0.06]"
          >
            稍后再配
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-2)] disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-500 dark:disabled:bg-zinc-800"
          >
            保存
          </button>
        </div>
        {!canSave && (
          <p className="text-[11px] text-zinc-500">BASE_URL 和 API Key 至少要填一次才能开始生成。</p>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label className="block mb-1.5 text-xs text-zinc-600 dark:text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-500 leading-relaxed">{children}</p>
  );
}

function Req() {
  return <span className="text-red-500">*</span>;
}
