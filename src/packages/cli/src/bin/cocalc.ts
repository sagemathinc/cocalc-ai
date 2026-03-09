#!/usr/bin/env node

const cliVerboseFlag = process.argv.includes("--verbose");
const cliDebugEnabled =
  cliVerboseFlag ||
  process.env.COCALC_CLI_DEBUG === "1" ||
  process.env.COCALC_CLI_DEBUG === "true";

const origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: any, ...args: any[]) => {
  const type =
    typeof args[0] === "string" && args[0]
      ? args[0]
      : typeof warning?.name === "string"
        ? warning.name
        : "";
  const message =
    typeof warning === "string"
      ? warning
      : typeof warning?.message === "string"
        ? warning.message
        : "";
  if (
    !cliDebugEnabled &&
    type === "ExperimentalWarning" &&
    /SQLite is an experimental feature/i.test(message)
  ) {
    return;
  }
  return (origEmitWarning as any)(warning, ...args);
}) as typeof process.emitWarning;

if (!cliDebugEnabled) {
  process.env.SMC_TEST ??= "1";
  process.env.DEBUG_CONSOLE ??= "no";
  process.env.DEBUG_FILE ??= "";
} else {
  process.env.DEBUG ??= "cocalc:*";
  process.env.DEBUG_CONSOLE ??= "yes";
  process.env.DEBUG_FILE ??= "";
}

import("./main").catch((err) => {
  console.error(err);
  process.exit(1);
});
