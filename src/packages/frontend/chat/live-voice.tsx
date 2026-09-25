/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { Button, Modal, Progress } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSnapshot, ProjectedChatMessage } from "@cocalc/chat-client";
import {
  LiveDelegation,
  type LiveEvent,
} from "@cocalc/chat-client/live-delegation";
import { LIVE_VOICE_POLICY } from "@cocalc/chat-client/live-voice-policy";
import { LiveProgressContext } from "@cocalc/chat-client/live-progress";
import type {
  LiveVoiceRequest,
  LiveVoiceResult,
} from "@cocalc/conat/hub/api/live-voice";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useCodexLog } from "./use-codex-log";
import "./live-voice.css";

interface Call {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  audio: HTMLAudioElement;
  bridge: LiveDelegation;
  progress: LiveProgressContext;
  abort: AbortController;
  stream?: MediaStream;
  sessionId?: string;
  heartbeat?: ReturnType<typeof setInterval>;
  deadline?: ReturnType<typeof setTimeout>;
  rejectStartup?: (error: Error) => void;
  stopped: boolean;
}

function VoicePolicyDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal title="How voice works" open={open} onCancel={onClose} footer={null}>
      {LIVE_VOICE_POLICY.map(({ title, text }) => (
        <p key={title}>
          <strong>{title}.</strong> {text}
        </p>
      ))}
    </Modal>
  );
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
  threadId,
  messages,
  threadRunning,
  onDelegate,
  onInterrupt,
  visible,
  panelOpen = true,
  onClose,
  onDictate,
  dictationBusy = false,
}: {
  projectId: string;
  threadId: string;
  messages: ProjectedChatMessage[];
  threadRunning: boolean;
  onDelegate: (
    text: string,
    isCurrentThread: () => boolean,
    signal: AbortSignal,
  ) => Promise<{ message_id: string; kind?: "guidance" | "work" }>;
  onInterrupt: (
    isCurrentThread: () => boolean,
    signal: AbortSignal,
  ) => Promise<boolean>;
  visible: boolean;
  panelOpen?: boolean;
  onClose?: () => void;
  onDictate?: () => void;
  dictationBusy?: boolean;
}) {
  const [fundingPreference, setFundingPreference] = useState<"site" | "own">(
    "site",
  );
  const [capabilities, setCapabilities] = useState<LiveVoiceResult>();
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "live">("idle");
  const [muted, setMuted] = useState(false);
  const [proactive, setProactive] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<Call | undefined>(undefined);
  const generationRef = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const delegateRef = useRef({ threadId, onDelegate, onInterrupt });
  delegateRef.current = { threadId, onDelegate, onInterrupt };
  const runningAgent = [...messages]
    .reverse()
    .find((message) => message.role === "agent" && message.generating);
  const activity = useCodexLog({
    projectId,
    liveLogStream: runningAgent?.acp_live_preview_stream,
    liveStreamIsProjection: true,
    generating: !!runningAgent,
    enabled:
      visible && phase !== "idle" && !!runningAgent?.acp_live_preview_stream,
  });
  const progressSnapshot: ChatSnapshot = {
    revision: 0,
    connection: visible ? "connected" : "disconnected",
    ready: true,
    project_id: projectId,
    path: "",
    selected_thread_id: threadId,
    threads: [
      {
        thread_id: threadId,
        state: threadRunning
          ? "running"
          : messages.at(-1)?.state === "error"
            ? "error"
            : messages.at(-1)?.state === "interrupted"
              ? "interrupted"
              : "complete",
        active_message_id: runningAgent?.message_id,
      },
    ],
    messages: messages.map((message) =>
      message.message_id === runningAgent?.message_id && activity.events
        ? {
            ...message,
            activity: {
              state: activity.loadState === "error" ? "error" : "ready",
              source: "live-preview",
              events: activity.events,
            },
          }
        : message,
    ),
  };
  const progressSnapshotRef = useRef(progressSnapshot);
  progressSnapshotRef.current = progressSnapshot;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
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
    const call = callRef.current;
    if (call && phase === "live")
      call.progress.observe(progressSnapshot, threadId);
  }, [progressSnapshot, threadId, phase]);
  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [phase]);

  const stop = useCallback(
    async (call = callRef.current) => {
      if (!call || call.stopped || callRef.current !== call) return;
      const generation = ++generationRef.current;
      call.stopped = true;
      callRef.current = undefined;
      call.abort.abort();
      call.rejectStartup?.(new Error("Live call cancelled."));
      call.bridge.close();
      call.progress.close();
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
      if (call.sessionId) {
        try {
          await rpc({ action: "end", session_id: call.sessionId });
          const value = await rpc({ action: "capabilities" });
          if (generationRef.current === generation) setCapabilities(value);
        } catch {
          if (generationRef.current === generation)
            setError("Call disconnected. Server cleanup is pending.");
        }
      }
    },
    [rpc],
  );
  useEffect(() => {
    if (!visible) void stop();
    return () => void stop();
  }, [visible, stop]);
  useEffect(() => {
    void stop();
  }, [threadId, stop]);
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
    if (!capabilities?.enabled || callRef.current || !threadId) return;
    ++generationRef.current;
    const boundThreadId = threadId;
    setConfirming(false);
    setError("");
    setCaption("");
    setSeconds(0);
    setPhase("connecting");
    const audio = audioRef.current;
    if (!audio) {
      setPhase("idle");
      setError("Call audio is unavailable in this browser view.");
      return;
    }
    const peer = new RTCPeerConnection();
    const channel = peer.createDataChannel("oai-events");
    const abort = new AbortController();
    const isCurrentCall = () =>
      !abort.signal.aborted &&
      callRef.current === call &&
      threadRef.current === boundThreadId;
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    const progress = new LiveProgressContext((type, content, id) => {
      if (isCurrentCall() && channel.readyState === "open")
        channel.send(JSON.stringify({ type, content, delegation_id: id }));
    }, proactive);
    const bridge = new LiveDelegation(
      async (text) => {
        if (!isCurrentCall() || delegateRef.current.threadId !== boundThreadId)
          throw new Error(
            "The selected agent changed. Start a new voice call.",
          );
        const accepted = await delegateRef.current.onDelegate(
          text,
          isCurrentCall,
          abort.signal,
        );
        // Acceptance may arrive after the final chat update was observed.
        setTimeout(() => {
          if (isCurrentCall()) bridge.observe(messagesRef.current);
        }, 0);
        return accepted;
      },
      (type, content, delegation_id) => {
        if (isCurrentCall() && channel.readyState === "open")
          channel.send(JSON.stringify({ type, content, delegation_id }));
      },
      (value) => {
        if (isCurrentCall()) setStatus(value);
      },
      (text) => progress.answer(text),
      async () => {
        if (!isCurrentCall() || delegateRef.current.threadId !== boundThreadId)
          throw new Error("The selected agent changed.");
        return await delegateRef.current.onInterrupt(
          isCurrentCall,
          abort.signal,
        );
      },
    );
    const call: Call = {
      peer,
      channel,
      audio,
      bridge,
      progress,
      abort,
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
      if (!isCurrentCall()) return;
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
        void stop(call);
        return;
      }
      if (event.type === "session.closed") {
        failed(new Error("Live call ended during startup."));
        setStatus("Call ended. Accepted agent work continues in chat.");
        void stop(call);
        return;
      }
      if (event.delta && event.type.includes("_transcript.delta")) {
        const speaker =
          event.type === "session.input_transcript.delta" ? "You" : "Voice";
        setCaption(`${speaker}: ${event.delta}`);
      }
      void bridge.event(event).catch(() => {
        if (isCurrentCall()) setError("Could not process a spoken request.");
      });
    };
    peer.ontrack = (event) => {
      if (!isCurrentCall()) return;
      audio.srcObject = event.streams[0];
      void audio.play().catch(() => {
        if (isCurrentCall()) setPlaybackBlocked(true);
      });
    };
    peer.onconnectionstatechange = () => {
      if (
        isCurrentCall() &&
        (peer.connectionState === "failed" ||
          peer.connectionState === "disconnected")
      ) {
        failed(new Error("Live connection lost."));
        setError("Live connection lost. Agent work continues in chat.");
        void stop(call);
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
            (!item.state || item.state === "complete") &&
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
      progress.observe(progressSnapshotRef.current, boundThreadId);
      setStatus("Listening. Spoken tasks are sent to this agent.");
      call.heartbeat = setInterval(() => {
        void rpc({ action: "heartbeat", session_id: call.sessionId })
          .then((value) => {
            if (isCurrentCall())
              setCapabilities((previous) => ({ ...previous, ...value }));
          })
          .catch(() => {
            if (!isCurrentCall()) return;
            setError("Live call expired or disconnected.");
            void stop(call);
          });
      }, 8_000);
      call.deadline = setTimeout(
        () => void stop(call),
        Math.max(0, response.expires_at - Date.now()),
      );
    } catch (cause) {
      if (isCurrentCall())
        setError(cause instanceof Error ? cause.message : String(cause));
      await stop(call);
    }
  };

  if (!visible || (!panelOpen && phase === "idle")) return null;
  const close = () => {
    setConfirming(false);
    onClose?.();
  };
  if (!capabilities || capabilities.reason === "Live voice is not enabled.") {
    return (
      <div id="cocalc-live-voice-panel" className="cocalc-live-voice">
        <div className="cocalc-live-voice-main">
          <strong>Voice options</strong>
          <div className="cocalc-live-voice-detail">
            Turn a short recording into text for your message.
          </div>
          <Button type="link" size="small" onClick={() => setShowHow(true)}>
            How this works
          </Button>
        </div>
        <div className="cocalc-live-voice-actions">
          <Button disabled={!onDictate || dictationBusy} onClick={onDictate}>
            {dictationBusy ? "Dictating…" : "Dictate message"}
          </Button>
          <Button
            className="cocalc-live-voice-close"
            type="text"
            onClick={close}
          >
            Close
          </Button>
        </div>
        <VoicePolicyDialog open={showHow} onClose={() => setShowHow(false)} />
      </div>
    );
  }
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
  const included = capabilities.funding_source === "site";
  const active = phase !== "idle";
  const needsMembership =
    !capabilities.enabled && !!capabilities.reason?.includes("paid membership");
  const heading = !capabilities.enabled
    ? needsMembership
      ? "Talk with your agent"
      : "Live voice unavailable"
    : phase === "connecting"
      ? "Connecting voice"
      : phase === "live"
        ? muted
          ? "Microphone muted"
          : "Voice is live"
        : confirming
          ? "Start a voice conversation"
          : "Talk with your agent";
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div
      id="cocalc-live-voice-panel"
      className="cocalc-live-voice"
      style={{ color: UI_COLORS.text }}
    >
      <audio
        ref={audioRef}
        autoPlay
        aria-hidden="true"
        style={{ display: "none" }}
      />
      <div
        className={`cocalc-live-voice-orb${active && !muted ? " cocalc-live-voice-orb-active" : ""}`}
        aria-hidden="true"
      >
        <span className="cocalc-live-voice-orb-halo" />
        <span className="cocalc-live-voice-orb-core" />
      </div>
      <div className="cocalc-live-voice-main">
        <div className="cocalc-live-voice-heading" aria-live="polite">
          <strong>{heading}</strong>
          {active && <span className="cocalc-live-voice-timer">{elapsed}</span>}
        </div>
        {active ? (
          <div className="cocalc-live-voice-detail" aria-live="polite">
            {status ||
              (phase === "connecting"
                ? "Preparing your microphone…"
                : "Listening")}
          </div>
        ) : dictationBusy ? (
          <div className="cocalc-live-voice-detail">
            Dictation in progress. Finish or cancel from the microphone control.
          </div>
        ) : confirming ? (
          <div className="cocalc-live-voice-detail">
            Uses {included ? "included AI" : "your OpenAI key"}. CoCalc asks the
            voice service to stop after two minutes. Agent work may use a
            separate payment source and continue after you hang up.
          </div>
        ) : !capabilities.enabled ? (
          <div className="cocalc-live-voice-detail">
            {capabilities.reason ?? "Live voice is unavailable."}
          </div>
        ) : (
          <div className="cocalc-live-voice-detail">
            Choose a live conversation or dictate a message to text.
          </div>
        )}
        {!active && (
          <Button type="link" size="small" onClick={() => setShowHow(true)}>
            How this works
          </Button>
        )}
        {caption && active && (
          <div className="cocalc-live-voice-caption" aria-live="polite">
            {caption}
          </div>
        )}
        {error && (
          <div role="alert" style={{ color: UI_COLORS.danger }}>
            {error}
          </div>
        )}
      </div>
      {included && !!capabilities.allowance?.length && (
        <div
          className="cocalc-live-voice-meters"
          aria-label="Included AI allowance"
        >
          {capabilities.allowance.map((window) => (
            <div className="cocalc-live-voice-meter" key={window.window}>
              <div className="cocalc-live-voice-meter-label">
                <span>{window.window === "5h" ? "5-hour" : "7-day"}</span>
                <strong>{window.remaining_percent}%</strong>
              </div>
              <Progress
                aria-label={`${window.window === "5h" ? "5-hour" : "7-day"} limit: ${window.remaining_percent}% remaining`}
                percent={window.remaining_percent}
                showInfo={false}
                size="small"
                strokeColor={UI_COLORS.info}
              />
            </div>
          ))}
        </div>
      )}
      <div className="cocalc-live-voice-actions">
        {playbackBlocked && phase === "live" && (
          <Button
            onClick={() => {
              const call = callRef.current;
              if (!call) return;
              void call.audio
                .play()
                .then(() => {
                  if (callRef.current === call) setPlaybackBlocked(false);
                })
                .catch(() => {
                  if (callRef.current === call)
                    setError("Browser audio playback is still blocked.");
                });
            }}
          >
            Enable call audio
          </Button>
        )}
        {!capabilities.enabled ? (
          needsMembership ? (
            <Button
              type="primary"
              disabled={dictationBusy}
              onClick={() => setConfirming(true)}
            >
              Live voice
            </Button>
          ) : (
            choice
          )
        ) : phase === "idle" ? (
          confirming ? (
            <>
              <Button
                type="primary"
                disabled={dictationBusy}
                onClick={() => void start()}
              >
                Start live call
              </Button>
              <Button onClick={() => setConfirming(false)}>Not now</Button>
            </>
          ) : (
            <>
              <Button
                type="primary"
                disabled={dictationBusy}
                onClick={() => setConfirming(true)}
              >
                Live voice
              </Button>
              {choice}
            </>
          )
        ) : (
          <>
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
            {phase === "live" && (
              <Button
                onClick={() => {
                  const next = !proactive;
                  setProactive(next);
                  callRef.current?.progress.setProactive(next);
                }}
              >
                {proactive ? "On-demand updates" : "Announce milestones"}
              </Button>
            )}
            <Button danger onClick={() => void stop()}>
              End live call
            </Button>
          </>
        )}
        {phase === "idle" && (
          <>
            <Button disabled={!onDictate || dictationBusy} onClick={onDictate}>
              {dictationBusy ? "Dictating…" : "Dictate message"}
            </Button>
            <Button
              className="cocalc-live-voice-close"
              type="text"
              onClick={close}
            >
              Close
            </Button>
          </>
        )}
      </div>
      <Modal
        title="Live voice needs a paid plan or your own API key"
        open={needsMembership && confirming}
        onCancel={() => setConfirming(false)}
        footer={null}
        destroyOnHidden
      >
        <p>
          Included live voice is available with a paid CoCalc membership. You
          can also use your own OpenAI API key and pay OpenAI directly.
        </p>
        <div className="cocalc-live-voice-modal-actions">
          <Button
            type="primary"
            onClick={() => {
              setConfirming(false);
              openAccountSettings({ page: "membership" });
            }}
          >
            View membership plans
          </Button>
          <Button
            onClick={() => {
              setConfirming(false);
              if (capabilities.own_key_available) {
                setFundingPreference("own");
              } else {
                openAccountSettings({ page: "ai" });
              }
            }}
          >
            {capabilities.own_key_available
              ? "Use my OpenAI key"
              : "Add an OpenAI key"}
          </Button>
        </div>
      </Modal>
      <VoicePolicyDialog open={showHow} onClose={() => setShowHow(false)} />
    </div>
  );
}
