import { OutputHandler } from "./output-handler";

describe("OutputHandler", () => {
  it("ignores lifecycle messages that have no content", () => {
    const cell: any = { id: "alpha" };
    const handler = new OutputHandler({ cell });

    expect(() =>
      handler.process({ msg_type: "run_start", lifecycle: "run_start" } as any),
    ).not.toThrow();
    expect(() =>
      handler.process({
        msg_type: "cell_start",
        lifecycle: "cell_start",
        id: "alpha",
      } as any),
    ).not.toThrow();
    expect(cell.state).toBe("busy");
    expect(() =>
      handler.process({
        msg_type: "cell_done",
        lifecycle: "cell_done",
        id: "alpha",
      } as any),
    ).not.toThrow();
    expect(cell.state).toBe("done");

    handler.close();
  });

  it("still processes normal output messages", () => {
    const cell: any = { id: "alpha" };
    const handler = new OutputHandler({ cell });
    handler.process({
      msg_type: "stream",
      content: { name: "stdout", text: "hello" },
    } as any);
    handler.done();

    expect(cell.output?.["0"]?.text).toBe("hello");
  });
});
