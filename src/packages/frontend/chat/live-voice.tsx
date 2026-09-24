/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { Button, Space } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  LiveDelegation,
  type LiveEvent,
  type ProjectedChatMessage,
} from "@cocalc/chat-client";
import type {
  LiveVoiceRequest,
  LiveVoiceResult,
} from "@cocalc/conat/hub/api/live-voice";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { webapp_client } from "@cocalc/frontend/webapp-client";

interface Call {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  audio: HTMLAudioElement;
  bridge: LiveDelegation;
  stream?: MediaStream;
  sessionId?: string;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  rejectStartup?: (error: Error) => void;
  stopped: boolean;
}

async function waitForIce(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("Microphone connection setup timed out."));
    }, 8_000);
    const changed = () => {
      if (peer.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

export async function requestMicrophoneWithTimeout(
  request: () => Promise<MediaStream>,
  timeoutMs = 15_000,
): Promise<MediaStream> {
  const pending = request();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Microphone access timed out. Check your browser and system microphone permissions.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // A permission prompt may resolve after the call has already been closed.
    void pending.then(
      (stream) => stream.getTracks().forEach((track) => track.stop()),
      () => {},
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function ChatLiveVoice({
  projectId,
  messages,
  onDelegate,
  visible,
}: {
  projectId: string;
  messages: ProjectedChatMessage[];
  onDelegate: (text: string) => Promise<{ message_id: string }>;
  visible: boolean;
}) {
  const [fundingPreference, setFundingPreference] = useState<"site" | "own">(
    "site",
  );
  const [capabilities, setCapabilities] = useState<LiveVoiceResult>();
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "live">("idle");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<Call | undefined>(undefined);
  const delegateRef = useRef(onDelegate);
  delegateRef.current = onDelegate;
  const rpc = useCallback(
    (request: Omit<LiveVoiceRequest, "project_id">) =>
      webapp_client.conat_client.hub.system.liveVoice({
        ...request,
        project_id: projectId,
        funding_preference: fundingPreference,
      }),
    [projectId, fundingPreference],
  );
  useEffect(() => {
    let active = true;
    setCapabilities(undefined);
    void rpc({ action: "capabilities" })
      .then((value) => {
        if (active) setCapabilities(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [rpc]);
  useEffect(() => {
    callRef.current?.bridge.observe(messages);
  }, [messages]);
  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [phase]);

  const stop = useCallback(async () => {
    const call = callRef.current;
    if (!call || call.stopped) return;
    call.stopped = true;
    callRef.current = undefined;
    call.rejectStartup?.(new Error("Live call cancelled."));
    call.bridge.close();
    clearInterval(call.heartbeat);
    clearTimeout(call.deadline);
    call.stream?.getTracks().forEach((track) => track.stop());
    call.channel.close();
    call.peer.close();
    call.audio.pause();
    call.audio.srcObject = null;
    setPhase("idle");
    setMuted(false);
    setPlaybackBlocked(false);
    setCaption("");
    setPlaybackBlocked(false);
    if (call.sessionId) {
      try {
        await rpc({ action: "end", session_id: call.sessionId });
        setCapabilities(await rpc({ action: "capabilities" }));
      } catch {
        setError("Call disconnected. Server cleanup is pending.");
      }
    }
  }, [rpc]);
  useEffect(() => {
    if (!visible) void stop();
    return () => void stop();
  }, [visible, stop]);
  useEffect(() => {
    const leave = () => {
      if (document.hidden) void stop();
    };
    const pageHide = () => void stop();
    document.addEventListener("visibilitychange", leave);
    window.addEventListener("pagehide", pageHide);
    return () => {
      document.removeEventListener("visibilitychange", leave);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [stop]);

  const start = async () => {
    if (!capabilities?.enabled || callRef.current) return;
    setConfirming(false);
    setError("");
    setCaption("");
    setSeconds(0);
    setPhase("connecting");
    const peer = new RTCPeerConnection();
    const channel = peer.createDataChannel("oai-events");
    const audio = audioRef.current;
    if (!audio) {
      setPhase("idle");
      setError("Call audio is unavailable in this browser view.");
      return;
    }
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    const bridge = new LiveDelegation(
      (text) => delegateRef.current(text),
      (type, content, delegation_id) => {
        if (channel.readyState === "open")
          channel.send(JSON.stringify({ type, content, delegation_id }));
      },
      setStatus,
    );
    const call: Call = {
      peer,
      channel,
      audio,
      bridge,
      stopped: false,
    };
    callRef.current = call;
    let started!: () => void;
    let failed!: (reason: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    call.rejectStartup = failed;
    void ready.catch(() => {});
    channel.onmessage = (message) => {
      if (call.stopped) return;
      let event: LiveEvent;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (event.type === "session.started") started();
      if (event.type === "error") {
        failed(new Error(event.error?.message ?? "Live voice failed."));
        setError(event.error?.message ?? "Live voice failed.");
        void stop();
        return;
      }
      if (event.type === "session.closed") {
        failed(new Error("Live call ended during startup."));
        setStatus("Call ended. Accepted agent work continues in chat.");
        void stop();
        return;
      }
      if (event.delta && event.type.includes("_transcript.delta")) {
        const speaker =
          event.type === "session.input_transcript.delta" ? "You" : "Voice";
        setCaption(`${speaker}: ${event.delta}`);
      }
      void bridge.event(event).catch(() => {
        setError("Could not process a spoken request.");
      });
    };
    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => {
        setPlaybackBlocked(true);
      });
    };
    peer.onconnectionstatechange = () => {
      if (
        !call.stopped &&
        (peer.connectionState === "failed" ||
          peer.connectionState === "disconnected")
      ) {
        failed(new Error("Live connection lost."));
        setError("Live connection lost. Agent work continues in chat.");
        void stop();
      }
    };
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "This browser cannot use the microphone for live voice.",
        );
      call.stream = await requestMicrophoneWithTimeout(() =>
        navigator.mediaDevices.getUserMedia({ audio: true }),
      );
      if (call.stopped) {
        call.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      for (const track of call.stream.getTracks()) {
        track.enabled = false;
        peer.addTrack(track, call.stream);
      }
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer);
      if (call.stopped) return;
      const history = messages
        .filter(
          (item) =>
            (item.role === "human" || item.role === "agent") &&
            !item.generating &&
            item.content,
        )
        .slice(-8)
        .map((item) => ({
          role:
            item.role === "human" ? ("user" as const) : ("assistant" as const),
          text: item.content.slice(0, 900),
        }));
      const response = await rpc({
        action: "start",
        request_id: crypto.randomUUID(),
        sdp: peer.localDescription?.sdp,
        history,
      });
      call.sessionId = response.session_id;
      if (call.stopped) {
        if (call.sessionId)
          await rpc({ action: "end", session_id: call.sessionId });
        return;
      }
      if (!response.sdp || !response.expires_at || !response.session_id)
        throw new Error("Invalid live voice connection response.");
      await peer.setRemoteDescription({ type: "answer", sdp: response.sdp });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Live voice connection timed out.")),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (call.stopped) return;
      call.stream.getTracks().forEach((track) => (track.enabled = true));
      setPhase("live");
      setStatus("Listening. Spoken tasks are sent to this agent.");
      call.heartbeat = setInterval(() => {
        void rpc({ action: "heartbeat", session_id: call.sessionId })
          .then((value) =>
            setCapabilities((previous) => ({ ...previous, ...value })),
          )
          .catch(() => {
            setError("Live call expired or disconnected.");
            void stop();
          });
      }, 8_000);
      call.deadline = setTimeout(
        () => void stop(),
        Math.max(0, response.expires_at - Date.now()),
      );
    } catch (cause) {
      if (!call.stopped)
        setError(cause instanceof Error ? cause.message : String(cause));
      await stop();
    }
  };

  if (
    !visible ||
    !capabilities ||
    capabilities.reason === "Live voice is not enabled."
  )
    return null;
  const choice =
    capabilities.own_key_available && phase === "idle" ? (
      <Button
        type="link"
        onClick={() =>
          setFundingPreference(fundingPreference === "site" ? "own" : "site")
        }
      >
        {fundingPreference === "site"
          ? "Use my OpenAI key"
          : "Use included AI instead"}
      </Button>
    ) : null;
  return (
    <div style={{ padding: "4px 8px", color: UI_COLORS.text }}>
      <audio
        ref={audioRef}
        autoPlay
        aria-hidden="true"
        style={{ display: "none" }}
      />
      {capabilities.funding_source === "site" && (
        <Space size="middle" wrap>
          {capabilities.allowance?.map((window) => (
            <span key={window.window}>
              {window.window === "5h" ? "5-hour" : "7-day"} AI remaining:{" "}
              {window.remaining_percent}%
            </span>
          ))}
        </Space>
      )}
      {error && (
        <div role="alert" style={{ color: UI_COLORS.danger }}>
          {error}
        </div>
      )}
      {playbackBlocked && phase === "live" && (
        <Button
          onClick={() => {
            void callRef.current?.audio
              .play()
              .then(() => setPlaybackBlocked(false))
              .catch(() =>
                setError("Browser audio playback is still blocked."),
              );
          }}
        >
          Enable call audio
        </Button>
      )}
      {!capabilities.enabled ? (
        <Space wrap>
          <span>{capabilities.reason ?? "Live voice is unavailable."}</span>
          {choice}
        </Space>
      ) : phase === "idle" ? (
        confirming ? (
          <Space direction="vertical">
            <span>
              Live voice uses{" "}
              {capabilities.funding_source === "site"
                ? "your included AI allowance"
                : "your OpenAI API key"}
              . Calls last up to two minutes. Agent work may use a separate
              payment source and continues in chat after hangup.
            </span>
            <Space>
              <Button type="primary" onClick={() => void start()}>
                Start live call
              </Button>
              <Button onClick={() => setConfirming(false)}>Not now</Button>
            </Space>
          </Space>
        ) : (
          <Space>
            <Button onClick={() => setConfirming(true)}>Live voice</Button>
            {choice}
          </Space>
        )
      ) : (
        <Space direction="vertical">
          <span aria-live="polite">
            {phase === "connecting"
              ? "Connecting live voice…"
              : `Live · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
          </span>
          {status && <span aria-live="polite">{status}</span>}
          {caption && <span>{caption}</span>}
          <Space>
            {phase === "live" && (
              <Button
                onClick={() => {
                  const next = !muted;
                  callRef.current?.stream
                    ?.getAudioTracks()
                    .forEach((track) => (track.enabled = !next));
                  setMuted(next);
                }}
              >
                {muted ? "Unmute microphone" : "Mute microphone"}
              </Button>
            )}
            <Button onClick={() => void stop()}>End live call</Button>
          </Space>
        </Space>
      )}
    </div>
  );
}
