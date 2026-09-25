import {
  DEFAULT_OUTPUT_LIMIT_BYTES,
  MAX_OUTPUT_LIMIT_BYTES,
  OutputBudget,
  outputLimitBytes,
} from "./output-budget";

const stream = (text: string, name = "stdout") => ({
  msg_type: "stream",
  content: { name, text },
});

describe("per-execution output budget", () => {
  it.each([undefined, null, 0, -1, NaN, Infinity, "100", 1.5])(
    "uses a finite default for invalid setting %p",
    (value) => expect(outputLimitBytes(value)).toBe(DEFAULT_OUTPUT_LIMIT_BYTES),
  );

  it("accepts a manual increase and bounds it", () => {
    expect(outputLimitBytes(4 * 1024 * 1024)).toBe(4 * 1024 * 1024);
    expect(outputLimitBytes(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_OUTPUT_LIMIT_BYTES,
    );
  });

  it("bounds repeated stdout even though the downstream handler merges it", () => {
    const budget = new OutputBudget(1024);
    const kept: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      const output = budget.accept(stream("hi\n"));
      if (output != null) kept.push(output.content.text);
    }
    expect(kept.filter((s) => s.includes("Output truncated"))).toHaveLength(1);
    expect(kept.join("").length).toBeLessThan(1500);
  });

  it("drops a single oversized message without retaining its contents", () => {
    const budget = new OutputBudget(1024);
    const output = budget.accept(stream("x".repeat(2_000_000)));
    expect(output?.content.name).toBe("stderr");
    expect(output?.content.text).toContain("Further output is discarded");
    expect(output?.content.text.length).toBeLessThan(400);
  });

  it("counts UTF-8 bytes and both output streams", () => {
    const budget = new OutputBudget(70);
    expect(budget.accept(stream("\u00e9\u00e9\u00e9"))?.content.text).toBe(
      "\u00e9\u00e9\u00e9",
    );
    expect(budget.accept(stream("x", "stderr"))?.content.text).toContain(
      "Output truncated",
    );
  });

  it.each(["display_data", "update_display_data", "execute_result", "error"])(
    "bounds %s, including metadata and binary buffers",
    (msg_type) => {
      const budget = new OutputBudget(128);
      expect(
        budget.accept({
          msg_type,
          content: { data: { "text/plain": "ok" } },
          metadata: { label: "x".repeat(129) },
        })?.msg_type,
      ).toBe("stream");
      const binaryBudget = new OutputBudget(128);
      expect(
        binaryBudget.accept({
          msg_type,
          content: {},
          buffers: [Buffer.alloc(129)],
        })?.content.text,
      ).toContain("Output truncated");
    },
  );

  it("does not reset for clear_output or erase the truncation notice", () => {
    const budget = new OutputBudget(150);
    const clear = { msg_type: "clear_output", content: { wait: true } };
    expect(budget.accept(stream("first"))?.content.text).toBe("first");
    expect(budget.accept(clear)).toBe(clear);
    expect(budget.accept(stream("next"))?.content.text).toContain(
      "Output truncated",
    );
    expect(budget.accept(clear)).toBeUndefined();
  });

  it("preserves lifecycle, execution replies and stdin after truncation", () => {
    const budget = new OutputBudget(1);
    budget.accept(stream("hi"));
    for (const msg_type of [
      "status",
      "execute_input",
      "execute_reply",
      "input_request",
      "cell_done",
      "run_done",
    ]) {
      const message = { msg_type, content: { execution_count: 7 }, done: true };
      expect(budget.accept(message)).toBe(message);
    }
    expect(budget.accept(stream("discarded"))).toBeUndefined();
  });

  it("has no wall-clock timeout and gives each execution a fresh budget", () => {
    const budget = new OutputBudget(1024);
    const first = stream("important result");
    expect(budget.accept(first)).toBe(first);
    const now = jest.spyOn(Date, "now").mockReturnValue(10 ** 15);
    expect(budget.accept(first)).toBe(first);
    now.mockRestore();
    budget.accept(stream("x".repeat(1024)));
    expect(new OutputBudget(1024).accept(first)).toBe(first);
    expect(
      new OutputBudget(4096).accept(stream("x".repeat(1024)))?.content.text,
    ).toHaveLength(1024);
  });
});
