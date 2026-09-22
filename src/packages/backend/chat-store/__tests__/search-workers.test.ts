import { EventEmitter } from "node:events";
import { searchChatStore } from "../sqlite-offload";

const workers: any[] = [];
let creationError = false;
jest.mock("node:worker_threads", () => ({
  Worker: jest.fn().mockImplementation((_path, options) => {
    if (creationError) throw new Error("allocation failed");
    const worker = new EventEmitter() as any;
    worker.options = options;
    worker.terminate = jest.fn(async () => 0);
    workers.push(worker);
    return worker;
  }),
}));
const opts = { chat_path: "/not-opened.chat", query: "test" };
let sequence = 0;
beforeEach(() => {
  workers.length = 0;
  creationError = false;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

test.each([undefined, "thread"])(
  "scoped and unscoped searches allocate workers under the same account gate (%s)",
  async (thread_id) => {
    const account = `account-${sequence++}`;
    const pending = searchChatStore({ ...opts, thread_id }, account);
    await expect(searchChatStore(opts, account)).rejects.toThrow(
      "Account search is busy",
    );
    const other = searchChatStore(opts, `${account}-other`);
    expect(workers).toHaveLength(2);
    expect(workers[0].options.workerData.thread_id).toBe(thread_id);
    workers[0].emit("message", { value: { hits: [] } });
    workers[1].emit("message", { value: { hits: [] } });
    await Promise.all([pending, other]);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  },
);

test.each(["timeout", "error", "exit", "message", "allocation", "termination"])(
  "releases admission after %s",
  async (failure) => {
    const account = `failure-${sequence++}`;
    creationError = failure === "allocation";
    const pending = searchChatStore(opts, account);
    const rejected = expect(pending).rejects.toThrow();
    if (failure === "timeout") await jest.advanceTimersByTimeAsync(6000);
    else if (failure === "error") workers[0].emit("error", new Error("failed"));
    else if (failure === "exit") workers[0].emit("exit", 1);
    else if (failure === "message")
      workers[0].emit("message", { error: "query failed" });
    else if (failure === "termination") {
      workers[0].terminate.mockRejectedValue(new Error("termination failed"));
      workers[0].emit("message", { value: { hits: [] } });
    }
    await rejected;
    creationError = false;
    const next = searchChatStore(opts, account);
    workers.at(-1).emit("message", { value: { hits: [] } });
    await next;
  },
);

test("timeout retains capacity until termination completes", async () => {
  const account = `termination-${sequence++}`;
  const pending = searchChatStore(opts, account);
  const rejected = expect(pending).rejects.toThrow("time budget");
  let finish!: () => void;
  workers[0].terminate.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await jest.advanceTimersByTimeAsync(6000);
  await expect(searchChatStore(opts, account)).rejects.toThrow("busy");
  finish();
  await rejected;
});

test.each([
  { query: "x".repeat(257) },
  { query: " " },
  { offset: -1 },
  { offset: 10001 },
  { offset: Infinity },
  { limit: 101 },
  { limit: 1.5 },
  { exclude_thread_ids: Array(101).fill("a") },
  { exclude_thread_ids: ["x".repeat(201)] },
  { thread_id: "x".repeat(201) },
  { include_head: true },
])(
  "rejects invalid unscoped inputs before allocating a worker: %j",
  async (extra) => {
    await expect(
      searchChatStore({ ...opts, ...extra }, "invalid"),
    ).rejects.toThrow("Invalid");
    expect(workers).toHaveLength(0);
  },
);
