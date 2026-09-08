import { CodexClientHandler } from "../codex-handler";

function handler(before: string) {
  const stream = jest.fn();
  const instance = new CodexClientHandler({
    workspaceRoot: "/repo",
    fileAdapter: {
      readTextFile: async () => before,
      writeTextFile: async () => {},
    } as any,
    terminalAdapter: {} as any,
  });
  instance.setStream(stream);
  return { instance, stream };
}

test("slice reads retain complete observed inputs and final-newline evidence", async () => {
  const before = "first\r\nlast";
  const after = "first\r\nchanged\n";
  const { instance, stream } = handler(before);
  await instance.readTextFile({
    sessionId: "s",
    path: "a.txt",
    line: 2,
    limit: 1,
  });
  await instance.writeTextFile({
    sessionId: "s",
    path: "a.txt",
    content: after,
  });
  const event = stream.mock.calls.find(
    ([message]) => message.event?.type === "diff",
  )?.[0].event;
  expect(event.diff.source).toEqual({
    kind: "observed-documents",
    before,
    after,
  });
});

test("new turns do not inherit a prior observed baseline", async () => {
  const { instance, stream } = handler("old");
  await instance.readTextFile({ sessionId: "s", path: "a.txt" });
  instance.setStream(stream);
  await instance.writeTextFile({
    sessionId: "s",
    path: "a.txt",
    content: "new",
  });
  expect(
    stream.mock.calls.some(([message]) => message.event?.type === "diff"),
  ).toBe(false);
});

test("large UTF-8 observations keep Classic output without attaching unbounded documents", async () => {
  const before = "é".repeat(70_000);
  const { instance, stream } = handler(before);
  await instance.readTextFile({ sessionId: "s", path: "a.txt" });
  await instance.writeTextFile({
    sessionId: "s",
    path: "a.txt",
    content: before + "changed",
  });
  const diff = stream.mock.calls.find(
    ([message]) => message.event?.type === "diff",
  )?.[0].event.diff;
  expect(diff.lines.length).toBeGreaterThan(0);
  expect(diff.source).toBeUndefined();
});
