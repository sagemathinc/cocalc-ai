/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import "../runtime/install-globals";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from "expo-router";
import { useColorScheme } from "react-native";
import { StatusBar } from "expo-status-bar";

import { usePalette } from "../ui/palette";

export default function RootLayout() {
  const colors = usePalette();
  const baseTheme = useColorScheme() === "dark" ? DarkTheme : DefaultTheme;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider
        value={{
          ...baseTheme,
          colors: {
            ...baseTheme.colors,
            primary: colors.link,
            background: colors.page,
            card: colors.page,
            text: colors.text,
            border: colors.border,
          },
        }}
      >
        <Stack
          screenOptions={{
            headerBackButtonDisplayMode: "minimal",
            headerLargeTitle: false,
            headerStyle: { backgroundColor: colors.page },
            headerTintColor: colors.text,
            contentStyle: { backgroundColor: colors.page },
          }}
        />
        <StatusBar style="auto" />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
