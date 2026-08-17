/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ChangeEvent } from "@cocalc/conat/files/watch";
import { startOpenFileWatch } from "./open-file-watch";

function fakeWatcher() {
  const queued: ChangeEvent[] = [];
  let resolveNext: ((value: IteratorResult<ChangeEvent>) => void) | undefined;
  let closed = false;
  const watcher = {
    close: jest.fn(() => {
      closed = true;
      resolveNext?.({ done: true, value: undefined });
      resolveNext = undefined;
    }),
    emit(event: ChangeEvent) {
      if (resolveNext) {
        resolveNext({ done: false, value: event });
        resolveNext = undefined;
      } else {
        queued.push(event);
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    next(): Promise<IteratorResult<ChangeEvent>> {
      if (queued.length) {
        return Promise.resolve({ done: false, value: queued.shift()! });
      }
      if (closed) {
        return Promise.resolve({ done: true, value: undefined });
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
  };
  return watcher;
}

test("subscribes without polling and forwards project-host changes", async () => {
  const watcher = fakeWatcher();
  const filesystem = { watch: jest.fn(async () => watcher) } as any;
  const onChange = jest.fn();
  const close = startOpenFileWatch({
    filesystem,
    onChange,
    path: "/home/user/a.py",
    settleMs: 0,
  });
  await Promise.resolve();

  expect(filesystem.watch).toHaveBeenCalledWith("/home/user/a.py", {
    closeOnUnlink: false,
    maxQueue: 4,
    overflow: "ignore",
    stabilityThreshold: 400,
    unique: false,
  });
  watcher.emit({ event: "change", filename: "/home/user/a.py" });
  await Promise.resolve();
  expect(onChange).toHaveBeenCalledWith({
    event: "change",
    filename: "/home/user/a.py",
  });

  close();
  expect(watcher.close).toHaveBeenCalledTimes(1);
});

test("closes a watcher that resolves after navigation", async () => {
  const watcher = fakeWatcher();
  let resolveWatch!: (value: any) => void;
  const filesystem = {
    watch: jest.fn(() => new Promise((resolve) => (resolveWatch = resolve))),
  } as any;
  const close = startOpenFileWatch({
    filesystem,
    onChange: jest.fn(),
    path: "/home/user/a.py",
  });
  close();
  resolveWatch(watcher);
  await Promise.resolve();
  await Promise.resolve();
  expect(watcher.close).toHaveBeenCalledTimes(1);
});
