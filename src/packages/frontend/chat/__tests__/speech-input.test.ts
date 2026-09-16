/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { insertTranscriptAtMarkdownPosition } from "../input";
import { selectRecorderMimeType } from "../audio/use-chat-audio-recorder";

describe("chat speech input", () => {
  it("inserts a transcript at a multiline Markdown selection", () => {
    expect(
      insertTranscriptAtMarkdownPosition({
        value: "first line\nsecond line",
        transcript: "spoken words",
        position: { line: 1, ch: 6 },
      }),
    ).toEqual({
      value: "first line\nsecond spoken words line",
      position: { line: 1, ch: 19 },
    });
  });

  it("does not add whitespace before punctuation", () => {
    expect(
      insertTranscriptAtMarkdownPosition({
        value: "Hello, world",
        transcript: "there",
        position: { line: 0, ch: 5 },
      }).value,
    ).toBe("Hello there, world");
  });

  it("clamps a stale captured position without corrupting Markdown", () => {
    expect(
      insertTranscriptAtMarkdownPosition({
        value: "short",
        transcript: "ending",
        position: { line: 99, ch: 99 },
      }).value,
    ).toBe("short ending");
  });

  it("selects the first browser format also accepted by the server", () => {
    expect(
      selectRecorderMimeType(["audio/mp4", "audio/webm"], (type) =>
        type.startsWith("audio/mp4"),
      ),
    ).toBe("audio/mp4;codecs=mp4a.40.2");
  });

  it("reports no recording format when browser and server do not intersect", () => {
    expect(selectRecorderMimeType(["audio/webm"], () => false)).toBeUndefined();
  });
});
