/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { BufferSource, EncodedPacketSink, Input, WEBM } from "mediabunny";

// RFC 6716 sections 3.1 and 3.2.5. Container timestamps do not include
// the duration of the final Opus packet in streaming MediaRecorder WebM.
export function opusPacketDurationMs(data: Uint8Array): number {
  if (data.length === 0) throw Error("Empty Opus packet");
  const config = data[0] >> 3;
  const frameMs =
    config >= 16
      ? 2.5 * 2 ** (config & 3)
      : config >= 12
        ? 10 * 2 ** (config & 1)
        : [10, 20, 40, 60][config & 3];
  const code = data[0] & 3;
  if (code === 3 && data.length < 2) throw Error("Missing Opus frame count");
  const frames = code === 0 ? 1 : code === 3 ? data[1] & 63 : 2;
  const duration = frames * frameMs;
  if (duration <= 0 || duration > 120) throw Error("Invalid Opus duration");
  return duration;
}

export async function measureWebmSpeechDurationMs(
  audio: Uint8Array,
  maxDurationMs: number,
): Promise<number> {
  const input = new Input({ source: new BufferSource(audio), formats: [WEBM] });
  try {
    const tracks = await input.getAudioTracks();
    if (tracks.length !== 1 || (await tracks[0].getCodec()) !== "opus") {
      throw Error("Expected one Opus audio track");
    }
    let encodedMs = 0;
    let endMs = 0;
    const sink = new EncodedPacketSink(tracks[0]);
    for await (const packet of sink.packets()) {
      const durationMs = opusPacketDurationMs(packet.data);
      encodedMs += durationMs;
      endMs = Math.max(endMs, packet.timestamp * 1000 + durationMs);
      // Count encoded frames as well as timeline gaps: overlapping timestamps
      // must not make a long recording appear short. Stop scanning at the cap.
      if (Math.max(encodedMs, endMs) > maxDurationMs) {
        throw Error("Recording too long");
      }
    }
    return Math.max(encodedMs, endMs);
  } finally {
    input.dispose();
  }
}
