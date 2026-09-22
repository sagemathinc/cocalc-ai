/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { Image, Text, View } from "react-native";
import { useFonts } from "expo-font";
import customAliases from "./custom-icon-names.json";
import { useState } from "react";
import {
  AntDesign,
  type AntDesignIconName,
} from "@react-native-vector-icons/ant-design";
import type { AgentAppearance } from "./use-appearance";
import aliases from "./icon-names.json";
import { usePalette } from "../ui/palette";
export function AgentAvatar({
  appearance,
  siteUrl,
  name,
}: {
  appearance?: AgentAppearance;
  siteUrl: string;
  name: string;
}) {
  const colors = usePalette();
  const [fontLoaded] = useFonts({
    CoCalcIcons: require("@cocalc/assets/cocalc-icons-font/cocalc-icons.ttf"),
  });
  const custom = (customAliases as Record<string, string>)[
    appearance?.thread_icon ?? ""
  ];
  const [failedImage, setFailedImage] = useState<string>();
  const blob = appearance?.thread_image;
  const uri =
    blob && siteUrl
      ? `${siteUrl.replace(/\/+$/, "")}/blobs/agent.png?uuid=${encodeURIComponent(blob)}`
      : undefined;
  const icon = (aliases as Record<string, string>)[
    appearance?.thread_icon ?? ""
  ];
  return (
    <View
      accessible={false}
      style={{
        width: 48,
        height: 48,
        borderRadius: 12,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        borderWidth: 2,
        borderColor: appearance?.thread_color || colors.border,
        backgroundColor: appearance?.thread_accent_color || colors.inset,
      }}
    >
      {uri && failedImage !== uri ? (
        <Image
          source={{ uri }}
          onError={() => setFailedImage(uri)}
          style={{ width: 48, height: 48 }}
        />
      ) : icon ? (
        <AntDesign
          name={icon as AntDesignIconName}
          size={26}
          color={appearance?.thread_color || colors.text}
        />
      ) : custom && fontLoaded ? (
        <Text
          style={{
            fontFamily: "CoCalcIcons",
            fontSize: 26,
            color: appearance?.thread_color || colors.text,
          }}
        >
          {custom}
        </Text>
      ) : (
        <Text
          style={{
            color: appearance?.thread_color || colors.text,
            fontSize: 22,
          }}
        >
          {name.slice(0, 1).toUpperCase()}
        </Text>
      )}
    </View>
  );
}
