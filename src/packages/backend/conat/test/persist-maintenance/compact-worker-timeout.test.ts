import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// A worker child that exits only when the test says so, as a SIGKILLed one
// does some time after kill() returns.
const children: any[] = [];
jest.mock("node:child_process", () => ({
  spawn: jest.fn(() => {
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn(() => true);
    children.push(child);
    return child;
  }),
}));

import { runPersistMaintenanceWorker } from "@cocalc/backend/conat/persist-maintenance/compact-worker";

describe("a timed-out persist maintenance worker", () => {
  it("settles only once its child has exited", async () => {
    let settled = false;
    const run = runPersistMaintenanceWorker({
      sourcePath: "/tmp/x.db",
      timeoutMs: 50,
    }).finally(() => (settled = true));
    run.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [child] = children;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    // killed, but it may still have the databases open
    expect(settled).toBe(false);
    child.emit("exit", null, "SIGKILL");
    await expect(run).rejects.toThrow("timed out after 50ms");
  });
});
