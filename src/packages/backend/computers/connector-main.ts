/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A standalone connector for machines without the CoCalc CLI (the same code
// as `cocalc computer connect` and `cocalc computer daemon`):
//
//   node cocalc-computer.js connect https://cocalc.ai/c/R-...
//   node cocalc-computer.js daemon [computer_id]
//
// Design: src/.agents/computers-direct-host-2026-10-16.md.

import { createInterface } from "node:readline/promises";
import {
  loadConnection,
  pairComputer,
  runConnector,
  type ConnectorIO,
} from "./connector";

function io(): ConnectorIO {
  return {
    log: (message) => console.error(message),
    // Always asked, at a terminal: connecting gives full trust here.
    confirm: async (question) => {
      if (!process.stdin.isTTY) {
        console.error(`${question} (needs a terminal to answer)`);
        return false;
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        return /^y(es)?$/i.test(
          (await rl.question(`${question} [y/N] `)).trim(),
        );
      } finally {
        rl.close();
      }
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => stop.abort());
  }
  const [command, arg] = argv;
  if (command === "connect" && arg) {
    const connection = await pairComputer({
      url: arg,
      io: io(),
      signal: stop.signal,
    });
    await runConnector({ connection, io: io(), signal: stop.signal });
  } else if (command === "daemon") {
    await runConnector({
      connection: loadConnection(arg),
      io: io(),
      signal: stop.signal,
    });
  } else {
    console.error(
      "usage: cocalc-computer connect <url> | cocalc-computer daemon [computer_id]",
    );
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    () => process.exit(process.exitCode ?? 0),
    (err) => {
      console.error(`${err?.message ?? err}`);
      process.exit(1);
    },
  );
}
