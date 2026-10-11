/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKGROUND_FPS, FramePacer, WATCHED_FPS } from "./frame-pacer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A Chromium that, like the real one, cannot take a second frame (any tab)
// before the first is done.
function fakeChromium() {
  let inFlight = 0;
  const chromium = {
    maxInFlight: 0,
    frames: new Map<string, number>(),
    send: async (method: string, params: any, sessionId?: string) => {
      if (method === "Target.attachToTarget")
        return { sessionId: `session-${params.targetId}` };
      if (method === "Target.detachFromTarget") return {};
      assert.equal(method, "HeadlessExperimental.beginFrame");
      inFlight++;
      chromium.maxInFlight = Math.max(chromium.maxInFlight, inFlight);
      await sleep(1 + Math.random() * 5);
      inFlight--;
      chromium.frames.set(
        sessionId!,
        (chromium.frames.get(sessionId!) ?? 0) + 1,
      );
      return {};
    },
  };
  return chromium;
}

test("frames: one at a time for the whole browser, each tab at its rate", async () => {
  const chromium = fakeChromium();
  const pacer = new FramePacer({
    send: chromium.send,
    watched: (targetId) => targetId === "watched",
  });
  for (const targetId of ["watched", "b", "c", "d", "e"]) pacer.add(targetId);
  await sleep(2000);
  pacer.close();
  assert.equal(chromium.maxInFlight, 1);
  const watched = chromium.frames.get("session-watched") ?? 0;
  assert.ok(
    watched >= WATCHED_FPS && watched <= 2.5 * WATCHED_FPS,
    `watched: ${watched} frames in 2 s`,
  );
  for (const targetId of ["b", "c", "d", "e"]) {
    const n = chromium.frames.get(`session-${targetId}`) ?? 0;
    assert.ok(
      n >= BACKGROUND_FPS && n <= 3 * BACKGROUND_FPS,
      `${targetId}: ${n} frames in 2 s`,
    );
  }
});

test("a Chromium that renders by itself: the pacer stops", async () => {
  let frames = 0;
  const pacer = new FramePacer({
    send: async (method: string, params: any) => {
      if (method === "Target.attachToTarget")
        return { sessionId: `session-${params.targetId}` };
      if (method === "Target.detachFromTarget") return {};
      frames++;
      throw Error("'HeadlessExperimental.beginFrame' wasn't found");
    },
    watched: () => true,
  });
  pacer.add("a");
  pacer.add("b");
  await sleep(500);
  assert.equal(pacer.supported, false);
  const asked = frames;
  await sleep(300);
  assert.equal(frames, asked);
  assert.ok(asked <= 2, `asked ${asked} times`);
  pacer.close();
});
