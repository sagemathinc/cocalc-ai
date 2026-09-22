import { test } from "node:test";
import assert from "node:assert/strict";
import { connectPreviewLive } from "./preview";
import { LiveDelegation, type LiveEvent } from "./delegation";

test("preview exercises duplicate events through delegation without a network connection", async () => {
  let sends = 0;
  const events: LiveEvent[] = [];
  const bridge = new LiveDelegation(
    async () => {
      sends++;
      return { message_id: "local-message" };
    },
    () => {},
    () => {},
  );
  const call = await connectPreviewLive(
    new AbortController().signal,
    (event) => {
      events.push(event);
      void bridge.event(event);
    },
  );
  try {
    call.mute(true);
    call.simulate!("task");
    assert.equal(sends, 0);
    call.mute(false);
    call.simulate!("task");
    await Promise.resolve();
    assert.equal(sends, 1);
    assert.equal(
      events.filter((event) => event.type === "session.delegation.created")
        .length,
      2,
    );
    await call.close();
    call.simulate!("task");
    assert.equal(sends, 1);
  } finally {
    bridge.close();
    await call.close();
  }
});

test("preview cancellation fences simulated transcripts and playback", async () => {
  const abort = new AbortController();
  const events: LiveEvent[] = [];
  const call = await connectPreviewLive(abort.signal, (event) =>
    events.push(event),
  );
  abort.abort();
  call.simulate!("task");
  call.send({ type: "session.commentary.append", content: "late" });
  assert.deepEqual(events, []);
  await call.close();
});

test("simulated disconnect is reported once and closes the preview", async () => {
  const events: LiveEvent[] = [];
  const call = await connectPreviewLive(new AbortController().signal, (event) =>
    events.push(event),
  );
  call.simulate!("disconnect");
  call.simulate!("disconnect");
  call.simulate!("task");
  assert.equal(events.length, 1);
  assert.match(events[0].error!.message!, /Simulated connection lost/);
  await call.close();
});
