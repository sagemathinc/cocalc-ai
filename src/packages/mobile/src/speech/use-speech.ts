/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { SpeechController } from "./controller";
import { nativeSpeechAdapter } from "./native";
import { isPreviewProfile } from "../preview/fixtures";
import { previewSpeechAdapter } from "./preview";

export function useSpeech(
  profile: string,
  project: string,
  path: string,
  thread: string,
  onTranscript: (text: string) => void,
) {
  const receive = useRef(onTranscript);
  receive.current = onTranscript;
  const controller = useMemo(
    () =>
      new SpeechController(
        isPreviewProfile(profile)
          ? previewSpeechAdapter()
          : nativeSpeechAdapter(profile, project, path, thread),
        (text) => receive.current(text),
      ),
    [profile, project, path, thread],
  );
  useFocusEffect(useCallback(() => () => controller.cancel(), [controller]));
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "background") controller.cancel();
    });
    return () => {
      listener.remove();
      controller.cancel();
    };
  }, [controller]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { controller, state };
}
