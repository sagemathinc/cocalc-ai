import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechController, type SpeechAdapter } from "./controller";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const caps = {
  input: {
    enabled: true,
    max_bytes: 100,
    max_duration_ms: 1000,
    supported_content_types: ["audio/mp4"],
  },
  output: {
    enabled: true,
    max_characters: 4000,
    voices: ["test"],
    default_voice: "test",
    speeds: [1],
  },
};
function setup(overrides: Partial<SpeechAdapter> = {}) {
  let disposed = 0,
    transcribed = 0;
  const texts: string[] = [];
  const adapter: SpeechAdapter = {
    capabilities: async () => caps,
    record: async () => ({
      finish: async () => ({ audio: new Uint8Array([1]), duration: 100 }),
      dispose: async () => {
        disposed++;
      },
    }),
    transcribe: async () => {
      transcribed++;
      return "A dictated task";
    },
    speak: async () => {},
    ...overrides,
  };
  return {
    controller: new SpeechController(adapter, (text) => texts.push(text)),
    texts,
    counts: () => ({ disposed, transcribed }),
  };
}
test("dictation only delivers a draft transcript after explicit finish", async () => {
  const s = setup();
  await s.controller.start();
  assert.equal(s.controller.getSnapshot().phase, "recording");
  assert.deepEqual(s.texts, []);
  await s.controller.finish();
  assert.deepEqual(s.texts, ["A dictated task"]);
  assert.equal(s.controller.getSnapshot().phase, "idle");
  assert.equal(s.counts().disposed, 1);
});
test("cancellation fences a late transcription result", async () => {
  const result = deferred<string>();
  const s = setup({ transcribe: () => result.promise });
  await s.controller.start();
  const finish = s.controller.finish();
  await new Promise((resolve) => setImmediate(resolve));
  s.controller.cancel();
  result.resolve("Do not insert this");
  await finish;
  assert.deepEqual(s.texts, []);
  assert.equal(s.controller.getSnapshot().phase, "idle");
});
test("cancel during permission/prepare disposes a late recording", async () => {
  const recording = deferred<Awaited<ReturnType<SpeechAdapter["record"]>>>();
  let disposed = 0;
  const s = setup({ record: () => recording.promise });
  const start = s.controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  s.controller.cancel();
  recording.resolve({
    finish: async () => ({ audio: new Uint8Array(), duration: 0 }),
    dispose: async () => {
      disposed++;
    },
  });
  await start;
  assert.equal(disposed, 1);
  assert.equal(s.controller.getSnapshot().phase, "idle");
});
test("capability denial avoids requesting microphone access", async () => {
  let recorded = false;
  const s = setup({
    capabilities: async () => ({
      ...caps,
      input: { ...caps.input, enabled: false, reason: "Speech disabled" },
    }),
    record: async () => {
      recorded = true;
      throw Error("unexpected");
    },
  });
  await s.controller.start();
  assert.equal(recorded, false);
  assert.equal(s.controller.getSnapshot().error, "Speech disabled");
});
test("oversize audio is rejected before any transcription request", async () => {
  const s = setup({
    record: async () => ({
      finish: async () => ({ audio: new Uint8Array(101), duration: 100 }),
      dispose: async () => {},
    }),
  });
  await s.controller.start();
  await s.controller.finish();
  assert.equal(s.counts().transcribed, 0);
  assert.match(s.controller.getSnapshot().error!, /too large/);
});
test("stop read-aloud aborts playback and stale completion cannot reset a newer recording", async () => {
  const finished = deferred<void>();
  let signal: AbortSignal | undefined;
  const s = setup({
    speak: async (_text, _id, _caps, abort) => {
      signal = abort;
      await finished.promise;
    },
  });
  const read = s.controller.read("result", "message");
  await new Promise((resolve) => setImmediate(resolve));
  s.controller.cancel();
  assert.equal(signal?.aborted, true);
  await s.controller.start();
  finished.resolve();
  await read;
  assert.equal(s.controller.getSnapshot().phase, "recording");
  s.controller.cancel();
});

test("the recording limit finishes into a draft without sending", async () => {
  const s = setup({
    capabilities: async () => ({
      ...caps,
      input: { ...caps.input, max_duration_ms: 5 },
    }),
  });
  await s.controller.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.controller.getSnapshot().phase, "idle");
  assert.deepEqual(s.texts, ["A dictated task"]);
  assert.equal(s.counts().disposed, 1);
});
