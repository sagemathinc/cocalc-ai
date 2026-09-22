import { Redirect, Stack } from "expo-router";
import { ScrollView } from "react-native";
import { Markdown } from "../chat/markdown";
import { previewEnabled } from "../preview/fixtures";

export default function MarkdownPreview() {
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
        <Markdown
          value={
            '```python\nprint("A long line of code to check wrapping on a narrow phone screen.")\n```\n\n## Results\n\n| Check | Count |\n|:---|---:|\n| Passed | 42 |\n| Failed | 0 |\n\n- **Readable** text with an inline `variable`.\n- Nested items:\n  - First item\n  - Second item\n\n> A quoted explanation.\n\n[Documentation](https://cocalc.ai)'
          }
        />
      </ScrollView>
    </>
  );
}
