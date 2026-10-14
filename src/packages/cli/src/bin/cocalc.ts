#!/usr/bin/env node

const privateLibDir = process.env.COCALC_CLI_PRIVATE_LIB_DIR;
if (privateLibDir) {
  const remainingLibraryPath = `${process.env.LD_LIBRARY_PATH ?? ""}`
    .split(":")
    .filter((path) => path && path !== privateLibDir)
    .join(":");
  if (remainingLibraryPath) {
    process.env.LD_LIBRARY_PATH = remainingLibraryPath;
  } else {
    delete process.env.LD_LIBRARY_PATH;
  }
  delete process.env.COCALC_CLI_PRIVATE_LIB_DIR;
}

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

// An installed CLI asks its site, at most every 10 minutes, whether there is
// a newer (or required) release before running the command.
const beforeCommand = process.env.COCALC_CLI_ROOT
  ? import("../distribution/auto")
      .then(({ beforeCommand }) => beforeCommand())
      .catch(() => {})
  : Promise.resolve();

beforeCommand
  .then(() => import("./main"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
