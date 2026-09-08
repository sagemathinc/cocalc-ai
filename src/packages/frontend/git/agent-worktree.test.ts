import { dispatchWorktreeFeedback } from "./agent-worktree";
const context = {
  projectId: "p",
  commonDirectory: "/repo/.git",
  workingDirectory: "/selected",
  expectedHead: "a".repeat(40),
  reviewedCommit: "b".repeat(40),
  expectedBranch: "refs/heads/feature",
};
test("dispatch carries validated context and never substitutes another directory", async () => {
  const send = jest.fn();
  await dispatchWorktreeFeedback({
    validate: async () => context,
    isCurrent: () => true,
    send,
    prompt: "Review feedback",
    title: "Fix review",
  });
  expect(send).toHaveBeenCalledWith(
    expect.stringContaining(JSON.stringify(context, null, 2)),
    { workingDirectory: "/selected", title: "Fix review" },
  );
  expect(send.mock.calls[0][0]).toContain("do not checkout");
});
test("navigation or dismissal during validation prevents dispatch", async () => {
  const send = jest.fn();
  let finish!: (value: typeof context) => void;
  let current = true;
  const promise = dispatchWorktreeFeedback({
    validate: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    isCurrent: () => current,
    send,
    prompt: "Review",
  });
  current = false;
  finish(context);
  await expect(promise).rejects.toThrow("context changed");
  expect(send).not.toHaveBeenCalled();
});
test("failed validation never sends feedback", async () => {
  const send = jest.fn();
  await expect(
    dispatchWorktreeFeedback({
      validate: async () => {
        throw Error("HEAD changed");
      },
      isCurrent: () => true,
      send,
      prompt: "Review",
    }),
  ).rejects.toThrow("HEAD changed");
  expect(send).not.toHaveBeenCalled();
});
