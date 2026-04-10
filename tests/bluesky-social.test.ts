import { afterEach, describe, expect, it } from "vitest";
import { BlueskySocialService, resolveProxyUrlFromEnv } from "../services/bluesky-social-mcp/src/service.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Bluesky social service", () => {
  it("returns an unconfigured status when credentials are missing", async () => {
    delete process.env.BLUESKY_HANDLE;
    delete process.env.BLUESKY_APP_PASSWORD;

    const service = new BlueskySocialService();
    const result = await service.status();

    expect(result.configured).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.serviceUrl).toBe("https://bsky.social");
  });

  it("previews grapheme length and limits without publishing", async () => {
    const service = new BlueskySocialService();
    const result = await service.previewPost({
      text: "小熊在 Bluesky 的第一条测试草稿：https://example.com",
      langs: ["zh-Hans"],
      sourceContext: "test",
    });

    expect(result.fitsLimit).toBe(true);
    expect(result.graphemeLength).toBeGreaterThan(0);
    expect(result.maxGraphemes).toBe(300);
    expect(result.langs).toEqual(["zh-Hans"]);
  });

  it("prefers a dedicated Bluesky proxy url over generic proxy env vars", () => {
    const proxyUrl = resolveProxyUrlFromEnv({
      BLUESKY_PROXY_URL: "socks5h://127.0.0.1:40008",
      ALL_PROXY: "http://127.0.0.1:7890",
    } as NodeJS.ProcessEnv);

    expect(proxyUrl).toBe("socks5h://127.0.0.1:40008");
  });
});
