import path from "node:path";
import fs from "node:fs";
import type { InlineCodeLink } from "@cocalc/chat";
export type { InlineCodeLink };

interface ParsedInlineCodePath {
  rawPath: string;
  line?: number;
  col?: number;
}

interface ResolveInlineCodeLinksOptions {
  markdown: string;
  workspaceRoot?: string;
  hostWorkspaceRoot?: string;
  maxLinks?: number;
}

const MAX_INLINE_CODE_LINKS = 64;

export function resolveInlineCodeLinks(
  opts: ResolveInlineCodeLinksOptions,
): InlineCodeLink[] {
  const workspaceRootForDisplay = normalizeAbsPath(
    opts.hostWorkspaceRoot ?? opts.workspaceRoot,
  );
  const realWorkspaceRoot = workspaceRootForDisplay
    ? safeRealpath(workspaceRootForDisplay)
    : undefined;
  const maxLinks = opts.maxLinks ?? MAX_INLINE_CODE_LINKS;
  const out: InlineCodeLink[] = [];
  const seen = new Set<string>();
  for (const code of extractInlineCodeSpans(opts.markdown)) {
    if (out.length >= maxLinks) break;
    const parsed = parseInlineCodePath(code);
    if (!parsed) continue;
    const hostPath = candidateToHostPath({
      candidatePath: parsed.rawPath,
      workspaceRoot: opts.workspaceRoot,
      hostWorkspaceRoot: opts.hostWorkspaceRoot,
      hostWorkspaceRootResolved: realWorkspaceRoot,
    });
    if (!hostPath) continue;
    const resolved = safeRealpath(hostPath);
    if (!resolved) continue;
    if (realWorkspaceRoot && !isInsideRoot(resolved, realWorkspaceRoot)) {
      // Never auto-link files outside the configured workspace root.
      continue;
    }
    const stat = safeStat(resolved);
    if (!stat?.isFile()) continue;
    const key = `${code}\u0000${resolved}\u0000${parsed.line ?? ""}\u0000${parsed.col ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const displayPath = toDisplayPath({
      sourcePath: parsed.rawPath,
      absPath: resolved,
      workspaceRoot: realWorkspaceRoot,
    });
    out.push({
      code,
      abs_path: resolved,
      display_path_at_turn: displayPath,
      workspace_root_at_turn: realWorkspaceRoot,
      line: parsed.line,
      col: parsed.col,
    });
  }
  return out;
}

function extractInlineCodeSpans(markdown: string): string[] {
  if (!markdown) return [];
  const spans: string[] = [];
  const re = /`([^`\n]+)`/g;
  let match;
  while ((match = re.exec(markdown)) != null) {
    const content = match[1];
    if (content && content.trim()) {
      spans.push(content);
    }
  }
  return spans;
}

function parseInlineCodePath(code: string): ParsedInlineCodePath | undefined {
  const trimmed = code.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  let rawPath = trimmed;
  let line: number | undefined;
  let col: number | undefined;

  const hash = trimmed.match(/^(.*)#L(\d+)(?:C(\d+))?$/);
  if (hash) {
    rawPath = hash[1];
    line = Number(hash[2]);
    col = hash[3] ? Number(hash[3]) : undefined;
  } else {
    const colon = trimmed.match(/^(.*):(\d+)(?::(\d+))?$/);
    if (colon) {
      rawPath = colon[1];
      line = Number(colon[2]);
      col = colon[3] ? Number(colon[3]) : undefined;
    }
  }

  if (!rawPath || /\0/.test(rawPath)) return undefined;
  if (line != null && (!Number.isFinite(line) || line < 1)) return undefined;
  if (col != null && (!Number.isFinite(col) || col < 1)) return undefined;
  return { rawPath, line, col };
}

function candidateToHostPath({
  candidatePath,
  workspaceRoot,
  hostWorkspaceRoot,
  hostWorkspaceRootResolved,
}: {
  candidatePath: string;
  workspaceRoot?: string;
  hostWorkspaceRoot?: string;
  hostWorkspaceRootResolved?: string;
}): string | undefined {
  const normalizedCandidate = path.normalize(candidatePath);
  if (path.isAbsolute(normalizedCandidate)) {
    // Map container absolute paths to host paths when roots differ.
    if (
      workspaceRoot &&
      hostWorkspaceRoot &&
      hostWorkspaceRootResolved &&
      workspaceRoot !== hostWorkspaceRoot
    ) {
      const normalizedWorkspace = path.normalize(workspaceRoot);
      if (isInsideRoot(normalizedCandidate, normalizedWorkspace)) {
        const rel = path.relative(normalizedWorkspace, normalizedCandidate);
        return path.resolve(hostWorkspaceRootResolved, rel);
      }
    }
    return path.resolve(normalizedCandidate);
  }
  if (!hostWorkspaceRootResolved) return undefined;
  return path.resolve(hostWorkspaceRootResolved, normalizedCandidate);
}

function normalizeAbsPath(value?: string): string | undefined {
  if (!value) return undefined;
  return path.resolve(value);
}

function safeRealpath(value: string): string | undefined {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return undefined;
  }
}

function safeStat(value: string): fs.Stats | undefined {
  try {
    return fs.statSync(value);
  } catch {
    return undefined;
  }
}

function toDisplayPath({
  sourcePath,
  absPath,
  workspaceRoot,
}: {
  sourcePath: string;
  absPath: string;
  workspaceRoot?: string;
}): string {
  if (path.isAbsolute(sourcePath)) {
    return toPosix(path.normalize(sourcePath));
  }
  if (!workspaceRoot) {
    return toPosix(absPath);
  }
  const rel = path.relative(workspaceRoot, absPath);
  if (!rel || rel === ".") {
    return toPosix(path.basename(absPath));
  }
  if (rel.startsWith("..")) {
    return toPosix(absPath);
  }
  return toPosix(rel);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (!rel) return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
