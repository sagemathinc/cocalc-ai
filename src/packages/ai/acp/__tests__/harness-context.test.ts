/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { harnessPrompt, harnessSessionGuidance } from "../harness-context";
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
  expect(prompt.length).toBeLessThan(600);
  for (const workbench of [false, undefined]) {
    expect(harnessPrompt(request(workbench))).toContain(
      "Workbench is not enabled for this turn.",
    );
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
