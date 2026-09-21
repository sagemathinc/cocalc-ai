/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { AppearancePalette } from "@cocalc/util/appearance-palette";
import { usePalette } from "../ui/palette";
import { Linking, StyleSheet, Text, View } from "react-native";

const INLINE = /(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

function InlineMarkdown({ value }: { value: string }) {
  const styles = makeStyles(usePalette());
  const parts = value.split(INLINE);
  return (
    <Text selectable style={styles.text}>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <Text key={index} style={styles.inlineCode}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        if (link) {
          return (
            <Text
              accessibilityRole="link"
              key={index}
              onPress={() => void Linking.openURL(link[2])}
              style={styles.link}
            >
              {link[1]}
            </Text>
          );
        }
        return part;
      })}
    </Text>
  );
}

export function Markdown({ value }: { value: string }) {
  const styles = makeStyles(usePalette());
  const blocks = value
    .split(/(```[\s\S]*?```)/g)
    .map((block) => block.trim())
    .filter(Boolean);
  return (
    <View style={styles.container}>
      {blocks.map((block, index) => {
        if (block.startsWith("```") && block.endsWith("```")) {
          const content = block
            .replace(/^```[^\n]*\n?/, "")
            .replace(/```$/, "");
          return (
            <Text key={index} selectable style={styles.codeBlock}>
              {content}
            </Text>
          );
        }
        return <InlineMarkdown key={index} value={block} />;
      })}
    </View>
  );
}

const makeStyles = (colors: AppearancePalette) =>
  StyleSheet.create({
    container: { gap: 8 },
    text: {
      color: colors.text,
      fontSize: 16,
      lineHeight: 23,
    },
    inlineCode: {
      backgroundColor: colors.page,
      fontFamily: "Menlo",
      fontSize: 14,
    },
    codeBlock: {
      backgroundColor: colors.page,
      borderRadius: 8,
      color: colors.text,
      fontFamily: "Menlo",
      fontSize: 13,
      lineHeight: 19,
      overflow: "hidden",
      padding: 12,
    },
    link: { color: colors.link, textDecorationLine: "underline" },
  });
