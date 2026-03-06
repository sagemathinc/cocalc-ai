#!/usr/bin/env node

const cliVerboseFlag = process.argv.includes("--verbose");
const cliDebugEnabled =
  cliVerboseFlag ||
  process.env.COCALC_CLI_DEBUG === "1" ||
  process.env.COCALC_CLI_DEBUG === "true";

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
