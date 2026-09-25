/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import { useMemo, useState, type ReactNode } from "react";
import { parseDocument } from "htmlparser2";
import { Linking, Pressable, Text, View } from "react-native";
import { MathFormula } from "./math";
import { MarkdownImage } from "./markdown-image";
import { usePalette } from "../ui/palette";

export function Details({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const colors = usePalette();
  return (
    <View style={{ marginVertical: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={typeof title === "string" ? title : "Details"}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={{ color: colors.link, fontSize: 16 }}>
          {open ? "▾ " : "▸ "}
          {title}
        </Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

// Parse HTML as data. Only explicit native presentation components are created;
// scripts, styles, event handlers, embeds, and arbitrary CSS are never executed.
export function MarkdownHtml({
  source,
  slots = [],
}: {
  source: string;
  slots?: ReactNode[];
}) {
  const colors = usePalette();
  const document = useMemo(() => parseDocument(source), [source]);
  function render(nodes: typeof document.children): ReactNode {
    return nodes.map((node, i) => {
      if (node.type === "text") return node.data;
      if (node.type !== "tag") return null;
      const { name, attribs, children } = node;
      if (["script", "style", "iframe", "object", "embed"].includes(name))
        return null;
      if (name === "cocalc-slot")
        return <Text key={i}>{slots[Number(attribs.index)]}</Text>;
      if (name === "br") return "\n";
      if (name === "img")
        return (
          <MarkdownImage
            key={i}
            src={attribs.src ?? ""}
            alt={attribs.alt ?? ""}
          />
        );
      if (name === "a") {
        const href = attribs.href ?? "";
        const allowed = /^(https?:\/\/|mailto:)/i.test(href);
        return (
          <Text
            key={i}
            accessibilityRole={allowed ? "link" : undefined}
            style={
              allowed
                ? { color: colors.link, textDecorationLine: "underline" }
                : undefined
            }
            onPress={
              allowed
                ? () => {
                    void Linking.openURL(href).catch(() => {});
                  }
                : undefined
            }
          >
            {render(children)}
          </Text>
        );
      }
      if (
        ["sup", "sub"].includes(name) &&
        children.every((child) => child.type === "text")
      ) {
        const text = children
          .map((child) => (child.type === "text" ? child.data : ""))
          .join("");
        if (/^[\p{L}\p{N} .,+()=-]+$/u.test(text)) {
          return (
            <MathFormula
              key={i}
              latex={`{}${name === "sup" ? "^" : "_"}{\\text{${text}}}`}
              inline
            />
          );
        }
      }
      const style = {
        color: colors.text,
        ...(["b", "strong"].includes(name)
          ? { fontWeight: "bold" as const }
          : {}),
        ...(["i", "em"].includes(name) ? { fontStyle: "italic" as const } : {}),
        ...(name === "u" ? { textDecorationLine: "underline" as const } : {}),
        ...(["s", "del", "strike"].includes(name)
          ? { textDecorationLine: "line-through" as const }
          : {}),
        ...(["code", "kbd", "pre"].includes(name)
          ? { fontFamily: "monospace", backgroundColor: colors.page }
          : {}),
        ...(["sup", "sub", "small"].includes(name) ? { fontSize: 12 } : {}),
      };
      return (
        <Text key={i} style={style}>
          {["p", "div", "tr", "li"].includes(name) ? "\n" : ""}
          {render(children)}
        </Text>
      );
    });
  }
  return <>{render(document.children)}</>;
}
