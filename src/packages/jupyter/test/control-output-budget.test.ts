import { List } from "immutable";
import { start, run, stop } from "../control";

jest.mock("@cocalc/sync/editor/db/sync", () => ({
  SyncDB: class {
    on() {}
    once() {}
    get_state() {
      return "ready";
    }
    isClosed() {
      return false;
    }
  },
}));
jest.mock("@cocalc/jupyter/kernel", () => ({
  initJupyterRedux: jest.fn(),
  removeJupyterRedux: jest.fn(),
}));
jest.mock("@cocalc/jupyter/kernel/kernel-data", () => ({
  get_kernel_data: jest.fn(async () => List()),
}));

it.each([
  { error: false, noHalt: false, completed: ["a", "b"] },
  { error: true, noHalt: false, completed: ["a"] },
  { error: true, noHalt: true, completed: ["a", "b"] },
])(
  "limits output before downstream consumers and preserves halt-on-error: %p",
  async ({ error, noHalt, completed }) => {
    const path = "/tmp/output-budget-test.ipynb";
    const actions = {
      store: { get: () => "python3" },
      setState: jest.fn(),
      syncdb: {
        close: jest.fn(),
        get: () => List([{}]),
        isClosed: () => false,
        isReady: () => true,
      },
      get_output_limit_bytes: () => 1024,
      ensureKernelIsReady: jest.fn(),
      processOutput: jest.fn(async () => {}),
      jupyter_kernel: {
        execute_code: () => ({
          async *iter() {
            yield {
              msg_type: "stream",
              content: { name: "stdout", text: "kept" },
            };
            yield {
              msg_type: "stream",
              content: { name: "stdout", text: "x".repeat(2048) },
            };
            yield { msg_type: "clear_output", content: { wait: false } };
            yield {
              msg_type: "stream",
              content: { name: "stdout", text: "discarded" },
            };
            if (error) {
              yield { msg_type: "error", content: { ename: "ValueError" } };
            }
            yield {
              msg_type: "execute_reply",
              content: { status: "ok", execution_count: 1 },
              done: true,
            };
          },
        }),
      },
      close: jest.fn(),
    };
    jest
      .requireMock("@cocalc/jupyter/kernel")
      .initJupyterRedux.mockReturnValue({ actions });
    await start({ path, project_id: "test", client: {} as any, fs: {} as any });
    try {
      const messages: any[] = [];
      for await (const message of await run({
        path,
        noHalt,
        run_id: "test-run",
        cells: [
          { id: "a", input: "" },
          { id: "b", input: "" },
        ],
        socket: {} as any,
      }))
        messages.push(message);
      expect(
        messages.filter((m) => m.lifecycle === "cell_done").map((m) => m.id),
      ).toEqual(completed);
      for (const id of completed) {
        const cell = messages.filter((m) => m.id === id);
        expect(cell.filter((m) => m.output_truncated)).toHaveLength(1);
        expect(cell.find((m) => m.content?.text === "kept")).toBeDefined();
        expect(cell.some((m) => m.msg_type === "clear_output")).toBe(false);
        expect(cell.at(-1).lifecycle).toBe("cell_done");
      }
      expect(messages.at(-1).lifecycle).toBe("run_done");
      expect(JSON.stringify(messages)).not.toContain("x".repeat(2048));
      expect(
        actions.processOutput.mock.calls.every(
          ([c]: any) => JSON.stringify(c).length < 1024,
        ),
      ).toBe(true);
    } finally {
      stop({ path });
    }
  },
);
