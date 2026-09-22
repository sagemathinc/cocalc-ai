/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useMemo, useState, type ReactNode } from "react";
import MarkdownIt from "markdown-it";
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
import { usePalette } from "../ui/palette";

const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
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
  return root;
}
export function Markdown({ value }: { value: string }) {
  const colors = usePalette();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const nodes = useMemo(() => tree(parser.parse(value, {})), [value]);
  function render(nodes: Node[]): ReactNode {
    return nodes.map(({ token: t, children }, index) => {
      const body = () => render(children);
      switch (t.type) {
        case "text":
          return t.content;
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
          const allowed = /^https?:\/\//i.test(href);
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
            <Text key={index} style={styles.italic}>
              [Image: {t.content || "attachment"}]
            </Text>
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
}
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
      {content.replace(/\n$/, "")}
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
