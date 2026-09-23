/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import { useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import Prism from "prismjs";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-julia";
import "prismjs/components/prism-r";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-latex";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-diff";
import { usePalette } from "../ui/palette";
const aliases: Record<string, string> = {
  py: "python",
  sage: "python",
  sh: "bash",
  shell: "bash",
  js: "javascript",
  ts: "typescript",
  tex: "latex",
  yml: "yaml",
};
export function HighlightedCode({
  content,
  language,
}: {
  content: string;
  language: string;
}) {
  const colors = usePalette();
  const tokens = useMemo(() => {
    const name = language.trim().split(/\s+/)[0].toLowerCase();
    const grammar = Prism.languages[aliases[name] ?? name];
    // Avoid holding up streaming/scrolling on enormous code blocks.
    return grammar && content.length <= 30000
      ? Prism.tokenize(content, grammar)
      : [content];
  }, [content, language]);
  function render(
    value: string | Prism.Token | (string | Prism.Token)[],
  ): ReactNode {
    if (typeof value === "string") return value;
    if (Array.isArray(value))
      return value.map((token, i) => <Text key={i}>{render(token)}</Text>);
    const color = ["comment", "prolog"].includes(value.type)
      ? colors.secondary
      : ["string", "char", "inserted"].includes(value.type)
        ? colors.success
        : ["number", "boolean", "constant"].includes(value.type)
          ? colors.warning
          : ["deleted"].includes(value.type)
            ? colors.danger
            : ["keyword", "function", "class-name", "tag"].includes(value.type)
              ? colors.link
              : colors.text;
    return <Text style={{ color }}>{render(value.content)}</Text>;
  }
  return <>{render(tokens)}</>;
}
