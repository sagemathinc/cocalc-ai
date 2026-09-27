import {
  JupyterRunInput,
  MAX_INPUT_ANSWER_BYTES,
  MAX_INPUT_PROMPT_BYTES,
} from "./run-input";

describe("bounded run input", () => {
  afterEach(() => jest.useRealTimers());

  it("accepts once, isolates prompts, and retains no answer in its snapshot", async () => {
    const input = new JupyterRunInput();
    expect(() => input.answer(undefined as any, "answer")).toThrow(
      "request id",
    );
    const first = input.request({
      id: "cell",
      prompt: "password?",
      password: true,
    });
    const prompt = input.get()!;
    prompt.prompt = "client mutation";
    expect(input.get()!.prompt).toBe("password?");
    expect(() => input.request({ id: "other", prompt: "?" })).toThrow(
      "pending",
    );
    expect(() => input.answer("wrong", "secret")).toThrow("not pending");
    expect(input.answer(prompt.request_id, "secret")).toBe("accepted");
    expect(input.answer(prompt.request_id, "different")).toBe(
      "already-accepted",
    );
    await expect(first).resolves.toBe("secret");
    expect(input.get()).toBeNull();
    expect(JSON.stringify(input)).not.toContain("secret");
    const second = input.request({ id: "cell", prompt: "again?" });
    const next = input.get()!;
    expect(next.request_id).not.toBe(prompt.request_id);
    expect(input.answer(prompt.request_id, "late")).toBe("already-accepted");
    expect(input.get()!.request_id).toBe(next.request_id);
    input.answer(next.request_id, "new");
    await expect(second).resolves.toBe("new");
    expect(() => input.answer(prompt.request_id, "stale")).toThrow(
      "not pending",
    );
    input.close();
  });

  it.each(["timer", "clock", "close"])(
    "rejects pending input on %s",
    async (mode) => {
      jest.useFakeTimers();
      const input = new JupyterRunInput(100);
      const result = input.request({ id: "cell", prompt: "?" });
      const id = input.get()!.request_id;
      const rejected = expect(result).rejects.toThrow(
        mode === "close" ? "closed" : "expired",
      );
      if (mode === "timer") jest.advanceTimersByTime(100);
      else if (mode === "clock") jest.setSystemTime(Date.now() + 100);
      else input.close();
      expect(input.get()).toBeNull();
      await rejected;
      expect(() => input.answer(id, "late")).toThrow();
      input.close();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it("bounds UTF-8 bytes, validates lifetime, and leaves rejected answers pending", async () => {
    expect(() => new JupyterRunInput(Infinity)).toThrow();
    const input = new JupyterRunInput();
    expect(() =>
      input.request({
        id: "cell",
        prompt: "\u20ac".repeat(MAX_INPUT_PROMPT_BYTES / 2),
      }),
    ).toThrow();
    const result = input.request({ id: "cell", prompt: "?" });
    const id = input.get()!.request_id;
    expect(() =>
      input.answer(id, "x".repeat(MAX_INPUT_ANSWER_BYTES + 1)),
    ).toThrow();
    expect(input.get()!.request_id).toBe(id);
    input.answer(id, "ok");
    await expect(result).resolves.toBe("ok");
    input.close();
    expect(() => input.request({ id: "cell", prompt: "?" })).toThrow("closed");
  });
});
