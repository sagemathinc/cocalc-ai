/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { harnessPrompt, joinTurnContext } from "../harness-context";
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

test("a workbench turn asks Claude to publish deliverables", () => {
  const prompt = harnessPrompt(request(true));
  expect(prompt).toContain(artifactPublicationGuidance(CLI, true));
  // The retained process never sees this turn's COCALC_WORKBENCH.
  expect(prompt).toContain(
    `COCALC_WORKBENCH=1 ${CLI} project chat artifact publish`,
  );
  expect(prompt).not.toContain("no workbench-enabled surface");
  expect(prompt).toContain('"message_date":"2026-09-30T00:00:00.000Z"');
  expect(prompt.endsWith("Write a script that prints primes.")).toBe(true);
});

test("other turns keep ordinary replies unless an artifact is requested", () => {
  for (const workbench of [false, undefined]) {
    const prompt = harnessPrompt(request(workbench));
    expect(prompt).toContain(artifactPublicationGuidance(CLI, false));
    expect(prompt).not.toContain("Workbench is enabled for this turn");
    expect(prompt).not.toContain("COCALC_WORKBENCH=1");
  }
});

test("native harness commands pass through unchanged", () => {
  expect(harnessPrompt({ ...request(true), prompt: "/compact" })).toBe(
    "/compact",
  );
});

test("turn context blocks join, skipping empty ones", () => {
  expect(joinTurnContext(undefined, " ")).toBeUndefined();
  expect(joinTurnContext("[Agent memory]", undefined)).toBe("[Agent memory]");
  expect(joinTurnContext("[Agent memory]", "[CLI connectors]")).toBe(
    "[Agent memory]\n\n[CLI connectors]",
  );
});
