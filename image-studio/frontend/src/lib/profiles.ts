import type { APIMode, UpstreamProfile } from "../types/domain";

// localStorage 键名规范:
//   gptcodex.profiles        —— UpstreamProfile[] JSON(无 apiKey,key 在 keyring)
//   gptcodex.activeProfileId —— 当前 active profile 的 id
//
// 老格式(v0.1.5 及之前)在 bootstrap 一次性迁移:
//   gptcodex.apiMode                            "responses" | "images"
//   gptcodex.{responses,images}.baseURL
//   gptcodex.{responses,images}.textModelID
//   gptcodex.{responses,images}.imageModelID
//   gptcodex.{responses,images}.concurrencyLimit
//   keyring api-key:responses / api-key:images  → 搬到 api-key:profile:<newId>
export const PROFILES_LS_KEY = "gptcodex.profiles";
export const ACTIVE_PROFILE_LS_KEY = "gptcodex.activeProfileId";

// crypto.randomUUID 在 WebView2 / 现代 Chromium 都有。fallback 防御老内核。
export function genProfileId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* ignore */ }
  return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// keyringUser 把前端的 profile id 翻成后端 credentials.go 用的 user 字段。
// 命名空间 "profile:" 是为了和老的 "api-key:responses" / "api-key:images" 区分。
export function keyringUserFor(profileId: string): string {
  return `profile:${profileId}`;
}

export function apiModeLabel(mode: APIMode): string {
  return mode === "images" ? "Images API" : "Responses API";
}

// 从可信任的 JSON 反序列化一个 profile。字段缺失 / 类型不对回 null,bootstrap
// 里遇到坏的就跳过,不让一条坏数据带崩整张表。
export function tryParseProfile(raw: unknown): UpstreamProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  const name = typeof o.name === "string" ? o.name : "";
  const apiMode = o.apiMode === "images" ? "images" : "responses";
  const baseURL = typeof o.baseURL === "string" ? o.baseURL : "";
  const textModelID = typeof o.textModelID === "string" ? o.textModelID : "";
  const imageModelID = typeof o.imageModelID === "string" ? o.imageModelID : "";
  const concurrencyLimit = typeof o.concurrencyLimit === "number" && o.concurrencyLimit >= 0
    ? Math.floor(o.concurrencyLimit) : 0;
  const createdAt = typeof o.createdAt === "number" ? o.createdAt : Date.now();
  const lastUsedAt = typeof o.lastUsedAt === "number" ? o.lastUsedAt : undefined;
  if (!id || !name) return null;
  return { id, name, apiMode, baseURL, textModelID, imageModelID, concurrencyLimit, createdAt, lastUsedAt };
}

// 列表里挑当前 active —— activeProfileId 命中时用它,否则用最近使用过的,
// 否则就第一条。空列表返回 null,调用方据此弹「首次配置」modal。
export function pickActiveProfile(
  profiles: UpstreamProfile[],
  activeId: string,
): UpstreamProfile | null {
  if (profiles.length === 0) return null;
  const byId = profiles.find((p) => p.id === activeId);
  if (byId) return byId;
  const sorted = [...profiles].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
  return sorted[0] ?? profiles[0];
}

// 新建 profile 的默认值 —— UpstreamConfigModal 里点「+ 新建」用。
export function makeBlankProfile(apiMode: APIMode = "responses"): UpstreamProfile {
  return {
    id: genProfileId(),
    name: apiMode === "responses" ? "新配置 · Responses" : "新配置 · Images",
    apiMode,
    baseURL: "",
    textModelID: "",
    imageModelID: "",
    concurrencyLimit: 0,
    createdAt: Date.now(),
  };
}

// 复制一个 profile,name 末尾追加「副本」并生成新 id。
// keyring 里的 apiKey 由调用方在 commit 后单独搬过来(get → set)。
export function duplicateProfile(p: UpstreamProfile): UpstreamProfile {
  return {
    ...p,
    id: genProfileId(),
    name: `${p.name} · 副本`,
    createdAt: Date.now(),
    lastUsedAt: undefined,
  };
}
