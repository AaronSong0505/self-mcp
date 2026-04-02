import type { DigestMessage } from "./types.js";

function splitText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) {
      chunks.push(current.trim());
    }
    current = "";
  };

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    if (current) {
      flush();
    }
    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > maxChars) {
      const slice = remaining.slice(0, maxChars);
      const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf("；"));
      const cut = breakAt > maxChars * 0.5 ? breakAt + 1 : maxChars;
      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    current = remaining;
  }
  flush();
  return chunks;
}

export function expandDigestMessages(messages: DigestMessage[], maxChars = 900): DigestMessage[] {
  const expanded: DigestMessage[] = [];
  for (const message of messages) {
    const parts = splitText(message.body, maxChars);
    if (parts.length <= 1) {
      expanded.push({
        ...message,
        body: parts[0] ?? message.body.trim(),
      });
      continue;
    }
    parts.forEach((part, index) => {
      expanded.push({
        kind: message.kind,
        title: `${message.title} (${index + 1}/${parts.length})`,
        body: part,
      });
    });
  }
  return expanded;
}
