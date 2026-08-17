/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";
import { Linking, PlatformColor, StyleSheet, Text, View } from "react-native";

const INLINE = /(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

function InlineMarkdown({ value }: { value: string }) {
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
  const blocks = value.split(/(```[\s\S]*?```)/g).filter(Boolean);
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

const styles = StyleSheet.create({
  container: { gap: 8 },
  text: {
    color: PlatformColor("label"),
    fontSize: 16,
    lineHeight: 23,
  },
  inlineCode: {
    backgroundColor: PlatformColor("tertiarySystemBackground"),
    fontFamily: "Menlo",
    fontSize: 14,
  },
  codeBlock: {
    backgroundColor: PlatformColor("tertiarySystemBackground"),
    borderRadius: 8,
    color: PlatformColor("label"),
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 19,
    overflow: "hidden",
    padding: 12,
  },
  link: { color: COLORS.ANTD_LINK_BLUE, textDecorationLine: "underline" },
});
