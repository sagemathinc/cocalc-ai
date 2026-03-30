export {};

import { EventEmitter } from "events";

let getLroStreamMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;

class FakeStream extends EventEmitter {
  private events: any[] = [];

  getAll() {
    return [...this.events];
  }

  push(event: any) {
    this.events.push(event);
    this.emit("change", event);
  }

  close() {
    this.emit("closed");
  }
}

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/conat/lro/client", () => ({
  __esModule: true,
  get: (...args: any[]) => getLroStreamMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("@cocalc/conat/lro/stream", () => ({
  __esModule: true,
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

describe("mirrorStartLroProgress", () => {
  beforeEach(() => {
    jest.resetModules();
    getLroStreamMock = jest.fn();
    updateLroMock = jest.fn(async ({ op_id, progress_summary }) => ({
      op_id,
      scope_type: "project",
      scope_id: "proj-1",
      status: "running",
      progress_summary,
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
  });

  it("persists streamed project-start progress into the lro summary", async () => {
    const stream = new FakeStream();
    getLroStreamMock.mockResolvedValue(stream);
    const { mirrorStartLroProgress } = await import("./start-lro-progress");

    const close = await mirrorStartLroProgress({
      project_id: "proj-1",
      op_id: "op-1",
    });

    stream.push({
      type: "progress",
      ts: 1000,
      phase: "cache_rootfs",
      message: "pulling RootFS image",
      progress: 61,
      detail: { transferred: "512 MiB" },
    });

    await close();

    expect(updateLroMock).toHaveBeenCalledWith({
      op_id: "op-1",
      progress_summary: {
        phase: "cache_rootfs",
        message: "pulling RootFS image",
        progress: 61,
        detail: { transferred: "512 MiB" },
      },
    });
    expect(publishLroSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "project",
        scope_id: "proj-1",
        summary: expect.objectContaining({
          op_id: "op-1",
          progress_summary: expect.objectContaining({
            phase: "cache_rootfs",
            progress: 61,
          }),
        }),
      }),
    );
  });
});
