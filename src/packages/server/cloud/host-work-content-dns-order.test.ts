/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Content-origin DNS must stop resolving before a project host's address can
// be released (host-content-dns.ts).  host-work's handlers need a database to
// run, so this guards the order in their source: in each function, every
// provider call that can release the address comes after a call to
// releaseHostContentDns.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELEASES_ADDRESS = /\.(deleteHost|stopHost|hardRestartHost)\(/;

function functionsOf(source: string): { name: string; body: string[] }[] {
  const out: { name: string; body: string[] }[] = [];
  let current: { name: string; body: string[] } | undefined;
  for (const line of source.split("\n")) {
    const m = line.match(/^(?:export )?async function (\w+)\(/);
    if (m) {
      current = { name: m[1], body: [] };
      out.push(current);
    }
    current?.body.push(line);
  }
  return out;
}

describe("host-work releases content DNS before releasing an address", () => {
  const source = readFileSync(join(__dirname, "host-work.ts"), "utf8");
  const functions = functionsOf(source);

  it("finds the address-releasing calls it guards", () => {
    const calls = functions.flatMap((f) =>
      f.body.filter((line) => RELEASES_ADDRESS.test(line)),
    );
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  for (const f of functionsOf(
    readFileSync(join(__dirname, "host-work.ts"), "utf8"),
  )) {
    const lines = f.body
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => RELEASES_ADDRESS.test(line));
    if (lines.length === 0) continue;
    it(`${f.name}: every address release follows releaseHostContentDns`, () => {
      // Either unconditionally at the top level of the function, or right
      // before the call (within 4 lines).
      const unconditional = f.body.findIndex((line) =>
        /^  await releaseHostContentDns\(/.test(line),
      );
      for (const { i, line } of lines) {
        const near = f.body
          .slice(Math.max(0, i - 4), i)
          .some((l) => l.includes("await releaseHostContentDns("));
        const covered = (unconditional >= 0 && unconditional < i) || near;
        if (!covered) {
          throw new Error(`${f.name}: no content DNS release before: ${line.trim()}`);
        }
      }
    });
  }
});
