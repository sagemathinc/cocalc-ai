/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The hand-off between agent and human for a .browser file's browser running on
this computer (`cocalc project browser connect --browser <file>`), in the
terminal that connected it (plan J7, option C).

The human uses the Chrome window on this computer, not CoCalc's viewer card,
so the card's Take over / Hand back controls are out of reach. This shows who
drives in the terminal and takes keys: t takes over, h hands back. When the
agent asks the human to take over (`project browser ask-human`), the terminal
says so, with a desktop notification where the system has one.

It talks to the file's browser service in the project, the same HTTP API the
CLI uses inside the project (/api/state, /api/driver), through a local ssh
forward. The service already enforces the hand-off (agent commands wait while
the human drives); this only lets the human set and see it from here.
*/

import { spawn } from "node:child_process";
import type {
  Driver,
  SharedBrowserState,
} from "@cocalc/util/shared-browser-protocol";

export type HandoffState = Pick<
  SharedBrowserState,
  "driver" | "ask" | "agentWaiting"
>;

/** What to tell the human when the state changes (nothing if nothing did). */
export function handoffMessages(
  previous: HandoffState | null,
  next: HandoffState,
): string[] {
  const lines: string[] = [];
  if (previous?.driver !== next.driver)
    lines.push(
      next.driver === "human"
        ? "You're driving: the agent waits. Press h to hand back."
        : "The agent is driving. Press t to take over.",
    );
  if (next.ask && next.ask.at !== previous?.ask?.at)
    lines.push(
      `The agent asks you to take over: ${next.ask.message}${next.driver === "agent" ? " (press t)" : ""}`,
    );
  if (next.driver === "human" && next.agentWaiting && !previous?.agentWaiting)
    lines.push("The agent is waiting for you to hand back (press h).");
  return lines;
}

/** The driver a key asks for, if it is one of ours. */
export function driverForKey(key: string): Driver | undefined {
  const k = key.toLowerCase();
  if (k === "t") return "human";
  if (k === "h") return "agent";
  return;
}

export interface HandoffApi {
  state(): Promise<HandoffState>;
  setDriver(driver: Driver): Promise<HandoffState>;
}

/** The service's API at a local forward of its port. */
export function handoffApi(
  port: number,
  fetchImpl: typeof fetch = fetch,
): HandoffApi {
  const base = `http://127.0.0.1:${port}`;
  const read = async (res: Response) => {
    if (!res.ok) throw new Error(`browser service: ${res.status}`);
    return (await res.json()) as HandoffState;
  };
  return {
    state: async () => read(await fetchImpl(`${base}/api/state`)),
    setDriver: async (driver) =>
      read(
        await fetchImpl(`${base}/api/driver`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ driver }),
        }),
      ),
  };
}

/** A desktop notification, where the system has one; never fails. */
export function notifyDesktop(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawn = spawn,
): void {
  const command =
    platform === "darwin"
      ? [
          "osascript",
          [
            "-e",
            `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
          ],
        ]
      : platform === "linux"
        ? ["notify-send", [title, body]]
        : null;
  if (!command) return;
  try {
    const child = run(command[0] as string, command[1] as string[], {
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // No notifier here: the terminal line is enough.
  }
}

export interface Handoff {
  /** Handle a key typed in the terminal. */
  key(key: string): Promise<void>;
  /** Read the state once and report what changed. */
  poll(): Promise<void>;
  stop(): void;
}

/**
 * Polls the service every `intervalMs` and reports changes with `say`; keys
 * set the driver. Errors are reported once until it works again.
 */
export function startHandoff({
  api,
  say,
  notify = notifyDesktop,
  intervalMs = 1_000,
}: {
  api: HandoffApi;
  say: (line: string) => void;
  notify?: (title: string, body: string) => void;
  intervalMs?: number;
}): Handoff {
  let last: HandoffState | null = null;
  let failing = false;
  let stopped = false;
  const report = (next: HandoffState) => {
    const previous = last;
    last = next;
    for (const line of handoffMessages(previous, next)) say(line);
    if (next.ask && next.ask.at !== previous?.ask?.at && previous != null)
      notify("The agent asks you to take over", next.ask.message);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      report(await api.state());
      if (failing) say("Hand-off controls are back.");
      failing = false;
    } catch (err) {
      if (!failing)
        say(
          `Hand-off controls unavailable for now (${(err as Error)?.message ?? err}); the browser keeps working.`,
        );
      failing = true;
    }
  };
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref?.();
  return {
    poll,
    key: async (key) => {
      const driver = driverForKey(key);
      if (!driver || stopped) return;
      try {
        report(await api.setDriver(driver));
      } catch (err) {
        say(
          `Could not ${driver === "human" ? "take over" : "hand back"}: ${(err as Error)?.message ?? err}`,
        );
      }
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
