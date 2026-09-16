/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  Output,
  WEBM,
  WebMOutputFormat,
} from "mediabunny";
import {
  measureWebmSpeechDurationMs,
  opusPacketDurationMs,
} from "./webm-speech-duration";

const audio = readFileSync(
  join(__dirname, "fixtures/chromium-streaming-opus.webm"),
);

it("measures streaming packets when the duration header is absent", async () => {
  const input = new Input({ source: new BufferSource(audio), formats: [WEBM] });
  try {
    expect(await input.getDurationFromMetadata()).toBeNull();
    expect(await measureWebmSpeechDurationMs(audio, 90000)).toBe(960);
  } finally {
    input.dispose();
  }
});

it.each([
  [0, undefined, 10],
  [24, undefined, 60],
  [96, undefined, 10],
  [104, undefined, 20],
  [128, undefined, 2.5],
  [152, undefined, 20],
  [153, undefined, 40],
  [154, undefined, 40],
  [155, 3, 60],
])("measures Opus TOC %i frame count %s", (toc, count, duration) => {
  const packet = new Uint8Array(count === undefined ? [toc!] : [toc!, count]);
  expect(opusPacketDurationMs(packet)).toBe(duration);
});

it.each([[], [155], [155, 0], [155, 7]])(
  "rejects invalid Opus timing %j",
  (...bytes) => {
    expect(() => opusPacketDurationMs(new Uint8Array(bytes))).toThrow();
  },
);

it.each([false, true])(
  "rejects overlong packet audio (overlapping timestamps: %s)",
  async (overlap) => {
    const input = new Input({
      source: new BufferSource(audio),
      formats: [WEBM],
    });
    try {
      const track = (await input.getAudioTracks())[0];
      const packet = await new EncodedPacketSink(track).getFirstPacket();
      const config = await track.getDecoderConfig();
      const target = new BufferTarget();
      const output = new Output({ target, format: new WebMOutputFormat() });
      const source = new EncodedAudioPacketSource("opus");
      output.addAudioTrack(source);
      await output.start();
      const seconds = opusPacketDurationMs(packet!.data) / 1000;
      for (let i = 0; i < Math.ceil(91 / seconds); i++) {
        await source.add(
          new EncodedPacket(
            packet!.data,
            "key",
            overlap ? 0 : i * seconds,
            seconds,
          ),
          { decoderConfig: config! },
        );
      }
      await output.finalize();
      await expect(
        measureWebmSpeechDurationMs(new Uint8Array(target.buffer!), 90000),
      ).rejects.toThrow("Recording too long");
    } finally {
      input.dispose();
    }
  },
);
