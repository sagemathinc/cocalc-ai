/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */
import { randomUUID } from "expo-crypto";
import type {
  LiveVoiceRequest,
  LiveVoiceResult,
} from "@cocalc/conat/hub/api/live-voice";
import type { LiveEvent } from "./delegation";

export interface LiveConnection {
  send(event: Record<string, unknown>): void;
  mute(muted: boolean): void;
  close(): Promise<void>;
  simulate?(scenario: "task" | "disconnect"): void;
}

export async function connectLive(
  rpc: (
    request: Omit<LiveVoiceRequest, "project_id">,
  ) => Promise<LiveVoiceResult>,
  history: LiveVoiceRequest["history"],
  signal: AbortSignal,
  receive: (event: LiveEvent) => void,
): Promise<LiveConnection> {
  // Lazy import keeps existing installations usable until their native rebuild.
  const { RTCPeerConnection, mediaDevices } =
    await import("react-native-webrtc");
  const { setAudioModeAsync } = await import("expo-audio");
  const peer = new RTCPeerConnection();
  const events = peer.createDataChannel("oai-events");
  let stream: Awaited<ReturnType<typeof mediaDevices.getUserMedia>> | undefined;
  let session_id: string | undefined;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let endPromise: Promise<void> | undefined;
  const send = (event: Record<string, unknown>) => {
    if (!closed && events.readyState === "open")
      events.send(JSON.stringify(event));
  };
  const close = (): Promise<void> => {
    if (endPromise) return endPromise;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
    // Stop capture immediately. Server hangup closes the provider session;
    // heartbeat expiry remains the fallback if the network is unavailable.
    stream?.getTracks().forEach((track) => track.stop());
    events.close();
    peer.close();
    stream?.release();
    endPromise = (
      session_id ? rpc({ action: "end", session_id }) : Promise.resolve()
    ).then(() => undefined);
    return endPromise;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  const check = () => {
    if (closed || signal.aborted) throw new Error("Live call cancelled.");
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    check();
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    check();
    stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    if (closed || signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      stream.release();
      throw new Error("Live call cancelled.");
    }
    for (const track of stream.getTracks()) {
      track.enabled = false;
      peer.addTrack(track, stream);
    }
    let ready!: () => void;
    let failed!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    // Attach a handler immediately: a connection can fail while admission runs.
    void started.catch(() => {});
    events.onmessage = (message: { data: string }) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (closed) return;
      if (event.type === "session.started") ready();
      if (event.type === "error")
        failed(new Error(event.error?.message ?? "Live voice failed."));
      if (event.type === "session.closed") {
        failed(new Error("Live call ended during startup."));
        void close().catch(() => {});
      }
      receive(event);
    };
    peer.onconnectionstatechange = () => {
      if (
        !closed &&
        ["failed", "disconnected"].includes(peer.connectionState)
      ) {
        failed(new Error("Live connection lost."));
        receive({
          type: "error",
          error: {
            message:
              "Live connection lost. Accepted agent work continues in chat.",
          },
        });
        void close().catch(() => {});
      }
    };
    await peer.setLocalDescription(await peer.createOffer());
    check();
    const result = await rpc({
      action: "start",
      request_id: randomUUID(),
      sdp: peer.localDescription?.sdp,
      history,
    });
    session_id = result.session_id;
    // Cancellation during admission must still close a late successful session.
    if (closed || signal.aborted) {
      if (session_id) await rpc({ action: "end", session_id });
      throw new Error("Live call cancelled.");
    }
    if (!session_id || !result.sdp || !result.expires_at)
      throw new Error("Invalid live voice connection response.");
    await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
    const startupTimer = setTimeout(
      () => failed(new Error("Live voice connection timed out.")),
      15_000,
    );
    try {
      await started;
    } finally {
      clearTimeout(startupTimer);
    }
    check();
    stream.getTracks().forEach((track) => {
      track.enabled = true;
    });
    let pinging = false;
    heartbeat = setInterval(() => {
      if (pinging || closed) return;
      pinging = true;
      void rpc({ action: "heartbeat", session_id })
        .catch(() => {
          receive({
            type: "error",
            error: {
              message:
                "Live call disconnected or expired. Agent work continues in chat.",
            },
          });
          void close().catch(() => {});
        })
        .finally(() => {
          pinging = false;
        });
    }, 8000);
    deadline = setTimeout(
      () => {
        receive({ type: "session.closed" });
        void close().catch(() => {});
      },
      Math.max(0, result.expires_at - Date.now()),
    );
    return {
      send,
      mute: (muted) =>
        stream?.getAudioTracks().forEach((track) => {
          track.enabled = !muted;
        }),
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
