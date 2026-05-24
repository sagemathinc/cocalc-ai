/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  formatDocsVerificationReport,
  listDocsLiveVerificationScenarios,
  verifyDocsLive,
  verifyDocsStatic,
} from "./verification";
import type { DocsActionId } from "./index";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function readRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const listLive = args.includes("--list-live");
  const live = args.includes("--live");
  const projectId =
    readOption(args, "--project-id") ?? process.env.COCALC_PROJECT_ID ?? "";
  const browserId =
    readOption(args, "--browser") ?? process.env.COCALC_BROWSER_ID ?? "";
  const cocalcCommand =
    readOption(args, "--cocalc-bin") ??
    process.env.COCALC_DOCS_VERIFY_COCALC_BIN ??
    "cocalc";
  const timeout = readOption(args, "--timeout") ?? "60s";

  if (listLive) {
    const scenarios = listDocsLiveVerificationScenarios({
      cocalcCommand,
      projectId: projectId || "$COCALC_PROJECT_ID",
      timeout,
    });
    if (json) {
      console.log(JSON.stringify({ ok: true, scenarios }, null, 2));
    } else {
      for (const scenario of scenarios) {
        const mutates = scenario.mutatesProject ? " mutates-project" : "";
        console.log(
          `${scenario.actionId}${mutates}\n  ${scenario.command.join(" ")}`,
        );
      }
    }
    return;
  }

  const staticReport = verifyDocsStatic();
  if (!live) {
    if (json) {
      console.log(JSON.stringify(staticReport, null, 2));
    } else {
      console.log(formatDocsVerificationReport(staticReport));
    }
    if (!staticReport.ok) {
      process.exitCode = 1;
    }
    return;
  }

  if (!projectId.trim()) {
    throw new Error("--project-id or COCALC_PROJECT_ID is required for --live");
  }
  const liveReport = await verifyDocsLive({
    actionIds: readRepeatedOption(args, "--action") as DocsActionId[],
    browserId: browserId || undefined,
    cocalcCommand,
    projectId,
    timeout,
  });
  if (json) {
    console.log(
      JSON.stringify({ static: staticReport, live: liveReport }, null, 2),
    );
  } else {
    console.log(formatDocsVerificationReport(staticReport));
    for (const result of liveReport.results) {
      console.log(
        `${result.ok ? "OK" : "FAIL"} live ${result.actionId}: ${result.command.join(" ")}`,
      );
      if (result.error) {
        console.log(`  ${result.error}`);
      }
    }
  }
  if (!staticReport.ok || !liveReport.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : `${err}`);
  process.exitCode = 1;
});
