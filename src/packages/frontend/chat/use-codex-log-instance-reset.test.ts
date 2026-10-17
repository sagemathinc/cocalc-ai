/** @jest-environment jsdom */

import { EventEmitter } from "events";

// An ephemeral live-log stream whose persist server lost it numbers its
// messages from 1 again; the hook must not reject those as already shown.

class FakeLiveStream extends EventEmitter {
  constructor(
    public instance: string,
    public items: [number, any][],
  ) {
    super();
  }
  get length() {
    return this.items.length;
  }
  seqs = () => this.items.map(([seq]) => seq);
  get = (index: number) => this.items[index][1];
  getPersistInstance = () => this.instance;
  getRecoveryState = () => "ready";
  catchUp = async () => {};
  recoverNow = async () => {};
}

const acquire = jest.fn();
jest.mock("@cocalc/frontend/conat/project-dstream", () => ({
  acquireSharedProjectDStream: (opts) => acquire(opts),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectConat: async () => {
        throw Error("not used");
      },
      on: () => {},
      off: () => {},
      removeListener: () => {},
      registerReconnectResource: () => ({
        requestReconnect: () => {},
        close: () => {},
      }),
    },
  },
}));
jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({ warn: jest.fn(), debug: jest.fn(), info: jest.fn() }),
}));

import { act, renderHook } from "@testing-library/react";
import { useCodexLog } from "./use-codex-log";

const summary = (seq: number, text: string) => ({
  type: "summary",
  seq,
  finalResponse: text,
  time: seq,
});

function texts(events: any[] | null | undefined): string[] {
  return (events ?? []).map((evt) => evt.finalResponse).filter(Boolean);
}

function render(logKey: string) {
  return renderHook(() =>
    useCodexLog({
      projectId: "00000000-0000-4000-8000-000000000000",
      logStore: "acp-log",
      logKey,
      liveLogStream: `live-${logKey}`,
      liveStreamIsProjection: true,
      generating: true,
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useCodexLog after the live stream's persist instance changes", () => {
  beforeEach(() => {
    acquire.mockReset();
  });

  it("a remount from a cached cursor of the old instance shows the new instance's messages", async () => {
    const logKey = `remount-${Math.random()}`;
    const old = new FakeLiveStream("old", [[1, summary(1, "A")]]);
    acquire.mockResolvedValueOnce({ stream: old, release: async () => {} });
    const first = render(logKey);
    await settle();
    expect(texts(first.result.current.events)).toEqual(["A"]);
    first.unmount();

    // The stream was recreated: its seq 1 is a different message.
    const recreated = new FakeLiveStream("new", [[1, summary(2, "B")]]);
    acquire.mockResolvedValueOnce({
      stream: recreated,
      release: async () => {},
    });
    const second = render(logKey);
    await settle();
    expect(acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ start_seq: 2, start_instance: "old" }),
    );
    expect(texts(second.result.current.events)).toContain("B");
    second.unmount();
  });

  it("a mounted hook shows the new instance's messages after a reset", async () => {
    const logKey = `active-${Math.random()}`;
    const stream = new FakeLiveStream("old", [[1, summary(1, "A")]]);
    acquire.mockResolvedValueOnce({ stream, release: async () => {} });
    const { result, unmount } = render(logKey);
    await settle();
    expect(texts(result.current.events)).toEqual(["A"]);

    await act(async () => {
      stream.instance = "new";
      stream.items = [[1, summary(2, "B")]];
      stream.emit("instance-reset", "new");
      stream.emit("change", summary(2, "B"), 1);
    });
    await settle();
    expect(texts(result.current.events)).toContain("B");
    unmount();
  });
});
