/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import "../runtime/install-globals";
import "react-native-gesture-handler";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: "minimal",
          headerLargeTitle: true,
        }}
      />
      <StatusBar style="auto" />
    </>
  );
}
