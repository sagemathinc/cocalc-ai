/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import {
  Fragment,
  createElement,
  lazy,
  Suspense,
  useMemo,
  type JSX,
  type ReactNode,
} from "react";
import { languageForCode } from "./code-language";
import markdownMathPlugin from "./markdown-math-plugin";

const markdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
}).use(markdownMathPlugin);

const LazyKatexMath = lazy(
  () =>
    new Promise<{ default: typeof import("./katex-math").default }>(
      (resolve, reject) => {
        require.ensure(
          [],
          () => resolve({ default: require("./katex-math").default }),
          reject,
          "ultralite-katex-component",
        );
      },
    ),
);

const LazyHighlightedCode = lazy(
  () =>
    new Promise<{ default: typeof import("./highlighted-code").default }>(
      (resolve, reject) => {
        if (process.env.COCALC_TEST_MODE) {
          resolve({ default: require("./highlighted-code").default });
          return;
        }
        require.ensure(
          [],
          () => resolve({ default: require("./highlighted-code").default }),
          reject,
          "ultralite-prism-renderer",
        );
      },
    ),
);

function safeHref(value?: string | null): string | undefined {
  const href = `${value ?? ""}`.trim();
  if (!href) return;
  if (href.startsWith("/") || href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? href
      : undefined;
  } catch {
    return;
  }
}

function findClose(tokens: Token[], start: number): number {
  const open = tokens[start];
  let depth = 0;
  for (let i = start + 1; i < tokens.length; i += 1) {
    if (tokens[i].type === open.type) depth += 1;
    if (tokens[i].type === open.type.replace(/_open$/, "_close")) {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return tokens.length;
}

function elementFor(token: Token): keyof JSX.IntrinsicElements | undefined {
  switch (token.type) {
    case "paragraph_open":
      return "p";
    case "blockquote_open":
      return "blockquote";
    case "bullet_list_open":
      return "ul";
    case "ordered_list_open":
      return "ol";
    case "list_item_open":
      return "li";
    case "em_open":
      return "em";
    case "strong_open":
      return "strong";
    case "s_open":
      return "del";
    case "table_open":
      return "table";
    case "thead_open":
      return "thead";
    case "tbody_open":
      return "tbody";
    case "tr_open":
      return "tr";
    case "th_open":
      return "th";
    case "td_open":
      return "td";
    case "heading_open":
      return token.tag as keyof JSX.IntrinsicElements;
    default:
      return;
  }
}

function renderTokens(tokens: Token[], prefix = "md"): ReactNode[] {
  const nodes: ReactNode[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const key = `${prefix}-${i}`;
    if (token.nesting === 1) {
      const close = findClose(tokens, i);
      const children = renderTokens(tokens.slice(i + 1, close), key);
      if (token.type === "link_open") {
        const href = safeHref(token.attrGet("href"));
        nodes.push(
          href ? (
            <a
              href={href}
              key={key}
              rel={href.startsWith("http") ? "noreferrer" : undefined}
              target={href.startsWith("http") ? "_blank" : undefined}
            >
              {children}
            </a>
          ) : (
            <Fragment key={key}>{children}</Fragment>
          ),
        );
      } else {
        const tag = elementFor(token);
        nodes.push(
          tag ? (
            <Fragment key={key}>
              {createElementSafe(tag, token, children)}
            </Fragment>
          ) : (
            <Fragment key={key}>{children}</Fragment>
          ),
        );
      }
      i = close;
      continue;
    }
    switch (token.type) {
      case "inline":
        nodes.push(
          <Fragment key={key}>
            {renderTokens(token.children ?? [], `${key}-inline`)}
          </Fragment>,
        );
        break;
      case "text":
        nodes.push(token.content);
        break;
      case "softbreak":
        nodes.push("\n");
        break;
      case "hardbreak":
        nodes.push(<br key={key} />);
        break;
      case "code_inline":
        nodes.push(<code key={key}>{token.content}</code>);
        break;
      case "fence":
      case "code_block": {
        const language = languageForCode(token.info, token.content);
        nodes.push(
          <Suspense
            fallback={
              <pre className="ul-md-code">
                <code>{token.content}</code>
              </pre>
            }
            key={key}
          >
            <LazyHighlightedCode
              className="ul-md-code"
              contents={token.content}
              language={language}
            />
          </Suspense>,
        );
        break;
      }
      case "math_inline":
      case "math_display":
        nodes.push(
          <Suspense fallback={<code>{token.content}</code>} key={key}>
            <LazyKatexMath
              display={token.type === "math_display"}
              source={token.content}
            />
          </Suspense>,
        );
        break;
      case "image": {
        const href = safeHref(token.attrGet("src"));
        const label = token.content || token.attrGet("alt") || "image";
        nodes.push(
          href ? (
            <a href={href} key={key} rel="noreferrer" target="_blank">
              [Image: {label}]
            </a>
          ) : (
            <span key={key}>[Image: {label}]</span>
          ),
        );
        break;
      }
      case "hr":
        nodes.push(<hr key={key} />);
        break;
      case "html_inline":
      case "html_block":
        nodes.push(token.content);
        break;
      default:
        if (token.content) nodes.push(token.content);
    }
  }
  return nodes;
}

function createElementSafe(
  tag: keyof JSX.IntrinsicElements,
  token: Token,
  children: ReactNode[],
): ReactNode {
  const props: Record<string, unknown> = {};
  if (tag === "ol") {
    const start = Number(token.attrGet("start"));
    if (Number.isFinite(start) && start !== 1) props.start = start;
  }
  if (tag === "th" || tag === "td") {
    const style = token.attrGet("style");
    const align = style?.match(/text-align:\s*(left|center|right)/)?.[1];
    if (align) props.style = { textAlign: align };
  }
  return createElement(tag, props, children);
}

export function Markdown({ source }: { source: string }) {
  const tokens = useMemo(() => markdown.parse(source, {}), [source]);
  return <div className="ul-markdown">{renderTokens(tokens)}</div>;
}

export { safeHref };
