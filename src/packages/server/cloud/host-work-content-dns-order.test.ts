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

// setPricingModel and setMachineType stop a running GCP instance themselves
// (cloud/gcp.ts), which frees an ephemeral address.
const RELEASES_ADDRESS =
  /\.(deleteHost|stopHost|hardRestartHost|setPricingModel|setMachineType)\(/;

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
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });

  for (const f of functionsOf(
    readFileSync(join(__dirname, "host-work.ts"), "utf8"),
  )) {
    const lines = f.body
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => RELEASES_ADDRESS.test(line));
    if (lines.length === 0) continue;
    it(`${f.name}: every address release follows releaseHostContentDns`, () => {
      // Either unconditionally at the top level of the function, right
      // before the call (within 4 lines), or justified by a "content DNS:"
      // comment just above it (e.g. the VM is already stopped).
      const unconditional = f.body.findIndex((line) =>
        /^  await releaseHostContentDns\(/.test(line),
      );
      for (const { i, line } of lines) {
        const near = f.body
          .slice(Math.max(0, i - 4), i)
          .some((l) => l.includes("await releaseHostContentDns("));
        const justified = f.body
          .slice(Math.max(0, i - 2), i)
          .some((l) => /^\s*\/\/ content DNS: \S/.test(l));
        const covered =
          (unconditional >= 0 && unconditional < i) || near || justified;
        if (!covered) {
          throw new Error(`${f.name}: no content DNS release before: ${line.trim()}`);
        }
      }
    });
  }
});

describe("reconcile releases content DNS when the provider took the address", () => {
  const source = readFileSync(join(__dirname, "reconcile.ts"), "utf8");
  it("for a confirmed missing instance, and for a VM the provider stopped", () => {
    expect(source).toMatch(
      /await releaseLostAddressContentDns\(row\);\s*if \(diskState === "present"\)/,
    );
    expect(source).toMatch(
      /if \(nextStatus === "off"\) \{[^}]*await releaseLostAddressContentDns\(row\);/,
    );
    expect(source).toMatch(
      /async function releaseLostAddressContentDns\(row: any\)[\s\S]*?await releaseHostContentDns\(row\);/,
    );
  });
});

describe("handleRestart releases after the host is marked restarting", () => {
  it("so a sync in between refuses instead of recreating the record", () => {
    const source = readFileSync(join(__dirname, "host-work.ts"), "utf8");
    const body = source.slice(
      source.indexOf("async function handleRestart("),
      source.indexOf("\nasync function ", source.indexOf("async function handleRestart(") + 1),
    );
    const restarting = body.indexOf('status: "restarting"');
    const release = body.indexOf("await releaseHostContentDns(row);");
    expect(restarting).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(restarting);
  });
});

describe("reconcile doesn't call Cloudflare for hosts that stay off", () => {
  it("returns early without a record once the host is off", () => {
    const source = readFileSync(join(__dirname, "reconcile.ts"), "utf8");
    expect(source).toMatch(
      /async function releaseLostAddressContentDns\(row: any\)[^{]*\{[\s\S]{0,300}?if \(row\?\.metadata\?\.content_dns == null && row\?\.status === "off"\) return;/,
    );
  });
});
