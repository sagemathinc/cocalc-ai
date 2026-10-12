/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A standalone connector for machines without the CoCalc CLI (the same code
// as `cocalc computer connect` and `cocalc computer daemon`):
//
//   node cocalc-computer.js connect https://cocalc.ai/c/R-... [--yes]
//   node cocalc-computer.js daemon [computer_id]

import { createInterface } from "node:readline/promises";
import {
  loadConnection,
  pairComputer,
  runConnector,
  type ConnectorIO,
} from "./connector";

function io(yes: boolean): ConnectorIO {
  return {
    log: (message) => console.error(message),
    confirm: async (question) => {
      if (yes) return true;
      if (!process.stdin.isTTY) {
        console.error(`${question} (no terminal to ask; pass --yes)`);
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
  const [command, arg] = argv.filter((a) => !a.startsWith("--"));
  const yes = argv.includes("--yes");
  if (command === "connect" && arg) {
    const connection = await pairComputer({
      url: arg,
      io: io(yes),
      signal: stop.signal,
    });
    await runConnector({ connection, io: io(yes), signal: stop.signal });
  } else if (command === "daemon") {
    await runConnector({
      connection: loadConnection(arg),
      io: io(false),
      signal: stop.signal,
    });
  } else {
    console.error(
      "usage: cocalc-computer connect <url> [--yes] | cocalc-computer daemon [computer_id]",
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
