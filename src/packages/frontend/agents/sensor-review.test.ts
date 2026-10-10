jest.mock("@cocalc/frontend/app-framework", () => ({ redux: {} }));
jest.mock("@cocalc/frontend/chat/register", () => ({ initChat: jest.fn() }));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: () => "/home/user",
}));
jest.mock("@cocalc/frontend/chat/harness-credential-selection", () => ({
  readHarnessCredentialSelection: jest.fn(),
  writeHarnessCredentialSelection: jest.fn(),
}));
jest.mock("./agent-subscription-selection", () => ({
  readAgentSubscriptionSelection: jest.fn(),
  writeAgentSubscriptionSelection: jest.fn(),
}));

import {
  findSensorReview,
  reviewVerdict,
  sensorReviewChatPath,
  sensorReviewPrompt,
  sensorReviewThreadName,
} from "./sensor-review";

const spec = {
  kind: "script",
  title: "New issues",
  purpose: "Wake me for new issues.",
  language: "python",
  script: "print('hi')\n# ```` fences inside the script\n",
  schedule: { kind: "interval", minutes: 30 },
  timeout_seconds: 60,
  max_wakes_per_day: 24,
  uses: ["github"],
} as any;

test("the reviewer gets fixed instructions, the exact spec and the script", () => {
  const prompt = sensorReviewPrompt(spec);
  expect(prompt).toMatch(/clean context/);
  expect(prompt).toMatch(/Do not run the script/);
  expect(prompt).toContain('"uses": [\n    "github"\n  ]');
  expect(prompt).toContain("print('hi')");
  expect(prompt).toMatch(/^Verdict: Do not approve$/m);
});

test("the verdict comes from the first line only", () => {
  expect(reviewVerdict("Verdict: Looks safe\n- fine")).toBe("safe");
  expect(reviewVerdict("Verdict: Has concerns\n")).toBe("concerns");
  expect(reviewVerdict("Verdict: Do not approve")).toBe("reject");
  expect(reviewVerdict("I think it looks safe")).toBeUndefined();
  expect(reviewVerdict("")).toBeUndefined();
});

test("reviews live in a chat of their own, one thread per exact spec", () => {
  expect(sensorReviewChatPath("p", "s1")).toBe(
    "/home/user/.local/share/cocalc/sensor-reviews/s1.chat",
  );
  expect(sensorReviewThreadName("New issues", "abcdef0123456789")).toBe(
    "Review: New issues (spec abcdef012345)",
  );
});

test("finds the newest review of the spec and the reviewer's reply", () => {
  const name = sensorReviewThreadName("New issues", "abcdef0123456789");
  const actions = {
    listThreadConfigRows: () => [
      { thread_id: "old", name, date: "2026-10-10T18:00:00.000Z" },
      { thread_id: "new", name, date: "2026-10-10T19:00:00.000Z" },
      { thread_id: "other", name: "Review: x (spec 999)", date: "z" },
    ],
    getMessagesInThread: (thread_id: string) =>
      thread_id === "new"
        ? [
            { sender_id: "me", history: [{ content: "prompt" }] },
            {
              sender_id: "openai-codex-agent",
              generating: false,
              history: [{ content: "Verdict: Has concerns\n- it posts data" }],
            },
          ]
        : [],
  } as any;
  expect(
    findSensorReview(actions, "New issues", "abcdef0123456789", "me"),
  ).toEqual({
    thread_id: "new",
    text: "Verdict: Has concerns\n- it posts data",
    generating: false,
    verdict: "concerns",
  });
  expect(findSensorReview(actions, "New issues", "000", "me")).toBeUndefined();
});
