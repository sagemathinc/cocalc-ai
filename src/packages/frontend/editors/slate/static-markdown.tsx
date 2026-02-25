/*
Static Markdown

This is a react component that renders markdown text using React.  See the
comments in mostly-static-markdown.tsx for more details, since that's a very
similar, but more complicated component.

A constraint of this component is that it should easily render in the next.js
application.
*/

import { CSSProperties, useEffect, useState } from "react";
import type { InlineCodeLink } from "@cocalc/chat";
import "./elements/init-ssr";
import { getStaticRender } from "./elements/register";
import Leaf from "./leaf";
import { markdown_to_slate as markdownToSlate } from "./markdown-to-slate";
import { ChangeContext } from "./use-change";

interface Props {
  value: string;
  style?: CSSProperties;
  className?: string;
  inlineCodeLinks?: InlineCodeLink[];
  inlineCodeWorkspaceRoot?: string;
  highlightQuery?: string;
}

type PartialSlateEditor = any; // TODO

export default function StaticMarkdown({
  value,
  style,
  className,
  inlineCodeLinks,
  inlineCodeWorkspaceRoot,
  highlightQuery,
}: Props) {
  const [editor, setEditor] = useState<PartialSlateEditor>({
    children: applySearchHighlights(
      applyInlineCodeLinks(markdownToSlate(value), {
        inlineCodeLinks,
        inlineCodeWorkspaceRoot,
      }),
      highlightQuery,
    ),
  });
  const [change, setChange] = useState<number>(0);
  useEffect(() => {
    setChange(change + 1);
    if (change > 0) {
      // no need to set it the first time because it is set in the useState initialization.
      // and we *have* to set it there so it works for server side rendering and exporting to html/pdf.
      setEditor({
        children: applySearchHighlights(
          applyInlineCodeLinks(markdownToSlate(value), {
            inlineCodeLinks,
            inlineCodeWorkspaceRoot,
          }),
          highlightQuery,
        ),
      });
    }
  }, [value, inlineCodeLinks, inlineCodeWorkspaceRoot, highlightQuery]);

  if (editor == null) {
    return null;
  }

  return (
    <ChangeContext.Provider
      value={{
        change,
        editor,
        setEditor: (editor) => {
          setEditor(editor);
          setChange(change + 1);
        },
      }}
    >
      <div style={{ width: "100%", ...style }} className={className}>
        {editor.children.map((element, n) => {
          return <RenderElement key={n} element={element} />;
        })}
      </div>
    </ChangeContext.Provider>
  );
}

function applySearchHighlights(children: any[], query?: string): any[] {
  const needle = normalizeHighlightQuery(query);
  if (!needle) return children;
  return transformSearchNodes(children, needle);
}

function normalizeHighlightQuery(value?: string): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function transformSearchNodes(nodes: any[], needle: string): any[] {
  const out: any[] = [];
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") {
      out.push(node);
      continue;
    }
    if (typeof node.type === "string") {
      const nextChildren = Array.isArray(node.children)
        ? transformSearchNodes(node.children, needle)
        : node.children;
      out.push({ ...node, children: nextChildren });
      continue;
    }
    if (typeof node.text === "string") {
      out.push(...splitSearchTextNode(node, needle));
      continue;
    }
    out.push(node);
  }
  return out;
}

function splitSearchTextNode(node: any, needle: string): any[] {
  const text = node.text as string;
  if (!text || !needle) return [node];
  const lower = text.toLowerCase();
  let index = 0;
  let found = lower.indexOf(needle, index);
  if (found < 0) return [node];
  const pieces: any[] = [];
  while (found >= 0) {
    if (found > index) {
      pieces.push({ ...node, text: text.slice(index, found), search: undefined });
    }
    const end = found + needle.length;
    pieces.push({ ...node, text: text.slice(found, end), search: true });
    index = end;
    found = lower.indexOf(needle, index);
  }
  if (index < text.length) {
    pieces.push({ ...node, text: text.slice(index), search: undefined });
  }
  return pieces.length ? pieces : [node];
}

function applyInlineCodeLinks(
  children: any[],
  {
    inlineCodeLinks,
    inlineCodeWorkspaceRoot,
  }: {
    inlineCodeLinks?: InlineCodeLink[];
    inlineCodeWorkspaceRoot?: string;
  },
): any[] {
  const lookup = createInlineCodeLinkLookup(
    inlineCodeLinks,
    inlineCodeWorkspaceRoot,
  );
  if (lookup.size === 0) return children;
  return transformInlineCodeNodes(children, lookup);
}

function transformInlineCodeNodes(
  nodes: any[],
  lookup: Map<string, { href: string; display: string; title: string }>,
): any[] {
  return (nodes ?? []).map((node) => {
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "string") {
      const nextChildren = Array.isArray(node.children)
        ? transformInlineCodeNodes(node.children, lookup)
        : node.children;
      return { ...node, children: nextChildren };
    }
    if (node.code !== true || typeof node.text !== "string") return node;
    const key = normalizeInlineCodeKey(node.text);
    const linked = lookup.get(key);
    if (!linked) return node;
    return {
      type: "link",
      isInline: true,
      url: linked.href,
      title: linked.title,
      children: [{ ...node, text: linked.display }],
    };
  });
}

function createInlineCodeLinkLookup(
  inlineCodeLinks?: InlineCodeLink[],
  inlineCodeWorkspaceRoot?: string,
): Map<string, { href: string; display: string; title: string }> {
  const lookup = new Map<
    string,
    { href: string; display: string; title: string }
  >();
  for (const link of inlineCodeLinks ?? []) {
    const codeKey = normalizeInlineCodeKey(link?.code);
    const absPath = normalizeAbsolutePath(link?.abs_path);
    if (!codeKey || !absPath) continue;
    const display = formatInlineCodeDisplay(link, inlineCodeWorkspaceRoot);
    const title = formatInlineCodeTitle(link);
    const href = buildInlineCodeHref({
      absPath,
      line:
        link.line != null && Number.isFinite(link.line) && link.line > 0
          ? Math.trunc(link.line)
          : undefined,
      col:
        link.col != null && Number.isFinite(link.col) && link.col > 0
          ? Math.trunc(link.col)
          : undefined,
    });
    lookup.set(codeKey, { href, display, title });
  }
  return lookup;
}

function normalizeInlineCodeKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeProjectPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized;
}

function normalizeAbsolutePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//")
  ) {
    return normalized;
  }
  return "";
}

function buildInlineCodeHref({
  absPath,
  line,
  col,
}: {
  absPath: string;
  line?: number;
  col?: number;
}): string {
  const params = new URLSearchParams({ path: absPath });
  if (line != null) params.set("line", `${line}`);
  if (col != null) params.set("col", `${col}`);
  return `cocalc-file://open?${params.toString()}`;
}

function formatInlineCodeDisplay(
  link: InlineCodeLink,
  inlineCodeWorkspaceRoot?: string,
): string {
  const suffix = formatLineSuffix(link);
  const displayAtTurn =
    typeof link.display_path_at_turn === "string"
      ? link.display_path_at_turn.trim()
      : "";
  if (displayAtTurn) {
    return `${displayAtTurn}${suffix}`;
  }
  const absPath = typeof link.abs_path === "string" ? link.abs_path.trim() : "";
  const workspaceRoot =
    typeof inlineCodeWorkspaceRoot === "string"
      ? inlineCodeWorkspaceRoot.trim()
      : "";
  if (absPath && workspaceRoot) {
    const rel = relativePosix(workspaceRoot, absPath);
    if (rel && !rel.startsWith("../")) {
      return `${rel}${suffix}`;
    }
  }
  const fallback = normalizeProjectPath(link.project_path) || absPath || link.code;
  return `${fallback}${suffix}`;
}

function formatInlineCodeTitle(link: InlineCodeLink): string {
  const absPath = typeof link.abs_path === "string" ? link.abs_path.trim() : "";
  const fallback =
    (typeof link.display_path_at_turn === "string"
      ? link.display_path_at_turn.trim()
      : "") ||
    normalizeProjectPath(link.project_path) ||
    link.code;
  return `${absPath || fallback}${formatLineSuffix(link)}`;
}

function formatLineSuffix(link: Pick<InlineCodeLink, "line" | "col">): string {
  if (link.line == null || !Number.isFinite(link.line) || link.line < 1) return "";
  const line = Math.trunc(link.line);
  if (link.col == null || !Number.isFinite(link.col) || link.col < 1) {
    return `:${line}`;
  }
  return `:${line}:${Math.trunc(link.col)}`;
}

function relativePosix(root: string, target: string): string {
  const rootNorm = normalizePosix(root);
  const targetNorm = normalizePosix(target);
  if (!rootNorm || !targetNorm) return "";
  const rootParts = rootNorm.split("/").filter(Boolean);
  const targetParts = targetNorm.split("/").filter(Boolean);
  let i = 0;
  while (
    i < rootParts.length &&
    i < targetParts.length &&
    rootParts[i] === targetParts[i]
  ) {
    i += 1;
  }
  const up = rootParts.length - i;
  const down = targetParts.slice(i);
  const rel = [
    ...Array.from({ length: up }, () => ".."),
    ...down,
  ].join("/");
  return rel || ".";
}

function normalizePosix(value: string): string {
  const x = value.replace(/\\/g, "/");
  const parts = x.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return (x.startsWith("/") ? "/" : "") + out.join("/");
}

function RenderElement({ element }) {
  if (element["type"]) {
    const C = getStaticRender(element.type);
    // Math nodes render their own preview; avoid separately rendering children
    // to prevent double-rendering of raw LaTeX text.
    if (
      element.type === "math_inline" ||
      element.type === "math_inline_double" ||
      element.type === "math_block" ||
      element.type === "math_block_eqno"
    ) {
      return <C children={[]} element={element} attributes={{} as any} />;
    }
    let children: React.JSX.Element[] = [];
    if (element["children"]) {
      let n = 0;
      for (const child of element["children"]) {
        children.push(<RenderElement key={n} element={child} />);
        n += 1;
      }
    }
    return <C children={children} element={element} attributes={{} as any} />;
  }
  // It's text
  return (
    <Leaf leaf={element} text={{} as any} attributes={{} as any}>
      {element["text"]}
    </Leaf>
  );
}
