// IndexedDB + localStorage helpers for non-secret frontend persistence.

import { get, set, del, entries, keys } from "idb-keyval";
import type { HistoryItem } from "../types/domain";

const HISTORY_PREFIX = "history:";
const HISTORY_FULL_PREFIX = "history-full:";
const TRUSTED_OUTPUT_ROOTS_KEY = "gptcodex.trustedOutputRoots";
const LEGACY_SHARED_API_KEY = "gptcodex.apiKey";

export function loadLegacySharedAPIKey(): string {
  try {
    return localStorage.getItem(LEGACY_SHARED_API_KEY) ?? "";
  } catch {
    return "";
  }
}

export function loadLegacyModeAPIKey(mode: "responses" | "images"): string {
  try {
    return localStorage.getItem(`gptcodex.${mode}.apiKey`) ?? "";
  } catch {
    return "";
  }
}

export function clearLegacyAPIKeys(): void {
  try {
    localStorage.removeItem(LEGACY_SHARED_API_KEY);
    localStorage.removeItem("gptcodex.responses.apiKey");
    localStorage.removeItem("gptcodex.images.apiKey");
  } catch {
    // ignore
  }
}

export function loadTrustedOutputRoots(): string[] {
  try {
    const raw = localStorage.getItem(TRUSTED_OUTPUT_ROOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && !!v.trim())
      : [];
  } catch {
    return [];
  }
}

export function rememberTrustedOutputRoot(root: string): string[] {
  const cleaned = root.trim();
  if (!cleaned) return loadTrustedOutputRoots();
  const next = Array.from(new Set([...loadTrustedOutputRoots(), cleaned]));
  try {
    localStorage.setItem(TRUSTED_OUTPUT_ROOTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export async function persistHistoryItem(item: HistoryItem): Promise<void> {
  await set(HISTORY_PREFIX + item.id, item);
}

export async function persistHistoryFullImage(id: string, imageB64: string): Promise<void> {
  await set(HISTORY_FULL_PREFIX + id, imageB64);
}

export async function loadHistoryFullImage(id: string): Promise<string> {
  return (await get<string>(HISTORY_FULL_PREFIX + id)) ?? "";
}

export async function pruneHistoryStorage(keepIDs: string[]): Promise<void> {
  const keep = new Set(keepIDs);
  const all = await keys();
  for (const k of all) {
    if (typeof k !== "string") continue;
    let id = "";
    if (k.startsWith(HISTORY_PREFIX)) id = k.slice(HISTORY_PREFIX.length);
    else if (k.startsWith(HISTORY_FULL_PREFIX)) id = k.slice(HISTORY_FULL_PREFIX.length);
    else continue;
    if (keep.has(id)) continue;
    await del(k);
  }
}

export async function removeHistoryItem(id: string): Promise<void> {
  await del(HISTORY_PREFIX + id);
  await del(HISTORY_FULL_PREFIX + id);
}

export async function loadAllHistory(): Promise<HistoryItem[]> {
  const items: HistoryItem[] = [];
  const all = await entries<string, HistoryItem>();
  for (const [k, v] of all) {
    if (typeof k !== "string" || !k.startsWith(HISTORY_PREFIX)) continue;
    if (v) items.push(v);
  }
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}
