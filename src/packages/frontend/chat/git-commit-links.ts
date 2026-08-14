/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const GIT_COMMIT_LINK_SCHEME = "cocalc-commit://";
const COMMIT_HASH_BOUNDARY_RE = /\b[0-9a-f]{7,40}\b/gi;
const INLINE_COMMIT_CODE_RE = /^`([0-9a-f]{7,40})(?:\s+([^\n`]*\S))?`$/i;
const HEAD_REF = "HEAD";

type MarkdownSpan = { protected: boolean; text: string };

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findBalancedEnd(
  text: string,
  start: number,
  open: string,
  close: string,
): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (isEscaped(text, i)) continue;
    if (text[i] === open) {
      depth += 1;
    } else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return;
}

function markdownLinkLikeEnd(text: string, index: number): number | undefined {
  if (text[index] === "<") {
    const end = text.indexOf(">", index + 1);
    if (end !== -1) {
      const target = text.slice(index + 1, end);
      if (/^(?:[a-z][a-z0-9+.-]*:\S+|[^\s<>@]+@[^\s<>@]+)$/i.test(target)) {
        return end + 1;
      }
    }
  }

  const labelStart =
    text[index] === "["
      ? index
      : text[index] === "!" && text[index + 1] === "["
        ? index + 1
        : undefined;
  if (labelStart == null || isEscaped(text, labelStart)) return;
  const labelEnd = findBalancedEnd(text, labelStart, "[", "]");
  if (labelEnd == null) return;

  if (text[labelEnd] === "(") {
    return findBalancedEnd(text, labelEnd, "(", ")");
  }
  if (text[labelEnd] === "[") {
    return findBalancedEnd(text, labelEnd, "[", "]");
  }

  // A bracketed span may be a shortcut reference link. Treating it as opaque
  // is safer than creating nested Markdown when its definition is elsewhere.
  return labelEnd;
}

function splitMarkdownLinkLikeSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const end = markdownLinkLikeEnd(text, index);
    if (end == null) {
      index += 1;
      continue;
    }
    if (plainStart < index) {
      spans.push({ protected: false, text: text.slice(plainStart, index) });
    }
    spans.push({ protected: true, text: text.slice(index, end) });
    index = end;
    plainStart = end;
  }
  if (plainStart < text.length) {
    spans.push({ protected: false, text: text.slice(plainStart) });
  }
  return spans;
}

function hasHexLetter(hash: string): boolean {
  return /[a-f]/i.test(hash);
}

function shouldAutoLinkCommitHash(
  hash: string,
  opts?: { subject?: string },
): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return false;
  if (hasHexLetter(hash)) return true;
  return !!opts?.subject;
}

export function linkifyCommitHashes(text: string): string {
  if (!text || !/[0-9a-f]{7,40}/i.test(text)) return text;
  const fencedChunks = text.split(/(```[\s\S]*?```)/g);
  return fencedChunks
    .map((chunk, idx) => {
      if (idx % 2 === 1) return chunk;
      return splitMarkdownLinkLikeSpans(chunk)
        .map(({ protected: isProtected, text: span }) => {
          if (isProtected) return span;
          const inlineChunks = span.split(/(`[^`\n]*`)/g);
          return inlineChunks
            .map((part, jdx) => {
              if (jdx % 2 === 1) {
                // Inline code span. Codex often writes "`hash subject`"; link
                // the hash while leaving the subject as plain text.
                const m = INLINE_COMMIT_CODE_RE.exec(part);
                if (!m) return part;
                const hash = m[1];
                const subject = m[2]?.trim();
                if (!shouldAutoLinkCommitHash(hash, { subject })) {
                  return part;
                }
                return [
                  `[Commit ${hash}](${GIT_COMMIT_LINK_SCHEME}${hash} "Open commit ${hash}")`,
                  subject ? ` ${subject}` : "",
                ].join("");
              }
              return part.replace(
                COMMIT_HASH_BOUNDARY_RE,
                (hash, offset: number, source: string) => {
                  const before = source[offset - 1] ?? "";
                  const after = source[offset + hash.length] ?? "";
                  // Don't link hash-like tokens inside URLs/query params/UUIDs.
                  if (/[-/=?&#:]/.test(before) || /[-/=?&#:]/.test(after)) {
                    return hash;
                  }
                  if (!shouldAutoLinkCommitHash(hash)) {
                    return hash;
                  }
                  return `[Commit ${hash}](${GIT_COMMIT_LINK_SCHEME}${hash} "Open commit ${hash}")`;
                },
              );
            })
            .join("");
        })
        .join("");
    })
    .join("");
}

export function parseGitCommitLink(href?: string | null): string | undefined {
  if (!href || !href.startsWith(GIT_COMMIT_LINK_SCHEME)) return undefined;
  const hash = href.slice(GIT_COMMIT_LINK_SCHEME.length).trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return undefined;
  return hash;
}

export function extractFirstCommitMention(text: string): string | undefined {
  if (!text || !/[0-9a-f]{7,40}/i.test(text)) return undefined;
  const fencedChunks = text.split(/(```[\s\S]*?```)/g);
  for (let idx = 0; idx < fencedChunks.length; idx += 1) {
    if (idx % 2 === 1) continue;
    for (const span of splitMarkdownLinkLikeSpans(fencedChunks[idx])) {
      if (span.protected) continue;
      const inlineChunks = span.text.split(/(`[^`\n]*`)/g);
      for (let jdx = 0; jdx < inlineChunks.length; jdx += 1) {
        const part = inlineChunks[jdx];
        if (jdx % 2 === 1) {
          const m = INLINE_COMMIT_CODE_RE.exec(part);
          const hash = m?.[1];
          const subject = m?.[2]?.trim();
          if (hash && shouldAutoLinkCommitHash(hash, { subject })) {
            return hash.toLowerCase();
          }
          continue;
        }
        const re = /\b[0-9a-f]{7,40}\b/gi;
        let match: RegExpExecArray | null = null;
        while ((match = re.exec(part)) != null) {
          const hash = match[0];
          const offset = match.index;
          const before = part[offset - 1] ?? "";
          const after = part[offset + hash.length] ?? "";
          if (/[-/=?&#:]/.test(before) || /[-/=?&#:]/.test(after)) {
            continue;
          }
          if (!shouldAutoLinkCommitHash(hash)) {
            continue;
          }
          return hash.toLowerCase();
        }
      }
    }
  }
  return undefined;
}

export function resolveMessageGitBrowserRequest({
  messageThreadId,
  date,
  activityBasePath,
  renderedMessageValue,
  commitHash,
}: {
  messageThreadId?: string;
  date: number;
  activityBasePath?: string;
  renderedMessageValue: string;
  commitHash?: string;
}): {
  threadKey: string;
  cwdOverride?: string;
  commitHash: string;
} {
  return {
    threadKey: messageThreadId ?? `${date}`,
    cwdOverride: activityBasePath,
    commitHash:
      commitHash ?? extractFirstCommitMention(renderedMessageValue) ?? HEAD_REF,
  };
}
