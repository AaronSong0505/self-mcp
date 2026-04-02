export function canonicalizeUrl(rawUrl: string, baseUrl?: string): string {
  const url = new URL(rawUrl, baseUrl);
  url.hash = "";

  if (url.hostname === "mp.weixin.qq.com") {
    url.search = "";
  } else {
    const removable = new Set([
      "from",
      "frommsgid",
      "isappinstalled",
      "scene",
      "sessionid",
      "srcid",
      "timestamp",
    ]);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || removable.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
  }

  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  url.pathname = pathname;
  return url.toString();
}

export function toDateKey(input: string | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
