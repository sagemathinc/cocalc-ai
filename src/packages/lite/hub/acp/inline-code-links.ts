import path from "node:path";
import fs from "node:fs";

export interface InlineCodeLink {
  code: string;
  abs_path: string;
  project_path: string;
  line?: number;
  col?: number;
}

interface ParsedInlineCodePath {
  rawPath: string;
  line?: number;
  col?: number;
}

interface ResolveInlineCodeLinksOptions {
  markdown: string;
  workspaceRoot?: string;
  hostWorkspaceRoot?: string;
  projectRoot?: string;
  maxLinks?: number;
}

const MAX_INLINE_CODE_LINKS = 64;

export function findProjectRootFromChatPath({
  hostWorkspaceRoot,
  chatPath,
}: {
  hostWorkspaceRoot?: string;
  chatPath?: string;
}): string | undefined {
  if (!hostWorkspaceRoot || !chatPath) return undefined;
  const normalizedChatPath = chatPath.replace(/^\.\//, "");
  if (!normalizedChatPath) return undefined;
  let current = path.resolve(hostWorkspaceRoot);
  while (true) {
    const candidate = path.join(current, normalizedChatPath);
    if (fs.existsSync(candidate)) {
      return safeRealpath(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

export function resolveInlineCodeLinks(
  opts: ResolveInlineCodeLinksOptions,
): InlineCodeLink[] {
  const workspaceRoot = normalizeAbsPath(
    opts.hostWorkspaceRoot ?? opts.workspaceRoot,
  );
  if (!workspaceRoot) return [];
  const realWorkspaceRoot = safeRealpath(workspaceRoot);
  if (!realWorkspaceRoot) return [];
  const projectRoot = normalizeAbsPath(opts.projectRoot) ?? realWorkspaceRoot;
  const realProjectRoot = safeRealpath(projectRoot) ?? realWorkspaceRoot;
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
    if (!isInsideRoot(resolved, realWorkspaceRoot)) continue;
    const projectPath = toProjectRelativePath(resolved, realProjectRoot);
    if (!projectPath) continue;
    const key = `${code}\u0000${resolved}\u0000${parsed.line ?? ""}\u0000${parsed.col ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code,
      abs_path: resolved,
      project_path: projectPath,
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
  hostWorkspaceRootResolved: string;
}): string | undefined {
  const normalizedCandidate = path.normalize(candidatePath);
  if (path.isAbsolute(normalizedCandidate)) {
    // Map container absolute paths to host paths when roots differ.
    if (
      workspaceRoot &&
      hostWorkspaceRoot &&
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
  return path.resolve(hostWorkspaceRootResolved, normalizedCandidate);
}

function toProjectRelativePath(absPath: string, projectRoot: string): string | undefined {
  if (!isInsideRoot(absPath, projectRoot)) return undefined;
  const rel = path.relative(projectRoot, absPath);
  if (!rel || rel === ".") return undefined;
  return rel.split(path.sep).join("/");
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

function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (!rel) return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
