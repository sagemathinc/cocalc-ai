/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { Col, Row } from "antd";
import { CANONICAL_PUBLIC_SITE_ORIGIN } from "@cocalc/util/public-site-policy";
import {
  A,
  PolicySection,
  PolicySubsection,
  type PublicPolicy,
} from "./policy";

function escapeText(text: string): string {
  return text.replace(/[\\`*_\[\]<>|]/g, "\\$&");
}

function absoluteHref(href: string): string {
  return href.startsWith("/") ? `${CANONICAL_PUBLIC_SITE_ORIGIN}${href}` : href;
}

// Serialize the authored document tree, never the surrounding UI or embedded
// verification scripts. Unknown components fail the build rather than losing
// policy text silently.
function markdown(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return escapeText(String(child));
      if (!isValidElement(child)) return "";
      const { children, title, href, src, alt, start } = child.props as {
        children?: ReactNode;
        title?: string;
        href?: string;
        src?: string;
        alt?: string;
        start?: number;
      };
      const type = child.type;
      if (type === PolicySection || type === PolicySubsection) {
        return `\n\n${type === PolicySection ? "##" : "###"} ${escapeText(title!)}\n\n${markdown(children)}`;
      }
      if (type === Fragment || type === Row || type === Col || type === "span")
        return markdown(children);
      if (type === A || type === "a") {
        return href
          ? `[${markdown(children)}](${absoluteHref(href).replace(/\(/g, "%28").replace(/\)/g, "%29")})`
          : markdown(children);
      }
      if (type === "p" || type === "div")
        return `\n\n${markdown(children)}\n\n`;
      if (type === "b" || type === "strong") return `**${markdown(children)}**`;
      if (type === "i" || type === "em") return `*${markdown(children)}*`;
      if (type === "code") {
        const text = Children.toArray(children)
          .map((value) => {
            if (typeof value !== "string" && typeof value !== "number")
              throw Error("Unexpected policy code content");
            return String(value);
          })
          .join("");
        const fence = "`".repeat(
          Math.max(
            0,
            ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
          ) + 1,
        );
        return `${fence} ${text} ${fence}`;
      }
      if (type === "br") return "  \n";
      if (type === "hr") return "\n\n---\n\n";
      if (type === "img")
        return `![${escapeText(alt ?? "")}](${absoluteHref(src ?? "")})`;
      if (type === "iframe") return title ? `\n\n${escapeText(title)}\n\n` : "";
      if (type === "ul" || type === "ol") {
        return (
          "\n\n" +
          Children.toArray(children)
            .filter((item) => typeof item !== "string" || item.trim() !== "")
            .map((item, index) => {
              if (
                !isValidElement<{ children?: ReactNode }>(item) ||
                item.type !== "li"
              )
                throw Error("Unexpected policy list item");
              const prefix = type === "ol" ? `${(start ?? 1) + index}. ` : "- ";
              return (
                prefix +
                markdown(item.props.children)
                  .trim()
                  .replace(/\n/g, "\n" + " ".repeat(prefix.length))
              );
            })
            .join("\n") +
          "\n\n"
        );
      }
      if (type === "table") return `\n\n${markdown(children)}\n\n`;
      if (type === "thead" || type === "tbody") return markdown(children);
      if (type === "tr") {
        const cells = Children.toArray(children).filter(
          isValidElement<{ children?: ReactNode }>,
        );
        const row =
          "| " +
          cells
            .map((cell) => markdown(cell.props.children).trim())
            .join(" | ") +
          " |\n";
        return cells.some((cell) => cell.type === "th")
          ? row + "| " + cells.map(() => "---").join(" | ") + " |\n"
          : row;
      }
      throw Error(`Unsupported policy element: ${String(type)}`);
    })
    .join("");
}

export function policyMarkdown(policy: PublicPolicy): string {
  return (
    (
      `# ${escapeText(policy.title)}\n\nLast Updated: ${policy.updated}\n\n` +
      markdown(policy.content)
    )
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}
