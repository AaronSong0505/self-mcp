import { describe, expect, it } from "vitest";
import {
  buildXSearchUrl,
  coerceXSearchMode,
  deriveHandleFromXStatusUrl,
  estimateXTextLength,
  normalizeXStatusUrl,
  normalizeXActor,
} from "../services/x-social-mcp/src/service.js";

describe("x social helpers", () => {
  it("defaults search mode to latest", () => {
    expect(coerceXSearchMode()).toBe("latest");
    expect(coerceXSearchMode("weird")).toBe("latest");
    expect(coerceXSearchMode("top")).toBe("top");
  });

  it("builds live search urls", () => {
    expect(buildXSearchUrl("openclaw", "latest")).toBe(
      "https://x.com/search?q=openclaw&src=typed_query&f=live",
    );
    expect(buildXSearchUrl("qwen 3.5", "top")).toBe(
      "https://x.com/search?q=qwen%203.5&src=typed_query",
    );
  });

  it("normalizes actor names", () => {
    expect(normalizeXActor("@AaronSong98")).toBe("AaronSong98");
    expect(normalizeXActor("AaronSong98")).toBe("AaronSong98");
    expect(normalizeXActor("   ")).toBeUndefined();
  });

  it("derives handles from status urls", () => {
    expect(deriveHandleFromXStatusUrl("https://x.com/AaronSong98/status/123")).toBe("AaronSong98");
    expect(deriveHandleFromXStatusUrl("https://example.com/not-x")).toBeUndefined();
  });

  it("normalizes status urls by stripping media suffixes", () => {
    expect(normalizeXStatusUrl("https://x.com/AaronSong98/status/123/photo/1")).toBe(
      "https://x.com/AaronSong98/status/123",
    );
  });

  it("estimates post length by unicode code points", () => {
    expect(estimateXTextLength("hello")).toBe(5);
    expect(estimateXTextLength("🐻")).toBe(1);
    expect(estimateXTextLength("  hi  ")).toBe(2);
  });
});
