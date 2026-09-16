/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  issueBayCredential,
  listBayCredentials,
  revokeBayCredential,
} from "./bay-credentials";
import { getConfiguredClusterRole } from "@cocalc/server/cluster-config";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const result = `${value(name) ?? ""}`.trim();
  if (!result) throw Error(`${name} is required`);
  return result;
}

async function main(): Promise<void> {
  if (getConfiguredClusterRole() === "attached") {
    throw Error("bay credential management must run against the seed database");
  }
  const command = process.argv[2];
  switch (command) {
    case "issue": {
      const output = resolve(
        process.env.INIT_CWD ?? process.cwd(),
        required("--output"),
      );
      const issued = await issueBayCredential({
        bay_id: required("--bay"),
        replaces_credential_id: value("--replaces"),
      });
      try {
        await writeFile(output, `${issued.credential}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      } catch (err) {
        await revokeBayCredential({
          credential_id: issued.credential_id,
        }).catch(() => undefined);
        throw err;
      }
      process.stdout.write(
        `${JSON.stringify({ ...issued, credential: undefined, output }, null, 2)}\n`,
      );
      return;
    }
    case "list":
      process.stdout.write(
        `${JSON.stringify(await listBayCredentials({ bay_id: value("--bay") }), null, 2)}\n`,
      );
      return;
    case "revoke":
      process.stdout.write(
        `${JSON.stringify(
          await revokeBayCredential({
            credential_id: required("--credential-id"),
          }),
          null,
          2,
        )}\n`,
      );
      return;
    default:
      throw Error(
        "usage: bay-credential <issue --bay ID --output FILE [--replaces ID] | list [--bay ID] | revoke --credential-id ID>",
      );
  }
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
