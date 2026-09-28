/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { jupyterLiveRunPage, type JupyterLiveRunSnapshot } from "./live-run";
import { DataEncoding, encode } from "../../core/codec";

function snapshot(text = "output"): JupyterLiveRunSnapshot {
  return {
    path: "notebook.ipynb",
    run_id: "run",
    updated_at_ms: 1,
    done: true,
    batches: [1, 2, 3].map((seq) => ({
      path: "notebook.ipynb",
      run_id: "run",
      id: `run:${seq}`,
      seq,
      sent_at_ms: seq,
      mesgs: [{ id: "cell", content: { text } }],
    })),
  };
}

it("pages replay without gaps and preserves terminal status", () => {
  const source = snapshot();
  const first = jupyterLiveRunPage(source, 0, 2);
  expect(first.batches.map((x) => x.seq)).toEqual([1, 2]);
  expect(first).toMatchObject({ next_seq: 2, has_more: true, done: true });
  const last = jupyterLiveRunPage(source, first.next_seq, 2);
  expect(last.batches.map((x) => x.seq)).toEqual([3]);
  expect(last).toMatchObject({ next_seq: 3, has_more: false });
  expect(jupyterLiveRunPage(source, 3).batches).toEqual([]);
  expect(source.batches).toHaveLength(3);
});

it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
  "rejects invalid cursor %s",
  (cursor) => {
    expect(() => jupyterLiveRunPage(snapshot(), cursor)).toThrow("invalid");
  },
);

it.each([0, -1, 101, 1.5, NaN])("rejects invalid limit %s", (limit) => {
  expect(() => jupyterLiveRunPage(snapshot(), 0, limit)).toThrow("invalid");
});

it("bounds encoded response bytes without silently skipping large batches", () => {
  const source = snapshot("x".repeat(600_000));
  const page = jupyterLiveRunPage(source);
  expect(page).toMatchObject({ next_seq: 1, has_more: true });
  expect(page.batches).toHaveLength(1);
  expect(
    encode({ encoding: DataEncoding.MsgPack, mesg: page }).length,
  ).toBeLessThanOrEqual(1024 * 1024);
  const oversized = snapshot("x".repeat(1024 * 1024));
  expect(() => jupyterLiveRunPage(oversized)).toThrow("exceeds response limit");
});
