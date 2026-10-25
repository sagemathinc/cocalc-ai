/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { act, render } from "@testing-library/react";
import {
  FILE_CHANGE_DEBOUNCE_MS,
  FILE_WATCH_RETRY_MS,
  useFileChanges,
} from "./use-file-changes";

// A watch the test drives: push events, end it, see whether it was closed.
function fakeWatch() {
  const queue: any[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const watch = {
    closed: false,
    push(event: string) {
      queue.push({ event, filename: "a.todo.json" });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    close() {
      watch.closed = true;
      watch.end();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  return watch;
}

let watches: ReturnType<typeof fakeWatch>[] = [];
const watchFn = jest.fn(async () => {
  const w = fakeWatch();
  watches.push(w);
  return w;
});
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ actions: { fs: () => ({ watch: watchFn }) } }),
}));

function Probe({ onChange }: { onChange: () => void }) {
  useFileChanges("/home/user/a.todo.json", onChange);
  return null;
}

const flush = () => act(async () => {});

beforeEach(() => {
  jest.useFakeTimers();
  watches = [];
  watchFn.mockClear();
});
afterEach(() => jest.useRealTimers());

test("a burst of changes reloads once", async () => {
  const onChange = jest.fn();
  render(<Probe onChange={onChange} />);
  await flush();
  expect(watchFn).toHaveBeenCalledWith("/home/user/a.todo.json");
  watches[0].push("change");
  watches[0].push("change");
  await flush();
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(FILE_CHANGE_DEBOUNCE_MS));
  expect(onChange).toHaveBeenCalledTimes(1);
});

test("a lapsed watch is renewed and catches up", async () => {
  const onChange = jest.fn();
  render(<Probe onChange={onChange} />);
  await flush();
  watches[0].end(); // e.g. the file was replaced
  await flush();
  await act(async () => jest.advanceTimersByTime(FILE_WATCH_RETRY_MS));
  await flush();
  expect(watchFn).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(FILE_CHANGE_DEBOUNCE_MS));
  expect(onChange).toHaveBeenCalledTimes(1);
});

test("leaving the card closes the watch", async () => {
  const onChange = jest.fn();
  const { unmount } = render(<Probe onChange={onChange} />);
  await flush();
  unmount();
  expect(watches[0].closed).toBe(true);
  await act(async () =>
    jest.advanceTimersByTime(FILE_WATCH_RETRY_MS + FILE_CHANGE_DEBOUNCE_MS),
  );
  expect(watchFn).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});
