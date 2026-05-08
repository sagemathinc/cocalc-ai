/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const GIT_COMMIT_LINK_SCHEME = "cocalc-commit://";
const COMMIT_HASH_BOUNDARY_RE = /\b[0-9a-f]{7,40}\b/gi;
const INLINE_COMMIT_CODE_RE = /^`([0-9a-f]{7,40})(?:\s+([^\n`]*\S))?`$/i;
const HEAD_REF = "HEAD";

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
      const inlineChunks = chunk.split(/(`[^`\n]*`)/g);
      return inlineChunks
        .map((part, jdx) => {
          if (jdx % 2 === 1) {
            // Inline code span. Codex often writes "`hash subject`"; link the
            // hash while leaving the subject as plain text.
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
    const inlineChunks = fencedChunks[idx].split(/(`[^`\n]*`)/g);
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
