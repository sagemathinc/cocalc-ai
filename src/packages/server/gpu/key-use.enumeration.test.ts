/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Who may make a capability to decrypt a GPU provider key, and who may
// decrypt one (STEP5D2 5d-2c), checked against the source: a new caller
// fails here until it is placed on purpose.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GPU_KEY_USE_PURPOSES,
  GPU_KEY_WORKER_PURPOSES,
} from "@cocalc/util/db-schema/gpu-budgets";

const PACKAGES = join(__dirname, "..", "..");

// production TypeScript under server/ (no tests, no build output)
const sources: Record<string, string> = Object.fromEntries(
  execFileSync(
    "git",
    // untracked files too: a new caller counts before it is committed
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "server/**/*.ts",
    ],
    {
      cwd: PACKAGES,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter((f) => f && !/\.test\.ts$|\/test\/|\/dist\//.test(f))
    .map((f) => [f, readFileSync(join(PACKAGES, f), "utf8")]),
);

// the files that call `name(`, besides where it is defined
function callers(name: string): string[] {
  const call = new RegExp(`\\b${name}\\(`);
  const def = new RegExp(`function ${name}\\b`);
  return Object.entries(sources)
    .filter(([, text]) =>
      text.split("\n").some((line) => call.test(line) && !def.test(line)),
    )
    .map(([f]) => f)
    .sort();
}

const BOUNDARIES = [
  "server/conat/api/gpu.ts",
  "server/conat/api/system.ts",
  "server/inter-bay/gpu-key-use.ts",
  "server/inter-bay/service.ts",
];

describe("GPU key capabilities and decrypts (5d-2c)", () => {
  it("makes user and agent records only at the authenticated boundaries", () => {
    for (const ctor of [
      "admitUserKeyUse",
      "admitAgentKeyUse",
      "admitProjectKeyUse",
    ]) {
      for (const f of callers(ctor)) {
        expect([ctor, f, BOUNDARIES.includes(f)]).toEqual([ctor, f, true]);
      }
    }
  });

  it("gives every user and agent purpose a boundary that makes it", () => {
    const made = new Set<string>();
    for (const f of BOUNDARIES) {
      for (const m of sources[f].matchAll(
        /(?:keyUse|gpuKeyUse)\([^)]*"([a-z_]+)"|purpose: "([a-z_]+)"/g,
      )) {
        made.add(m[1] ?? m[2]);
      }
    }
    for (const purpose of GPU_KEY_USE_PURPOSES) {
      expect([purpose, made.has(purpose)]).toEqual([purpose, true]);
    }
  });

  it("makes worker capabilities only in the lease-holding sweeps, for their own purposes", () => {
    expect(callers("workerKeyUse")).toEqual([
      "server/gpu/billing.ts",
      "server/gpu/key-use.ts",
      "server/gpu/reaper.ts",
      "server/gpu/reconcile.ts",
    ]);
    const made = (f: string) =>
      [
        ...sources[f].matchAll(
          /workerKeyUse\(\s*"([a-z]+)",\s*token,\s*"([a-z_]+)"/g,
        ),
      ].map((m) => `${m[1]}:${m[2]}`);
    expect(made("server/gpu/reaper.ts").sort()).toEqual([
      "compromise:cleanup",
      "reaper:reaper",
    ]);
    // the sweep and the stale-launch wake, each with its own lease and run
    expect(made("server/gpu/reconcile.ts")).toEqual([
      "reconciler:reconcile",
      "reconciler:reconcile",
    ]);
    expect(made("server/gpu/billing.ts")).toEqual(["billing:billing"]);
    // the account checks: a decrypt of their own, in the reconciler's run
    expect(sources["server/gpu/reconcile.ts"]).toMatch(
      /workerKeyUseFor\(key_use, "account_watch"\)/,
    );
    const covered = new Set(
      GPU_KEY_WORKER_PURPOSES.filter((p) =>
        Object.values(sources).some(
          (t) =>
            t.includes(`token, "${p}")`) ||
            t.includes(`workerKeyUseFor(key_use, "${p}")`),
        ),
      ),
    );
    for (const purpose of GPU_KEY_WORKER_PURPOSES) {
      expect([purpose, covered.has(purpose)]).toEqual([purpose, true]);
    }
  });

  it("keeps test capabilities out of production code", () => {
    expect(callers("issueTestKeyUse")).toEqual([
      "server/gpu/key-use-testing.ts",
    ]);
    for (const [f, text] of Object.entries(sources)) {
      expect([
        f,
        /from "[^"]*key-use-testing"|require\("[^"]*key-use-testing"\)/.test(
          text,
        ),
      ]).toEqual([f, false]);
    }
  });

  it("requires each decrypting entry point's own capability at its entry", () => {
    const entries: Record<string, [string, string]> = {
      launchGpuPodLocal: ["server/gpu/pods.ts", "launch"],
      terminateGpuPodLocal: ["server/gpu/pods.ts", "terminate"],
      killSwitchLocal: ["server/gpu/pods.ts", "terminate"],
      listManagedGpuPodsLocal: ["server/gpu/pods.ts", "pod_read"],
      getGpuPodsLocal: ["server/gpu/read.ts", "pod_read"],
      getGpuCatalogLocal: ["server/gpu/read.ts", "catalog"],
      getGpuAvailabilityLocal: ["server/gpu/read.ts", "catalog"],
      gpuSshInfoLocal: ["server/gpu/hostkey.ts", "ssh_info"],
      setGpuProviderKeyLocal: ["server/gpu/provider-keys.ts", "verify"],
      deleteGpuProviderKeyLocal: ["server/gpu/provider-keys.ts", "removal"],
      reportCompromisedLocal: ["server/gpu/compromise.ts", "compromise"],
    };
    for (const [fn, [file, purpose]] of Object.entries(entries)) {
      const text = sources[file];
      const start = text.indexOf(`export async function ${fn}(`);
      expect([fn, start >= 0]).toEqual([fn, true]);
      const body = text.slice(start, text.indexOf("\n}\n", start));
      expect([
        fn,
        body
          .replace(/\s+/g, " ")
          .replace(/\( /g, "(")
          .includes(`requireKeyUse(opts.key_use, ["${purpose}"]`),
      ]).toEqual([fn, true]);
      // a required property, not an optional one
      expect([fn, /key_use\?:/.test(body)]).toEqual([fn, false]);
    }
  });

  it("decrypts a GPU key only through the broker, from the key helpers", () => {
    expect(callers("withAuditedGpuKey")).toEqual([
      "server/gpu/provider-keys.ts",
    ]);
    expect(callers("admitDecrypt")).toEqual(["server/gpu/provider-keys.ts"]);
  });

  it("reads keys only at the listed call sites", () => {
    expect(callers("withRunpodCleanup")).toEqual([
      "server/gpu/billing.ts",
      "server/gpu/compromise.ts",
      "server/gpu/hostkey.ts",
      "server/gpu/pods.ts",
      "server/gpu/provider-keys.ts",
      "server/gpu/read.ts",
      "server/gpu/reaper.ts",
      "server/gpu/reconcile.ts",
    ]);
    expect(callers("withRunpodLaunchAccess")).toEqual([
      "server/gpu/pods.ts",
      "server/gpu/read.ts",
    ]);
    // the old, unaudited helpers are gone
    for (const old of [
      "getRunpodCleanupForAccount",
      "getRunpodLaunchAccessForAccount",
      "getRunpodClientForAccount",
    ]) {
      expect([old, callers(old)]).toEqual([old, []]);
    }
  });
});
