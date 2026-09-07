/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EventEmitter } from "events";

const pubsub = jest.fn();
const getStore = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (...args: any[]) => getStore(...args),
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    server_time: () => new Date("2026-07-23T15:00:00.000Z"),
    conat_client: {
      pubsub: (...args: any[]) => pubsub(...args),
    },
  },
}));

import { publishDocumentPresence } from "./service";

describe("document presence publishing", () => {
  beforeEach(() => {
    pubsub.mockReset();
    getStore.mockReset();
    getStore.mockReturnValue(undefined);
  });

  it("retries a failed subscription on later activity instead of caching it", async () => {
    const channel = Object.assign(new EventEmitter(), { set: jest.fn() });
    pubsub
      .mockRejectedValueOnce(new Error("permission denied subscribing"))
      .mockResolvedValueOnce(channel);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const activity = {
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "00000000-0000-4000-8000-000000000003",
      path: "/home/user/test.txt",
      mode: "edit" as const,
    };
    try {
      publishDocumentPresence(activity);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(channel.set).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "WARNING: document presence subscribe error -- ",
        expect.objectContaining({ message: "permission denied subscribing" }),
      );
      publishDocumentPresence(activity);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pubsub).toHaveBeenCalledTimes(2);
      expect(channel.set).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("contains asynchronous publish failures", async () => {
    const channel = new EventEmitter() as EventEmitter & {
      set: jest.Mock;
    };
    channel.set = jest
      .fn()
      .mockRejectedValue(new Error("permission denied subscribing"));
    pubsub.mockResolvedValue(channel);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    publishDocumentPresence({
      account_id: "00000000-0000-4000-8000-000000000001",
      project_id: "00000000-0000-4000-8000-000000000002",
      path: "/home/user/test.txt",
      mode: "edit",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.set).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "WARNING: document presence publish error -- ",
      expect.objectContaining({ message: "permission denied subscribing" }),
    );
    warn.mockRestore();
  });
});
