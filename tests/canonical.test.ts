import { describe, expect, it } from "vitest";
import { canonicalizeUrl, toDateKey } from "../packages/core/src/canonical.js";

describe("canonicalizeUrl", () => {
  it("strips mp.weixin tracking params", () => {
    expect(
      canonicalizeUrl("https://mp.weixin.qq.com/s/FrSNOFwok8cenLksrkFG8w?scene=1&srcid=0101"),
    ).toBe("https://mp.weixin.qq.com/s/FrSNOFwok8cenLksrkFG8w");
  });

  it("removes common tracking params on generic urls", () => {
    expect(canonicalizeUrl("https://example.com/post?id=7&utm_source=test&from=feed")).toBe(
      "https://example.com/post?id=7",
    );
  });

  it("creates local date keys", () => {
    expect(toDateKey("2026-04-02T01:02:03.000Z")).toMatch(/^2026-04-02$/);
  });
});
