/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useState } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";
import { usePalette } from "../ui/palette";
import type { useLiveVoice } from "./use-live";

export function LiveVoiceControls({
  live,
  disabled,
}: {
  live: ReturnType<typeof useLiveVoice>;
  disabled: boolean;
}) {
  const colors = usePalette();
  const [confirming, setConfirming] = useState(false);
  if (!live.capabilities?.enabled) return null;
  const button = (label: string, onPress: () => void, off = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={{
        padding: 10,
        minHeight: 44,
        flexShrink: 1,
        opacity: off ? 0.5 : 1,
      }}
    >
      <Text style={{ color: colors.link }}>{label}</Text>
    </Pressable>
  );
  return (
    <View style={{ paddingVertical: 4 }}>
      {live.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.danger }}>
          {live.error}
        </Text>
      ) : null}
      {live.phase === "idle" && live.status ? (
        <Text accessibilityLiveRegion="polite" style={{ color: colors.muted }}>
          {live.status}
        </Text>
      ) : null}
      {live.phase === "idle" ? (
        confirming ? (
          <View>
            <Text style={{ color: colors.text }}>
              {live.preview
                ? "Silent local simulation. No microphone, audio playback, network, or charges. Use Simulate spoken task; replies appear as captions."
                : `Live voice preview · $${live.capabilities.usd_per_minute.toFixed(2)}/minute billed to your ${live.capabilities.funding_source} OpenAI key. Up to ${live.capabilities.max_seconds / 60} minutes per call; agent work costs extra. Spoken tasks are sent to this chat. Leaving the app ends the call.`}
            </Text>
            {button(
              live.preview ? "Start silent simulation" : "Start live call",
              () => {
                setConfirming(false);
                Keyboard.dismiss();
                void live.start();
              },
              disabled,
            )}
            {button("Not now", () => setConfirming(false))}
          </View>
        ) : (
          button("Live voice", () => setConfirming(true), disabled)
        )
      ) : (
        <View>
          <Text style={{ color: colors.text }}>
            {live.phase === "connecting"
              ? "Connecting live voice…"
              : `${live.preview ? "Silent simulation" : "Live"} · ${Math.floor(live.seconds / 60)}:${String(live.seconds % 60).padStart(2, "0")} · ${live.preview ? "example cost " : "≈"}$${((Math.max(15, live.seconds) / 60) * live.capabilities.usd_per_minute).toFixed(3)}`}
          </Text>
          <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>
            {live.status}
          </Text>
          {live.caption ? (
            <Text numberOfLines={3} style={{ color: colors.muted }}>
              {live.captionSpeaker}: {live.caption}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {live.phase === "live" &&
              button(
                live.muted ? "Unmute microphone" : "Mute microphone",
                live.toggleMute,
              )}
            {button("End live call", live.end)}
          </View>
          {live.preview && live.phase === "live" ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {button(
                "Simulate spoken task",
                () => live.simulate("task"),
                live.muted,
              )}
              {button("Simulate disconnect", () => live.simulate("disconnect"))}
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}
