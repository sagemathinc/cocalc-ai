import { Link, Stack } from "expo-router";
import { Text, View } from "react-native";
import { usePalette } from "../ui/palette";

export default function NotFoundScreen() {
  const colors = usePalette();
  return (
    <View
      style={{ flex: 1, padding: 24, gap: 20, backgroundColor: colors.page }}
    >
      <Stack.Screen options={{ title: "CoCalc" }} />
      <Text
        accessibilityRole="header"
        style={{ color: colors.text, fontSize: 24 }}
      >
        This link could not be opened
      </Text>
      <Text style={{ color: colors.text, fontSize: 17 }}>
        Open your saved accounts to continue chatting with your agents.
      </Text>
      <Link
        href="/"
        replace
        accessibilityRole="button"
        style={{ color: colors.link, fontSize: 18, paddingVertical: 14 }}
      >
        Open saved accounts
      </Link>
    </View>
  );
}
