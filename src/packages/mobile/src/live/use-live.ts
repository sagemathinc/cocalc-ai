/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { ChatSnapshot } from "@cocalc/chat-client";
import { LiveProgressContext } from "@cocalc/chat-client/live-progress";
import type {
  LiveVoiceRequest,
  LiveVoiceResult,
} from "@cocalc/conat/hub/api/live-voice";
import { getActiveSiteSession } from "../cocalc/session-registry";
import { isPreviewProfile, type ConversationClient } from "../preview/fixtures";
import { LiveDelegation, type LiveEvent } from "./delegation";
import {
  connectPreviewLive,
  previewLiveCapabilities,
  type PreviewScenario,
} from "./preview";
import { connectLive, type LiveConnection } from "./native";

export function useLiveVoice(
  profile: string,
  project: string,
  thread: string,
  client: ConversationClient | undefined,
  snapshot: ChatSnapshot,
) {
  const [capabilities, setCapabilities] = useState<LiveVoiceResult>();
  const [fundingPreference, setFundingPreference] = useState<"site" | "own">(
    "site",
  );
  const [phase, setPhase] = useState<"idle" | "connecting" | "live">("idle");
  const [captionSpeaker, setCaptionSpeaker] = useState<"You" | "Voice">("You");
  const speaker = useRef<"You" | "Voice">("You");
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string>();
  const [muted, setMuted] = useState(false);
  const [proactive, setProactive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const active = useRef<
    | {
        abort: AbortController;
        bridge: LiveDelegation;
        progress: LiveProgressContext;
        connection?: LiveConnection;
      }
    | undefined
  >(undefined);
  const current = useRef({ client, snapshot });
  current.current = { client, snapshot };
  const rpc = useCallback(
    async (request: Omit<LiveVoiceRequest, "project_id">) => {
      const site = await getActiveSiteSession(profile);
      return await site.hubApi.system.liveVoice({
        ...request,
        project_id: project,
      });
    },
    [profile, project],
  );
  const fundedRpc = useCallback(
    (request: Omit<LiveVoiceRequest, "project_id">) =>
      rpc({ ...request, funding_preference: fundingPreference }),
    [rpc, fundingPreference],
  );
  const end = useCallback(() => {
    const call = active.current;
    active.current = undefined;
    call?.bridge.close();
    call?.progress.close();
    call?.abort.abort();
    if (call?.connection)
      void call.connection
        .close()
        .then(() => fundedRpc({ action: "capabilities" }))
        .then(setCapabilities)
        .catch(() => {
          if (!active.current)
            setError("Call disconnected. Server cleanup is pending.");
        });
    if (call) setStatus("Call ended. Accepted work remains in chat.");
    setPhase("idle");
    setMuted(false);
    setCaption("");
  }, [fundedRpc]);
  useEffect(() => {
    let cancelled = false;
    setCapabilities(undefined);
    if (isPreviewProfile(profile)) {
      setCapabilities(previewLiveCapabilities);
    } else {
      void fundedRpc({ action: "capabilities" })
        .then((value) => {
          if (!cancelled) setCapabilities(value);
        })
        .catch(() => {}); // Older servers do not advertise live voice.
    }
    return () => {
      cancelled = true;
      end();
    };
  }, [fundedRpc, profile, thread, end]);
  useFocusEffect(useCallback(() => () => end(), [end]));
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (
        state === "background" ||
        (state === "inactive" && active.current?.connection)
      )
        end();
    });
    return () => {
      listener.remove();
      end();
    };
  }, [end]);
  useEffect(() => {
    if (
      active.current &&
      snapshot.selected_thread_id &&
      snapshot.selected_thread_id !== thread
    ) {
      end();
      return;
    }
    active.current?.bridge.observe(snapshot.messages);
    if (active.current?.connection)
      active.current.progress.observe(snapshot, thread);
  }, [snapshot, thread, end]);
  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [phase]);

  const start = async () => {
    if (active.current || !capabilities?.enabled) return;
    const clientAtStart = current.current.client;
    if (!clientAtStart || current.current.snapshot.connection !== "connected")
      return;
    setError(undefined);
    setCaption("");
    setStatus("");
    setSeconds(0);
    setPhase("connecting");
    const progress = new LiveProgressContext(
      (type, content, id) => {
        call.connection?.send({ type, content, delegation_id: id });
      },
      proactive,
      true,
    );
    const bridge = new LiveDelegation(
      async (text) => {
        if (
          current.current.client !== clientAtStart ||
          current.current.snapshot.connection !== "connected" ||
          (current.current.snapshot.selected_thread_id != null &&
            current.current.snapshot.selected_thread_id !== thread)
        )
          throw new Error(
            "The chat or selected agent changed. Start a new voice call.",
          );
        if (!isPreviewProfile(profile)) {
          const config = current.current.snapshot.threads.find(
            (t) => t.thread_id === thread,
          )?.acp_config;
          const site = await getActiveSiteSession(profile);
          const payment = await site.hubApi.system.getCodexPaymentSource({
            project_id: project,
            preference: config?.paymentSource ?? "auto",
            credential_id:
              config?.paymentSource === "subscription"
                ? config.credentialId
                : undefined,
          });
          if (payment.source === "none" || payment.unavailableReason)
            throw new Error(
              payment.unavailableReason ||
                "Codex payment is not configured. Select a payment source in agent settings.",
            );
        }
        const running =
          current.current.snapshot.threads.find(
            (item) => item.thread_id === thread,
          )?.state === "running";
        const accepted = await (running
          ? clientAtStart.sendGuidanceToCodexThread({ thread_id: thread, text })
          : clientAtStart.sendToExistingCodexThread({
              thread_id: thread,
              text,
            }));
        return {
          ...accepted,
          kind: running ? ("guidance" as const) : ("work" as const),
        };
      },
      (type, content, delegation_id) => {
        call.connection?.send({ type, content, delegation_id });
      },
      setStatus,
      (text) => progress.answer(text),
    );
    const call = {
      abort: new AbortController(),
      bridge,
      progress,
      connection: undefined as LiveConnection | undefined,
    };
    active.current = call;
    const receive = (event: LiveEvent) => {
      if (active.current !== call) return;
      if (event.type === "error") {
        setError(event.error?.message ?? "Live voice failed.");
        end();
        return;
      }
      if (event.type === "session.closed") {
        setStatus("Call ended. Agent work continues in chat.");
        end();
        return;
      }
      if (event.delta && event.type.includes("_transcript.delta")) {
        const nextSpeaker =
          event.type === "session.input_transcript.delta" ? "You" : "Voice";
        const changed = speaker.current !== nextSpeaker;
        speaker.current = nextSpeaker;
        setCaptionSpeaker(nextSpeaker);
        setCaption((before) =>
          ((changed ? "" : before) + event.delta).slice(-350),
        );
      }
      void bridge
        .event(event)
        .then(() => {
          bridge.observe(current.current.snapshot.messages);
          progress.observe(current.current.snapshot, thread);
        })
        .catch(() => {
          setError("Could not process a voice request.");
        });
    };
    try {
      const history = current.current.snapshot.messages
        .filter(
          (message) =>
            ["human", "agent"].includes(message.role) &&
            !message.generating &&
            message.content,
        )
        .slice(-8)
        .map((message) => ({
          role:
            message.role === "human"
              ? ("user" as const)
              : ("assistant" as const),
          text: message.content.slice(0, 900),
        }));
      const connection = isPreviewProfile(profile)
        ? await connectPreviewLive(call.abort.signal, receive)
        : await connectLive(
            fundedRpc,
            history,
            call.abort.signal,
            receive,
            (status) =>
              setCapabilities((previous) => ({ ...previous, ...status })),
          );
      if (active.current !== call) {
        await connection.close();
        return;
      }
      call.connection = connection;
      progress.observe(current.current.snapshot, thread);
      setPhase("live");
      setStatus(
        isPreviewProfile(profile)
          ? "Silent simulation · use Simulate spoken task. Replies appear as captions."
          : "Listening. Spoken tasks are sent to this agent.",
      );
    } catch (err) {
      if (active.current !== call) return;
      setError(err instanceof Error ? err.message : String(err));
      end();
    }
  };
  return {
    preview: isPreviewProfile(profile),
    simulate: (scenario: PreviewScenario) =>
      active.current?.connection?.simulate?.(scenario),
    capabilities,
    fundingPreference,
    chooseFunding: (preference: "site" | "own") => {
      if (active.current) return;
      setFundingPreference(preference);
    },
    phase,
    caption,
    captionSpeaker,
    status,
    error,
    muted,
    proactive,
    seconds,
    start,
    end,
    toggleMute: () => {
      const next = !muted;
      active.current?.connection?.mute(next);
      setMuted(next);
    },
    toggleAnnouncements: () => {
      const next = !proactive;
      setProactive(next);
      active.current?.progress.setProactive(next);
    },
  };
}
