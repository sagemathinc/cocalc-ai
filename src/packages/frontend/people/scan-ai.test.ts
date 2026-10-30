/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockFd = jest.fn();
const mockRipgrep = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({
      fs: () => ({ fd: mockFd, ripgrep: mockRipgrep }),
    }),
  },
}));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: async () => {},
}));
jest.mock("@cocalc/frontend/project/home-directory", () => ({
  resolveProjectHomeDirectory: async () => "/home/user",
}));

import { AI_CHAT_PATTERN, ripgrepOptions, scanProject } from "./scan";

const out = (text: string, code = 0) => ({
  stdout: Buffer.from(text),
  stderr: Buffer.from(""),
  code,
});

beforeEach(() => {
  mockFd.mockReset();
  mockRipgrep.mockReset();
});

test("the AI pattern matches agent threads and model senders, not people", () => {
  const ai = new RegExp(AI_CHAT_PATTERN);
  const human = "14a0013f-5cb5-45a0-9836-c94963076a87";
  for (const line of [
    '{"event":"chat-thread-config","agent_kind":"acp","thread_id":"t"}',
    '{"event":"chat-thread-config","acp_config":{"model":"gpt-5"}}',
    '{"event":"chat","sender_id":"openai-gpt-4o","date":"2026-01-01"}',
    '{"event":"chat","sender_id":"anthropic-claude-3-5-sonnet"}',
    '{"event":"chat","sender_id":"chatgpt","date":"2023-01-01"}',
    '{"event":"chat","sender_id":"ollama-llama3"}',
  ]) {
    expect(ai.test(line)).toBe(true);
  }
  for (const line of [
    `{"event":"chat","sender_id":"${human}","history":[{"content":"openai-gpt is great"}]}`,
    '{"event":"chat-thread-config","agent_kind":"none"}',
    '{"event":"chat-thread-config","acp_config":null}',
  ]) {
    expect(ai.test(line)).toBe(false);
  }
});

test("ripgrep lists matching .chat files, with the same places skipped as fd", () => {
  const options = ripgrepOptions();
  expect(options).toEqual(
    expect.arrayContaining(["--files-with-matches", "--glob", "*.chat"]),
  );
  expect(options).toEqual(expect.arrayContaining(["!.local", "!.snapshots"]));
});

test("a scan leaves out AI chats and counts them", async () => {
  mockFd.mockResolvedValue(
    out("team.chat\nnotes/codex.chat\nold-gpt.chat\nproject/plans.chat\n"),
  );
  mockRipgrep.mockResolvedValue(out("./notes/codex.chat\nold-gpt.chat\n"));
  const result = await scanProject("p");
  expect(result.paths).toEqual([
    "/home/user/project/plans.chat",
    "/home/user/team.chat",
  ]);
  expect(result.skipped).toBe(2);
  expect(mockRipgrep).toHaveBeenCalledWith(
    "/home/user",
    AI_CHAT_PATTERN,
    expect.objectContaining({ options: ripgrepOptions() }),
  );
});

test("no AI chats: ripgrep's no-match exit is fine", async () => {
  mockFd.mockResolvedValue(out("team.chat\n"));
  mockRipgrep.mockResolvedValue(out("", 1));
  const result = await scanProject("p");
  expect(result.paths).toEqual(["/home/user/team.chat"]);
  expect(result.skipped).toBe(0);
});

test("if the AI check fails, nothing is offered from that project", async () => {
  mockFd.mockResolvedValue(out("team.chat\nnotes/codex.chat\n"));
  mockRipgrep.mockResolvedValue({
    stdout: Buffer.from(""),
    stderr: Buffer.from("rg: timed out"),
    code: 2,
  });
  await expect(scanProject("p")).rejects.toThrow("rg: timed out");
});

test("nothing found: no AI check needed", async () => {
  mockFd.mockResolvedValue(out(""));
  const result = await scanProject("p");
  expect(result.paths).toEqual([]);
  expect(mockRipgrep).not.toHaveBeenCalled();
});
