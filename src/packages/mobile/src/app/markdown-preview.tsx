import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { Markdown } from "../chat/markdown";
import { previewEnabled } from "../preview/fixtures";

import { MARKDOWN_SAMPLE } from "../preview/markdown-sample";
import { MarkdownImageContext } from "../chat/markdown-image";
const previewImages = async () => require("../../assets/preview-plot.png");
export default function MarkdownPreview() {
  const { sample } = useLocalSearchParams<{ sample?: string }>();
  if (!previewEnabled) return <Redirect href="/" />;
  return (
    <>
      <Stack.Screen options={{ title: "Markdown preview" }} />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          paddingTop: 96,
          paddingBottom: 64,
        }}
      >
        <MarkdownImageContext.Provider value={previewImages}>
          <Markdown
            value={
              sample === "full"
                ? MARKDOWN_SAMPLE
                : sample === "math"
                  ? MARKDOWN_SAMPLE.slice(
                      MARKDOWN_SAMPLE.indexOf("## Inline mathematics"),
                    )
                  : '```python\nprint("A long line of code to check wrapping on a narrow phone screen.")\n```\n\n## Results\n\n| Check | Count |\n|:---|---:|\n| Passed | 42 |\n| Failed | 0 |\n\n- **Readable** text with an inline `variable`.\n- Nested items:\n  - First item\n  - Second item\n\n> A quoted explanation.\n\n[Documentation](https://cocalc.ai)'
            }
          />
        </MarkdownImageContext.Provider>
      </ScrollView>
    </>
  );
}
