export const X_SEARCH_MODES = ["top", "latest"] as const;

export type XSearchMode = (typeof X_SEARCH_MODES)[number];

export function coerceXSearchMode(mode?: string): XSearchMode {
  return mode === "top" ? "top" : "latest";
}

export function buildXSearchUrl(query: string, mode: XSearchMode): string {
  const trimmed = query.trim();
  const base = `https://x.com/search?q=${encodeURIComponent(trimmed)}&src=typed_query`;
  return mode === "latest" ? `${base}&f=live` : base;
}

export function normalizeXActor(actor?: string): string | undefined {
  const trimmed = actor?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

export function deriveHandleFromXStatusUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = /^https:\/\/x\.com\/([^/?#]+)\/status\/\d+/i.exec(url);
  return match?.[1];
}

export function normalizeXStatusUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = /^https:\/\/x\.com\/([^/?#]+)\/status\/(\d+)/i.exec(url);
  if (!match) {
    return undefined;
  }
  return `https://x.com/${match[1]}/status/${match[2]}`;
}

export function estimateXTextLength(text: string): number {
  return Array.from(text.trim()).length;
}

export function normalizeXTextForMatch(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}
