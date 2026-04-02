import { describe, expect, it } from "vitest";
import { expandDigestMessages } from "../packages/core/src/message-split.js";

describe("expandDigestMessages", () => {
  it("splits long digest messages into multiple parts", () => {
    const long = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行内容`).join("\n\n");
    const messages = expandDigestMessages(
      [
        {
          kind: "detail",
          title: "测试详情",
          body: long,
        },
      ],
      80,
    );

    expect(messages.length).toBeGreaterThan(1);
    expect(messages[0]?.title).toContain("(1/");
  });
});
