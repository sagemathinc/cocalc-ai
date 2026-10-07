/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  harnessHasSessionGuidance,
  harnessPrompt,
  harnessSessionGuidance,
} from "../harness-context";
import { artifactPublicationGuidance } from "../publication-guidance";

const CLI = '"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"';

function request(workbench?: boolean) {
  return {
    prompt: "Write a script that prints primes.",
    project_id: "00000000-0000-4000-8000-000000000001",
    chat: {
      project_id: "00000000-0000-4000-8000-000000000001",
      path: "a.chat",
      thread_id: "thread-1",
      message_date: "2026-09-30T00:00:00.000Z",
      ...(workbench == null ? {} : { workbench }),
    },
  } as any;
}

test("session guidance carries both publication modes once", () => {
  for (const subscription of [true, false]) {
    const guidance = harnessSessionGuidance(subscription);
    expect(guidance).toContain(artifactPublicationGuidance(CLI, true));
    expect(guidance).toContain(artifactPublicationGuidance(CLI, false));
    // The retained process never sees a turn's COCALC_WORKBENCH.
    expect(guidance).toContain(
      `COCALC_WORKBENCH=1 ${CLI} project chat artifact publish`,
    );
    expect(guidance.includes("request_user_input_async")).toBe(subscription);
  }
});

test("a turn carries only its changing values", () => {
  const prompt = harnessPrompt(request(true));
  expect(prompt).toContain("Workbench is enabled for this turn.");
  expect(prompt).toContain('"message_date":"2026-09-30T00:00:00.000Z"');
  expect(prompt.endsWith("Write a script that prints primes.")).toBe(true);
  // Static guidance lives in the system prompt, not in every user message.
  expect(prompt).not.toContain(artifactPublicationGuidance(CLI, true));
  expect(prompt.length).toBeLessThan(1200);
  // Except what a turn must never lose: math formatting and how to publish
  // from a shell that does not carry the turn's COCALC_WORKBENCH.
  expect(prompt).toContain("Write mathematics as LaTeX");
  expect(prompt).toContain(
    `COCALC_WORKBENCH=1 ${CLI} project chat artifact publish --project `,
  );
  expect(prompt).toContain("--message-date 2026-09-30T00:00:00.000Z");
  for (const workbench of [false, undefined]) {
    const other = harnessPrompt(request(workbench));
    expect(other).toContain("Workbench is not enabled for this turn.");
    expect(other).toContain("Write mathematics as LaTeX");
    expect(other).not.toContain("COCALC_WORKBENCH=1");
    expect(other).toContain("--experimental");
  }
});

test("a turn carries the current memory list", () => {
  const prompt = harnessPrompt({
    ...request(),
    agent_memory_context: "[Agent memory]\n- a-note: a fact",
  });
  expect(prompt).toContain("- a-note: a fact\n[/CoCalc turn context]");
});

test("native harness commands pass through unchanged", () => {
  expect(harnessPrompt({ ...request(true), prompt: "/compact" })).toBe(
    "/compact",
  );
});

test("custom ACP harnesses that may ignore _meta keep the guidance inline", () => {
  expect(harnessHasSessionGuidance({ version: 2, id: "claude-code" })).toBe(
    true,
  );
  expect(harnessHasSessionGuidance({ version: 1, id: "custom" })).toBe(false);
  const prompt = harnessPrompt(request(true), { inlineSessionGuidance: true });
  expect(prompt.startsWith(harnessSessionGuidance(false))).toBe(true);
  expect(prompt).toContain("[CoCalc turn context]");
  expect(prompt.endsWith("Write a script that prints primes.")).toBe(true);
});
