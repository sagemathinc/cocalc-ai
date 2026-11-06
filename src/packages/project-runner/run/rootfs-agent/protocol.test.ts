import {
  encodeChunkFrame,
  encodeJsonFrame,
  FRAME_CHUNK,
  FRAME_JSON,
  FrameDecoder,
  ProtocolError,
  ReplyTracker,
} from "./protocol";

const small = { maxFrame: 64, maxBuffered: 69 };

function header(length: number, type = FRAME_JSON): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(length, 0);
  b.writeUInt8(type, 4);
  return b;
}

describe("rootfs agent frames", () => {
  it("decodes JSON and chunk frames, however the stream is split", () => {
    const stream = Buffer.concat([
      encodeJsonFrame({ id: 1, ok: true }),
      encodeChunkFrame(Buffer.from("abc")),
      encodeJsonFrame({ id: 2 }),
    ]);
    for (let cut = 0; cut <= stream.length; cut++) {
      const decoder = new FrameDecoder();
      const frames = [
        ...decoder.push(stream.subarray(0, cut)),
        ...decoder.push(stream.subarray(cut)),
      ];
      decoder.end();
      expect(frames).toEqual([
        { type: FRAME_JSON, value: { id: 1, ok: true } },
        { type: FRAME_CHUNK, data: Buffer.from("abc") },
        { type: FRAME_JSON, value: { id: 2 } },
      ]);
    }
  });

  it("refuses a frame beyond the size bound, before reading it", () => {
    const decoder = new FrameDecoder(small);
    expect(() => decoder.push(header(65))).toThrow(ProtocolError);
    expect(() => decoder.push(header(0))).toThrow(ProtocolError);
    expect(() => new FrameDecoder(small).push(header(0))).toThrow(
      "frame length 0 is out of bounds",
    );
  });

  it("bounds what it buffers, even when no frame is complete", () => {
    const decoder = new FrameDecoder(small);
    decoder.push(header(64));
    expect(() => decoder.push(Buffer.alloc(65))).toThrow("buffered");
  });

  it("refuses a flood of valid frames beyond the buffer bound in one push", () => {
    const flood = Buffer.concat(
      Array.from({ length: 20 }, () => encodeJsonFrame({ id: 1 })),
    );
    expect(() => new FrameDecoder(small).push(flood)).toThrow("buffered");
  });

  it("refuses an unknown type and malformed JSON", () => {
    expect(() =>
      new FrameDecoder().push(Buffer.concat([header(2, 7), Buffer.from("x")])),
    ).toThrow("unknown frame type 7");
    expect(() =>
      new FrameDecoder().push(Buffer.concat([header(3), Buffer.from("{x")])),
    ).toThrow("malformed JSON");
  });

  it("refuses a partial header or body at the end of the stream", () => {
    const partialHeader = new FrameDecoder();
    partialHeader.push(Buffer.from([0, 0]));
    expect(() => partialHeader.end()).toThrow("stream ended inside a frame");
    const partialBody = new FrameDecoder();
    partialBody.push(encodeJsonFrame({ id: 1 }).subarray(0, 8));
    expect(() => partialBody.end()).toThrow("stream ended inside a frame");
  });

  it("stays failed after an error", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(header(0))).toThrow(ProtocolError);
    expect(() => decoder.push(encodeJsonFrame({ id: 1 }))).toThrow(
      ProtocolError,
    );
    expect(() => decoder.end()).toThrow(ProtocolError);
  });

  it("won't encode a frame beyond the bound", () => {
    expect(() => encodeChunkFrame(Buffer.alloc(16 * 1024 * 1024))).toThrow(
      "too large",
    );
  });
});

describe("rootfs agent replies", () => {
  it("accepts exactly one reply per outstanding request", () => {
    const tracker = new ReplyTracker();
    const a = tracker.open();
    const b = tracker.open();
    expect(tracker.close({ id: b })).toBe(b);
    expect(tracker.close({ id: a })).toBe(a);
    expect(tracker.size).toBe(0);
  });

  it("refuses duplicate, unsolicited, late and id-less replies", () => {
    const tracker = new ReplyTracker();
    const a = tracker.open();
    tracker.close({ id: a });
    expect(() => tracker.close({ id: a })).toThrow("duplicate reply");
    expect(() => tracker.close({ id: 99 })).toThrow("unsolicited reply");
    const late = tracker.open();
    tracker.abandon(late);
    expect(() => tracker.close({ id: late })).toThrow(ProtocolError);
    for (const reply of [null, 1, "x", [], {}, { id: "1" }, { id: 1.5 }]) {
      expect(() => tracker.close(reply)).toThrow("reply without a valid id");
    }
  });

  it("bounds the requests outstanding", () => {
    const tracker = new ReplyTracker(2);
    tracker.open();
    tracker.open();
    expect(() => tracker.open()).toThrow("more than 2 requests outstanding");
  });
});
