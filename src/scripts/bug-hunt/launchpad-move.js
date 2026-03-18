#!/usr/bin/env node
"use strict";

const {
  executeLaunchpadCanary,
  parseArgs: parseCanaryArgs,
} = require("./launchpad-canary.js");

function parseArgs(argv) {
  const options = parseCanaryArgs(argv);
  options.scenarios = ["move"];
  return options;
}

async function main(argv = process.argv.slice(2), now = Date.now()) {
  const options = parseArgs(argv);
  const payload = await executeLaunchpadCanary(options, now);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }
  console.log(`launchpad move: ${payload.run_dir}`);
  for (const run of payload.runs) {
    console.log(`- ${run.provider}/${run.scenario} ${run.status}`);
  }
  if (payload.stopped_early) {
    console.log(`stopped early: ${payload.stop_reason}`);
  }
  return payload;
}

module.exports = {
  main,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`bug-hunt launchpad-move error: ${err?.message ?? err}`);
    process.exit(1);
  });
}
