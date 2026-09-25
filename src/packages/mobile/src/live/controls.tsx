/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { usePalette } from "../ui/palette";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { isPreviewProfile } from "../preview/fixtures";
import type { useLiveVoice } from "./use-live";
import { LIVE_VOICE_POLICY } from "@cocalc/chat-client/live-voice-policy";

function VoicePolicyModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const colors = usePalette();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          padding: 24,
          backgroundColor: colors.scrim,
        }}
      >
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: colors.elevated,
            borderRadius: 16,
            padding: 20,
            gap: 12,
            maxHeight: "85%",
          }}
        >
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>
            How voice works
          </Text>
          <ScrollView contentContainerStyle={{ gap: 12 }}>
            {LIVE_VOICE_POLICY.map(({ title, text }) => (
              <Text key={title} style={{ color: colors.secondary }}>
                <Text style={{ color: colors.text, fontWeight: "700" }}>
                  {title}.{" "}
                </Text>
                {text}
              </Text>
            ))}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close voice explanation"
            onPress={onClose}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text style={{ color: colors.link, fontWeight: "600" }}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function VoiceOrb({ active }: { active: boolean }) {
  const colors = usePalette();
  const pulse = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    if (!active || reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [active, pulse, reduceMotion]);
  return (
    <View
      style={{
        height: 46,
        width: 46,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Animated.View
        style={{
          position: "absolute",
          height: 40,
          width: 40,
          borderRadius: 20,
          backgroundColor: colors.info,
          opacity: pulse.interpolate({
            inputRange: [0, 1],
            outputRange: [0.16, 0.3],
          }),
          transform: [
            {
              scale: pulse.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 1.16],
              }),
            },
          ],
        }}
      />
      <View
        style={{
          height: 28,
          width: 28,
          borderRadius: 14,
          backgroundColor: colors.primary,
          borderColor: colors.infoBg,
          borderWidth: 4,
        }}
      />
    </View>
  );
}

export function LiveVoiceControls({
  live,
  disabled,
  profileId,
  open = true,
  onClose,
  onDictate,
  dictationBusy = false,
}: {
  live: ReturnType<typeof useLiveVoice>;
  disabled: boolean;
  profileId?: string;
  open?: boolean;
  onClose?: () => void;
  onDictate?: () => void;
  dictationBusy?: boolean;
}) {
  const colors = usePalette();
  const [confirming, setConfirming] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const close = () => {
    setConfirming(false);
    onClose?.();
  };
  const button = (
    label: string,
    onPress: () => void,
    off = false,
    variant: "primary" | "secondary" | "link" | "danger" = "secondary",
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off }}
      disabled={off}
      onPress={onPress}
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: variant === "link" ? 4 : 12,
        minHeight: 44,
        borderRadius: 10,
        borderWidth: variant === "link" ? 0 : 1,
        borderColor:
          variant === "danger"
            ? colors.danger
            : variant === "primary"
              ? colors.primary
              : colors.border,
        backgroundColor:
          variant === "primary"
            ? colors.primary
            : variant === "danger"
              ? colors.dangerBg
              : variant === "secondary"
                ? colors.surface
                : "transparent",
        opacity: off ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          color:
            variant === "primary"
              ? colors.onPrimary
              : variant === "danger"
                ? colors.danger
                : variant === "link"
                  ? colors.link
                  : colors.text,
          fontWeight: variant === "link" ? "400" : "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  if (!open && live.phase === "idle") return null;
  if (
    !live.capabilities ||
    live.capabilities.reason === "Live voice is not enabled."
  ) {
    if (!onDictate) return null;
    return (
      <View
        style={{
          backgroundColor: colors.inset,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 14,
          padding: 12,
          gap: 10,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: "700" }}>
          Voice options
        </Text>
        <Text style={{ color: colors.secondary, fontSize: 12 }}>
          Turn a short recording into text for your message.
        </Text>
        <View style={{ alignSelf: "flex-start" }}>
          {button("How this works", () => setShowHow(true), false, "link")}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button("Dictate message", onDictate, disabled || dictationBusy)}
          {onClose && button("Close voice options", close, false, "link")}
        </View>
        <VoicePolicyModal visible={showHow} onClose={() => setShowHow(false)} />
      </View>
    );
  }
  const included = live.capabilities.funding_source === "site";
  const needsMembership =
    !live.capabilities.enabled &&
    !!live.capabilities.reason?.includes("paid membership");
  const active = live.phase !== "idle";
  const heading = !live.capabilities.enabled
    ? needsMembership
      ? "Talk with your agent"
      : "Live voice unavailable"
    : live.phase === "connecting"
      ? "Connecting voice"
      : live.phase === "live"
        ? live.muted
          ? "Microphone muted"
          : "Voice is live"
        : confirming
          ? "Start a voice conversation"
          : "Talk with your agent";
  const openSettings = async (page: "membership" | "ai") => {
    if (!profileId || isPreviewProfile(profileId)) return;
    const session = await getActiveSiteSession(profileId);
    await Linking.openURL(
      `${session.profile.canonical_app_url.replace(/\/+$/, "")}/settings/${page}`,
    );
  };
  const sourceChoice =
    live.phase === "idle" && live.capabilities.own_key_available
      ? live.fundingPreference === "site"
        ? button(
            "Use my OpenAI key",
            () => live.chooseFunding("own"),
            false,
            "link",
          )
        : button(
            "Use included AI instead",
            () => live.chooseFunding("site"),
            false,
            "link",
          )
      : null;
  const meters = included ? (
    <View
      style={{ flexDirection: "row", gap: 12 }}
      accessibilityLabel="Included AI allowance"
    >
      {live.capabilities.allowance?.map((window) => (
        <View key={window.window} style={{ flex: 1, gap: 3 }}>
          <View
            style={{ flexDirection: "row", justifyContent: "space-between" }}
          >
            <Text style={{ color: colors.secondary, fontSize: 11 }}>
              {window.window === "5h" ? "5-hour" : "7-day"}
            </Text>
            <Text
              style={{ color: colors.text, fontSize: 11, fontWeight: "700" }}
            >
              {window.remaining_percent}%
            </Text>
          </View>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`${window.window === "5h" ? "5-hour" : "7-day"} limit`}
            accessibilityValue={{
              min: 0,
              max: 100,
              now: window.remaining_percent,
            }}
            style={{
              height: 5,
              borderRadius: 3,
              backgroundColor: colors.border,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                width: `${Math.max(0, Math.min(100, window.remaining_percent))}%`,
                height: "100%",
                borderRadius: 3,
                backgroundColor: colors.info,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  ) : null;
  return (
    <View
      style={{
        backgroundColor: colors.inset,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 14,
        padding: 12,
        gap: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <VoiceOrb active={active && !live.muted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View
            style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}
          >
            <Text
              style={{ color: colors.text, fontSize: 16, fontWeight: "700" }}
            >
              {heading}
            </Text>
            {active && (
              <Text
                style={{
                  color: colors.secondary,
                  fontVariant: ["tabular-nums"],
                }}
              >
                {Math.floor(live.seconds / 60)}:
                {String(live.seconds % 60).padStart(2, "0")}
              </Text>
            )}
          </View>
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: colors.secondary, fontSize: 12 }}
          >
            {active
              ? live.status ||
                (live.phase === "connecting"
                  ? "Preparing microphone…"
                  : "Listening")
              : confirming
                ? `Uses ${included ? "included AI" : "your OpenAI key"}. CoCalc asks the voice service to stop after ${live.capabilities.max_seconds / 60} minutes. Agent work may continue after the call.`
                : dictationBusy
                  ? "Dictation in progress. Finish or cancel below."
                  : live.capabilities.enabled
                    ? "Choose a live conversation or dictate a message to text."
                    : (live.capabilities.reason ??
                      "Live voice is unavailable.")}
          </Text>
        </View>
      </View>
      {!active && (
        <View style={{ alignSelf: "flex-start" }}>
          {button("How this works", () => setShowHow(true), false, "link")}
        </View>
      )}
      {meters}
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
      {live.caption && active && (
        <Text numberOfLines={2} style={{ color: colors.text, fontSize: 13 }}>
          {live.captionSpeaker}: {live.caption}
        </Text>
      )}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
        }}
      >
        {!live.capabilities.enabled ? (
          needsMembership ? (
            button(
              "Live voice",
              () => setShowUpgrade(true),
              disabled,
              "primary",
            )
          ) : (
            sourceChoice
          )
        ) : live.phase === "idle" ? (
          confirming ? (
            <>
              {button(
                live.preview ? "Start silent simulation" : "Start live call",
                () => {
                  setConfirming(false);
                  Keyboard.dismiss();
                  void live.start();
                },
                disabled,
                "primary",
              )}
              {button("Not now", () => setConfirming(false))}
            </>
          ) : (
            <>
              {button(
                "Live voice",
                () => setConfirming(true),
                disabled,
                "primary",
              )}
              {sourceChoice}
            </>
          )
        ) : (
          <>
            {live.phase === "live" &&
              button(
                live.muted ? "Unmute microphone" : "Mute microphone",
                live.toggleMute,
              )}
            {live.phase === "live" &&
              button(
                live.proactive
                  ? "Use on-demand progress updates"
                  : "Announce progress milestones",
                live.toggleAnnouncements,
              )}
            {button("End live call", live.end, false, "danger")}
          </>
        )}
        {live.phase === "idle" &&
          onDictate &&
          button("Dictate message", onDictate, disabled || dictationBusy)}
        {live.phase === "idle" &&
          onClose &&
          button("Close voice options", close, false, "link")}
      </View>
      {live.preview && live.phase === "live" && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {button(
            "Simulate spoken task",
            () => live.simulate("task"),
            live.muted,
          )}
          {button("Simulate disconnect", () => live.simulate("disconnect"))}
        </View>
      )}
      <Modal
        visible={showUpgrade}
        transparent
        animationType="fade"
        onRequestClose={() => setShowUpgrade(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            padding: 24,
            backgroundColor: colors.scrim,
          }}
        >
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.elevated,
              borderRadius: 16,
              padding: 20,
              gap: 14,
            }}
          >
            <Text
              style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}
            >
              Live voice needs a paid plan or your own API key
            </Text>
            <Text style={{ color: colors.secondary }}>
              Included live voice is available with a paid CoCalc membership.
              You can also use your own OpenAI API key and pay OpenAI directly.
            </Text>
            {settingsError && (
              <Text accessibilityRole="alert" style={{ color: colors.danger }}>
                {settingsError}
              </Text>
            )}
            {button(
              "View membership plans",
              () => {
                void openSettings("membership")
                  .then(() => setShowUpgrade(false))
                  .catch((error) => setSettingsError(String(error)));
              },
              false,
              "primary",
            )}
            {button(
              live.capabilities.own_key_available
                ? "Use my OpenAI key"
                : "Add an OpenAI key",
              () => {
                if (live.capabilities?.own_key_available) {
                  live.chooseFunding("own");
                  setShowUpgrade(false);
                } else {
                  void openSettings("ai")
                    .then(() => setShowUpgrade(false))
                    .catch((error) => setSettingsError(String(error)));
                }
              },
            )}
            {button("Not now", () => setShowUpgrade(false), false, "link")}
          </View>
        </View>
      </Modal>
      <VoicePolicyModal visible={showHow} onClose={() => setShowHow(false)} />
    </View>
  );
}
