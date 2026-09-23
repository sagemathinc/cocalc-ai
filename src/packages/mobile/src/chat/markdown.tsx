/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { memo, useMemo, useState, type ReactNode } from "react";
import { parse_markdown } from "@cocalc/util/markdown/parse";
import type Token from "markdown-it/lib/token";
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import type { AppearancePalette } from "@cocalc/util/appearance-palette";
import { HighlightedCode } from "./code-highlight";
import { Details, MarkdownHtml } from "./markdown-html";
import { MarkdownImage } from "./markdown-image";
import { MathFormula } from "./math";
import { usePalette } from "../ui/palette";

interface Node {
  token: Token;
  children: Node[];
}
function tree(tokens: Token[]): Node[] {
  const root: Node[] = [],
    stack = [root];
  for (const token of tokens) {
    if (token.nesting === -1) {
      stack.pop();
      continue;
    }
    const node = {
      token,
      children: token.children ? tree(token.children) : [],
    };
    stack.at(-1)!.push(node);
    if (token.nesting === 1) stack.push(node.children);
  }
  return groupDetails(root);
}
function groupDetails(nodes: Node[]): Node[] {
  const result: Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (
      node.token.type === "html_block" &&
      /^<details(?:\s[^>]*)?>\s*(?:<summary>[\s\S]*?<\/summary>\s*)?$/i.test(
        node.token.content.trim(),
      )
    ) {
      let depth = 1,
        end = i + 1;
      for (; end < nodes.length; end++) {
        if (nodes[end].token.type !== "html_block") continue;
        if (/^<details[\s>]/i.test(nodes[end].token.content.trim())) depth++;
        if (/<\/details>/i.test(nodes[end].token.content)) depth--;
        if (!depth) break;
      }
      if (!depth && /^\s*<\/details>\s*$/i.test(nodes[end].token.content)) {
        result.push({
          token: {
            ...node.token,
            type: "details",
            content:
              node.token.content.match(
                /<summary>([\s\S]*?)<\/summary>/i,
              )?.[1] ?? "Details",
          } as Token,
          children: groupDetails(nodes.slice(i + 1, end)),
        });
        i = end;
        continue;
      }
    }
    result.push(node);
  }
  return result;
}
export const Markdown = memo(function Markdown({ value }: { value: string }) {
  const colors = usePalette();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const nodes = useMemo(() => tree(parse_markdown(value).tokens), [value]);
  function render(nodes: Node[]): ReactNode {
    // Inline HTML can wrap Markdown tokens (e.g. <u>**bold**</u>).
    if (nodes.some((node) => node.token.type === "html_inline")) {
      const slots: ReactNode[] = [];
      const source = nodes
        .map((node) => {
          if (node.token.type === "html_inline") return node.token.content;
          const index = slots.push(render([node])) - 1;
          return `<cocalc-slot index="${index}"></cocalc-slot>`;
        })
        .join("");
      return <MarkdownHtml source={source} slots={slots} />;
    }
    return nodes.map(({ token: t, children }, index) => {
      const body = () => render(children);
      switch (t.type) {
        case "html_block":
          return (
            <Text key={index} selectable style={styles.text}>
              <MarkdownHtml source={t.content} />
            </Text>
          );
        case "details":
          return (
            <Details key={index} title={t.content || "Details"}>
              {body()}
            </Details>
          );
        case "emoji":
        case "html_inline":
        case "text":
          return t.content;
        case "hashtag":
          return (
            <Text key={index} style={styles.tag}>
              {`#${t.content}`}
            </Text>
          );
        case "mention":
          return (
            <Text key={index} style={styles.tag}>
              {`@${(t as Token & { name: string }).name}`}
            </Text>
          );
        case "agent-mention":
          return (
            <Text key={index} style={styles.tag}>
              {`@${(t as Token & { reference: { name: string } }).reference.name}`}
            </Text>
          );
        case "checkbox_input": {
          const checked = t.attrGet("checked") === "true";
          return (
            <Text
              key={index}
              accessibilityLabel={checked ? "Completed" : "Not completed"}
            >
              {checked ? "☑" : "☐"}
            </Text>
          );
        }
        case "math_inline":
        case "math_inline_double":
          return (
            <MathFormula
              key={index}
              latex={t.content}
              inline
              display={t.type === "math_inline_double"}
            />
          );
        case "math_block":
          return <MathFormula key={index} latex={t.content} display />;
        case "blank_line":
          return <View key={index} style={{ height: 8 }} />;
        case "softbreak":
          return " ";
        case "hardbreak":
          return "\n";
        case "code_inline":
          return (
            <Text key={index} style={styles.inlineCode}>
              {t.content}
            </Text>
          );
        case "strong_open":
          return (
            <Text key={index} style={styles.bold}>
              {body()}
            </Text>
          );
        case "em_open":
          return (
            <Text key={index} style={styles.italic}>
              {body()}
            </Text>
          );
        case "s_open":
          return (
            <Text key={index} style={styles.strike}>
              {body()}
            </Text>
          );
        case "link_open": {
          const href = t.attrGet("href") ?? "";
          const allowed = /^(https?:\/\/|mailto:)/i.test(href);
          return (
            <Text
              key={index}
              accessibilityRole={allowed ? "link" : undefined}
              style={allowed ? styles.link : undefined}
              onPress={
                allowed
                  ? () => {
                      void Linking.openURL(href).catch(() => {});
                    }
                  : undefined
              }
            >
              {body()}
            </Text>
          );
        }
        case "image":
          return (
            <MarkdownImage
              key={index}
              src={t.attrGet("src") ?? ""}
              alt={t.content}
            />
          );
        case "inline":
          return (
            <Text key={index} selectable style={styles.text}>
              {body()}
            </Text>
          );
        case "paragraph_open":
          return (
            <View key={index} style={styles.paragraph}>
              {body()}
            </View>
          );
        case "heading_open":
          return (
            <Text
              key={index}
              selectable
              accessibilityRole="header"
              style={[
                styles.text,
                styles.heading,
                { fontSize: t.tag === "h1" ? 25 : t.tag === "h2" ? 22 : 19 },
              ]}
            >
              {render(
                children.flatMap((child) =>
                  child.token.type === "inline" ? child.children : [child],
                ),
              )}
            </Text>
          );
        case "fence":
        case "code_block":
          return (
            <CodeBlock key={index} content={t.content} language={t.info} />
          );
        case "bullet_list_open":
        case "ordered_list_open":
          return (
            <View key={index} style={styles.list}>
              {children.map((child, n) => (
                <View key={n} style={styles.listRow}>
                  <Text style={styles.text}>
                    {t.type === "ordered_list_open"
                      ? `${(Number(t.attrGet("start")) || 1) + n}.`
                      : "•"}
                  </Text>
                  <View style={styles.listBody}>{render(child.children)}</View>
                </View>
              ))}
            </View>
          );
        case "blockquote_open":
          return (
            <View key={index} style={styles.quote}>
              {body()}
            </View>
          );
        case "hr":
          return <View key={index} style={styles.rule} />;
        case "table_open":
          return (
            <ScrollView
              key={index}
              horizontal
              style={styles.horizontalScroll}
              accessibilityLabel="Scrollable table"
            >
              <View>{body()}</View>
            </ScrollView>
          );
        case "tr_open":
          return (
            <View key={index} style={styles.tableRow}>
              {body()}
            </View>
          );
        case "th_open":
        case "td_open":
          return (
            <View
              key={index}
              style={[styles.cell, t.type === "th_open" && styles.tableHeading]}
            >
              <Text
                selectable
                accessibilityRole={t.type === "th_open" ? "header" : undefined}
                style={[
                  styles.text,
                  t.type === "th_open" && styles.bold,
                  {
                    textAlign: t.attrGet("style")?.includes("right")
                      ? "right"
                      : t.attrGet("style")?.includes("center")
                        ? "center"
                        : "left",
                  },
                ]}
              >
                {render(
                  children.flatMap((child) =>
                    child.token.type === "inline" ? child.children : [child],
                  ),
                )}
              </Text>
            </View>
          );
        default:
          return (
            <View key={index}>
              {children.length ? (
                body()
              ) : (
                <Text selectable style={styles.text}>
                  {t.content}
                </Text>
              )}
            </View>
          );
      }
    });
  }
  return <View style={styles.container}>{render(nodes)}</View>;
});
function CodeBlock({
  content,
  language,
}: {
  content: string;
  language: string;
}) {
  const colors = usePalette();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [wrap, setWrap] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const code = (
    <Text selectable style={styles.codeText}>
      <HighlightedCode
        content={content.replace(/\n$/, "")}
        language={language}
      />
    </Text>
  );
  return (
    <View style={styles.code}>
      <View style={styles.codeHeader}>
        <Text style={styles.language}>
          {language.trim().split(/\s+/)[0] || "Code"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={wrap ? "Unwrap code" : "Wrap code"}
          accessibilityState={{ selected: wrap }}
          onPress={() => setWrap(!wrap)}
          style={styles.copy}
        >
          <Text style={styles.link}>{wrap ? "Unwrap code" : "Wrap code"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code block"
          onPress={async () => {
            setCopyStatus("Copying…");
            try {
              await Clipboard.setStringAsync(content);
              setCopyStatus("Copied");
            } catch {
              setCopyStatus("Could not copy code. Select the text to copy it.");
            }
          }}
          style={styles.copy}
        >
          <Text style={styles.link}>Copy code</Text>
        </Pressable>
      </View>
      {copyStatus ? (
        <Text accessibilityLiveRegion="polite" style={styles.language}>
          {copyStatus}
        </Text>
      ) : null}
      {wrap ? (
        code
      ) : (
        <ScrollView
          horizontal
          style={styles.horizontalScroll}
          accessibilityLabel="Scrollable code block"
        >
          {code}
        </ScrollView>
      )}
    </View>
  );
}
const makeStyles = (colors: AppearancePalette) =>
  StyleSheet.create({
    container: { gap: 8, minWidth: 0 },
    horizontalScroll: { flexGrow: 0, flexShrink: 0 },
    text: { color: colors.text, fontSize: 16, lineHeight: 24 },
    paragraph: { marginBottom: 6 },
    heading: { fontWeight: "700", marginTop: 8, lineHeight: undefined },
    bold: { fontWeight: "700" },
    italic: { fontStyle: "italic" },
    tag: {
      color: colors.link,
      backgroundColor: colors.page,
      fontWeight: "600",
    },
    strike: { textDecorationLine: "line-through" },
    inlineCode: {
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 14,
      backgroundColor: colors.page,
    },
    code: {
      backgroundColor: colors.page,
      borderRadius: 10,
      padding: 10,
      gap: 8,
    },
    codeHeader: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
    },
    language: { color: colors.secondary, fontSize: 13 },
    copy: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
    codeText: {
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      fontSize: 14,
      lineHeight: 22,
      color: colors.text,
    },
    link: { color: colors.link, textDecorationLine: "underline" },
    list: { gap: 4 },
    listRow: { flexDirection: "row", gap: 8 },
    listBody: { flex: 1, minWidth: 0 },
    quote: {
      borderLeftWidth: 3,
      borderLeftColor: colors.border,
      paddingLeft: 12,
    },
    rule: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: 8,
    },
    tableRow: { flexDirection: "row" },
    cell: {
      width: 180,
      padding: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    tableHeading: { backgroundColor: colors.page },
  });
