import type { HistoryItem } from "../types/domain";

export function cleanBaseURL(value: string): string {
  return value.replace(/\/+$/, "").trim();
}

export function validateBaseURL(value: string): string | null {
  const cleaned = cleanBaseURL(value);
  if (!cleaned) return "请填写上游 BASE_URL";
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    return "BASE_URL 格式无效,示例: https://relay.example.com";
  }
  if (!parsed.hostname) return "BASE_URL 必须包含主机名";
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol !== "http:") return "BASE_URL 仅支持 http:// 或 https://";
  return isLoopbackHost(parsed.hostname)
    ? null
    : "为了保护 API Key 和图片,非本机上游必须使用 https://";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function sanitizeHistoryForExport(item: HistoryItem): HistoryItem {
  return {
    ...item,
    savedPath: undefined,
    rawPath: undefined,
  };
}

export function sanitizeImportedHistoryItem(item: HistoryItem): HistoryItem {
  return sanitizeHistoryForExport(item);
}

export function suggestedImportNameForHistory(item: Pick<HistoryItem, "id" | "mode">): string {
  return `history-${item.mode}-${item.id.slice(0, 8)}.png`;
}
