/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Plain Markdown versions of the built-in policies, made from the same React
// elements the policy pages render, so the two cannot disagree. The hub serves
// them at /policies/<slug>.md and lists them in /llms.txt, so agents and other
// clients without JavaScript can read the policies.
//
// This walks the element tree; it does not render React. Every element type a
// policy uses must be handled here: an unknown component is an error, so a new
// one cannot silently drop text from the Markdown.

import { Col, Row } from "antd";
import { Fragment, isValidElement, type ReactNode } from "react";

import {
  A,
  PolicySection,
  PolicySubsection,
  type PolicyHeadingProps,
  type PublicPolicy,
} from "./policy";

// Elements whose content is laid out as blocks (paragraphs, lists, tables).
const BLOCK_TAGS = new Set([
  "div",
  "hr",
  "iframe",
  "ol",
  "p",
  "section",
  "table",
  "ul",
]);
const INLINE_TAGS = new Set(["b", "br", "code", "em", "i", "span", "strong"]);
const BLOCK_COMPONENTS = new Set<unknown>([
  Col,
  PolicySection,
  PolicySubsection,
  Row,
]);

function props(node: ReactNode): Record<string, any> {
  return (isValidElement(node) ? node.props : {}) as Record<string, any>;
}

function isBlock(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  const { type } = node;
  if (type === Fragment) return childList(props(node).children).some(isBlock);
  return typeof type === "string"
    ? BLOCK_TAGS.has(type)
    : BLOCK_COMPONENTS.has(type);
}

function childList(children: ReactNode): ReactNode[] {
  if (children == null || typeof children === "boolean") return [];
  if (Array.isArray(children)) return children.flatMap(childList);
  return [children];
}

function elementName(node: ReactNode): string {
  if (!isValidElement(node)) return typeof node;
  const { type } = node as { type: any };
  return typeof type === "string"
    ? `<${type}>`
    : `<${type?.displayName ?? type?.name ?? "component"}>`;
}

// Text as Markdown: the characters that could start Markdown syntax are
// escaped, and runs of whitespace (source line breaks) become one space.
function escapeText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
}

function inline(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") {
    return escapeText(`${node}`);
  }
  if (Array.isArray(node)) return node.map(inline).join("");
  if (!isValidElement(node)) {
    throw new Error(`policy Markdown: unsupported node ${elementName(node)}`);
  }
  const { children } = props(node);
  const { type } = node;
  if (type === Fragment || type === "span") return inline(children);
  if (type === A || type === "a") {
    const text = inline(children).trim();
    const { href } = props(node);
    return href ? `[${text}](${href})` : text;
  }
  if (type === "b" || type === "strong") return wrap(inline(children), "**");
  if (type === "i" || type === "em") return wrap(inline(children), "*");
  if (type === "code") return `\`${textOf(children)}\``;
  if (type === "br") return "  \n";
  if (type === "img") {
    const { alt, src } = props(node);
    return `![${escapeText(`${alt ?? ""}`)}](${src})`;
  }
  if (typeof type === "string" && !INLINE_TAGS.has(type)) {
    throw new Error(`policy Markdown: ${elementName(node)} inside a paragraph`);
  }
  throw new Error(`policy Markdown: unsupported element ${elementName(node)}`);
}

// Emphasis markers must touch the text they wrap: "** x **" is not bold.
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return match[2]
    ? `${match[1]}${marker}${match[2]}${marker}${match[3]}`
    : text;
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return `${node}`;
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(props(node).children);
}

// A paragraph that starts like a heading, list item or rule is escaped so it
// stays a paragraph.
function paragraph(text: string): string[] {
  const trimmed = text
    .replace(/[ \t]+\n/g, "  \n")
    .trim()
    .replace(/^(#|[-+](?= ))/, "\\$1")
    .replace(/^(\d+)\. /, "$1\\. ");
  return trimmed ? [trimmed] : [];
}

// Inline runs between block children become paragraphs.
function blocks(children: ReactNode): string[] {
  const out: string[] = [];
  let run: ReactNode[] = [];
  const flush = () => {
    out.push(...paragraph(run.map(inline).join("")));
    run = [];
  };
  for (const child of childList(children)) {
    if (isBlock(child)) {
      flush();
      out.push(...block(child));
    } else {
      run.push(child);
    }
  }
  flush();
  return out;
}

function indent(text: string, by: string): string {
  return text.replace(/\n(?!\n)/g, `\n${by}`);
}

function list(children: ReactNode, ordered: boolean): string[] {
  const items = childList(children).filter(
    (child) => !(typeof child === "string" && !child.trim()),
  );
  const lines = items.map((item, index) => {
    if (!isValidElement(item) || item.type !== "li") {
      throw new Error(
        `policy Markdown: ${elementName(item)} directly inside a list`,
      );
    }
    const marker = ordered ? `${index + 1}. ` : "- ";
    const body = blocks(props(item).children).join("\n\n");
    return `${marker}${indent(body, " ".repeat(marker.length))}`;
  });
  return lines.length ? [lines.join("\n")] : [];
}

function tableCell(node: ReactNode): string {
  return inline(props(node).children)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

function table(children: ReactNode): string[] {
  const rows: string[][] = [];
  const visit = (node: ReactNode) => {
    for (const child of childList(node)) {
      if (!isValidElement(child)) continue;
      if (child.type === "tr") {
        rows.push(
          childList(props(child).children)
            .filter((cell) => isValidElement(cell))
            .map(tableCell),
        );
      } else {
        visit(props(child).children);
      }
    }
  };
  visit(children);
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  return [
    [
      line(rows[0]),
      line(Array.from({ length: width }, () => "---")),
      ...rows.slice(1).map(line),
    ].join("\n"),
  ];
}

function heading(level: number, node: ReactNode): string[] {
  const { children, title } = props(node) as PolicyHeadingProps;
  return [
    `${"#".repeat(level)} ${escapeText(title).trim()}`,
    ...blocks(children),
  ];
}

function block(node: ReactNode): string[] {
  if (!isValidElement(node)) return paragraph(inline(node));
  const { children } = props(node);
  const { type } = node;
  if (type === PolicySection) return heading(2, node);
  if (type === PolicySubsection) return heading(3, node);
  if (type === "p") return paragraph(inline(children));
  if (type === "ul" || type === "ol") return list(children, type === "ol");
  if (type === "table") return table(children);
  if (type === "hr") return ["---"];
  // A decorative third-party widget (the GDPR badge), not policy text.
  if (type === "iframe") return [];
  if (
    type === Fragment ||
    type === "div" ||
    type === "section" ||
    type === Row ||
    type === Col
  ) {
    return blocks(children);
  }
  throw new Error(`policy Markdown: unsupported element ${elementName(node)}`);
}

export function policyMarkdown(policy: PublicPolicy): string {
  return `${[
    `# ${escapeText(policy.title).trim()}`,
    `Last Updated: ${policy.updated}`,
    ...blocks(policy.content),
  ].join("\n\n")}\n`;
}
