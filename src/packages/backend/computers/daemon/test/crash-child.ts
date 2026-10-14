/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A real daemon process for crash-point tests (../crash.test.ts): it starts
// the given work, applies a signed state, and SIGKILLs itself at the named
// crash point; or, restarted on the same state directory, it reconciles,
// replays the state (as the hub redelivers an unacknowledged one) and
// drains. Run with ts-node: node -r ts-node/register crash-child.ts CONFIG.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HubClock, SessionClock, systemClocks } from "../clock";
import { ComputerDaemon } from "../daemon";
import { DaemonStore } from "../state";

interface Config {
  dir: string;
  /** e.g. "state-saved", "side-effect#2", "before-ack" */
  crashAt?: string;
  messages?: { ticket: unknown; proof: unknown; request: unknown }[];
  /** Files the work writes its pid to; wait for them before applying. */
  pidFiles?: string[];
  state?: unknown;
  /** Leave without draining (the work keeps running). */
  noDrain?: boolean;
  out: string;
}

const config: Config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const counts: Record<string, number> = {};
/** Crash points count only while the state is applied (not at start). */
let armed = false;

function crashPoint(point: string): void {
  if (!armed) return;
  counts[point] = (counts[point] ?? 0) + 1;
  if (
    config.crashAt === point ||
    config.crashAt === `${point}#${counts[point]}`
  ) {
    process.kill(process.pid, "SIGKILL");
  }
}

async function main() {
  const store = DaemonStore.open(join(config.dir, "state"));
  if (store == null) throw new Error("no daemon state");
  const hubClock = new HubClock(systemClocks);
  hubClock.observe(0);
  // Constructing it reconciles with the durable state (a restart).
  const daemon = new ComputerDaemon({
    stateDir: config.dir,
    store,
    clocks: systemClocks,
    hubClock,
    session: new SessionClock(systemClocks, {
      deadline_ms: null,
      max_ms: null,
    }),
    workdir: join(config.dir, "work"),
    shell: "/bin/bash",
    killGraceMs: 200,
    fault: crashPoint,
  });
  daemon.start(100);
  const replies: unknown[] = [];
  for (const m of config.messages ?? []) {
    const p = daemon.handle({ ...m, received_at: systemClocks.continuous() });
    // An exec answers only when it ends: don't wait for it.
    if ((m.request as any)?.description != null) replies.push(await p);
    else void p.catch(() => {});
  }
  const deadline = Date.now() + 10_000;
  while (!(config.pidFiles ?? []).every((f) => existsSync(f))) {
    if (Date.now() > deadline) throw new Error("the work did not start");
    await new Promise((r) => setTimeout(r, 25));
  }
  let ack: unknown;
  if (config.state != null) {
    armed = true;
    ack = daemon.applyState(config.state);
    // The connector publishes the ack next.
    crashPoint("before-ack");
  }
  const drained = config.noDrain ? null : await daemon.drain(10_000, 50);
  writeFileSync(
    config.out,
    JSON.stringify({
      replies,
      ack,
      drained,
      ended: store.ended,
      floors: store.state.floors,
    }),
  );
  daemon.stop();
  process.exit(0);
}

main().catch((err) => {
  writeFileSync(config.out, JSON.stringify({ error: `${err?.stack ?? err}` }));
  process.exit(1);
});
