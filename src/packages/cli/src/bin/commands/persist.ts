import { Command } from "commander";

import {
  decodeSyncDatabase,
  parseNonNegativeInteger,
  parsePositiveInteger,
} from "../core/persist-decode";

export type PersistCommandDeps = {
  runLocalCommand: any;
};

export function registerPersistCommand(
  program: Command,
  deps: PersistCommandDeps,
): Command {
  const persist = program
    .command("persist")
    .description("inspect local Conat persist sqlite databases");

  persist
    .command("decode-db <database>")
    .description("decode a local Conat sync/persist sqlite database")
    .option(
      "--jsonl-output <file>",
      "write decoded message records as JSONL to this file",
    )
    .option(
      "--include-values",
      "include full decoded message values in JSONL output; this can be very large",
    )
    .option("--from-seq <seq>", "only scan messages at or after this seq")
    .option("--limit <n>", "maximum number of messages to decode")
    .action(
      async (
        database: string,
        opts: {
          jsonlOutput?: string;
          includeValues?: boolean;
          fromSeq?: string;
          limit?: string;
        },
        command: Command,
      ) => {
        await deps.runLocalCommand(command, "persist decode-db", async () =>
          decodeSyncDatabase({
            dbPath: database,
            jsonlOutput: opts.jsonlOutput,
            includeValues: opts.includeValues,
            fromSeq: parseNonNegativeInteger(opts.fromSeq, "--from-seq"),
            limit: parsePositiveInteger(opts.limit, "--limit"),
          }),
        );
      },
    );

  return persist;
}
