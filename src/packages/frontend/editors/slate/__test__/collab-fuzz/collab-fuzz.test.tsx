/** @jest-environment jsdom */

/*
Randomized multi-client collaboration test for the Markdown frame editor.

Oracle (see the hardening plan): every inserted fragment carries a unique
token. After the network is quiet, all clients must converge, no token may be
duplicated, no token that nobody deleted may be lost, and every editor must show
its synced document.

FUZZ_RUNS (default 6) and FUZZ_SEED (default 1) select the seeds; a failure
prints its seed so it can be replayed with FUZZ_SEED=<seed> FUZZ_RUNS=1.
Other knobs: FUZZ_STEPS (operations per session), FUZZ_VERBOSE (print the
operation log and final document), FUZZ_TRACE_TOKEN (track one token after
every step), FUZZ_SLATE_DEBUG (enable the editor's sync debug log), and
FUZZ_STRICT_MERGE (fail on known core merge losses too).
*/

import { encodePatchId, StringDocument } from "patchflow";
import { Editor } from "slate";
import {
  blur,
  canonical,
  focus,
  makeRng,
  markdown_to_slate,
  pick,
  SimClient,
  SimNetwork,
  step,
  textEntries,
  tokensIn,
  Transforms,
  type Rng,
} from "./harness";

jest.mock("@cocalc/frontend/editors/markdown-input/mentionable-users", () => ({
  useMentionableUsers: () => () => [],
}));

const RUNS = Number(process.env.FUZZ_RUNS ?? 6);
const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);

const INITIAL = [
  "# Meeting",
  "",
  "- attendees tka0q",
  "- - nested tka1q",
  "",
  "Some notes tka2q here.",
  "",
  "| a | b |",
  "| - | - |",
  "| tka3q | 1 |",
  "",
  "## Actions",
  "",
  "1. first tka4q",
  "2. second tka5q",
  "",
].join("\n");

const initialHas = (tok: string) => INITIAL.includes(tok);

// Where did a lost token go? See the hardening plan.
function classifyLoss(
  tok: string,
  clients: SimClient[],
  inInitial: boolean,
): string {
  const everCommitted =
    inInitial ||
    clients.some((c) => c.commits.some((commit) => commit.after.includes(tok)));
  if (!everCommitted) return "never committed";
  for (const c of clients) {
    for (const commit of c.commits) {
      if (commit.before.includes(tok) && !commit.after.includes(tok)) {
        return `removed by a c${c.opts.id} ${commit.source ?? "?"} commit`;
      }
    }
  }
  return "lost in merge";
}

interface RunResult {
  seed: number;
  problems: string[];
  log: string[];
}

// Seeds that found integration bugs; always run them as regression tests.
//   38 (40 steps): unsaved edit dropped by back-to-back remote updates
//   42 (80 steps): stale syncCausedUpdate made a local edit look remote
//  107 (80 steps): unsaved edit dropped after the editor canonicalized a merge
const REGRESSION_SEEDS: { seed: number; steps: number }[] = [
  { seed: 38, steps: 40 },
  { seed: 42, steps: 80 },
  { seed: 107, steps: 80 },
];

async function runSession(seed: number, steps = STEPS): Promise<RunResult> {
  const rng: Rng = makeRng(seed);
  const log: string[] = [];
  const problems: string[] = [];
  const now = () => Date.now();
  const net = new SimNetwork(rng, now, 400);
  const initialPatch = {
    time: encodePatchId(1_000, "init"),
    wall: 1_000,
    patch: new StringDocument("").makePatch(new StringDocument(INITIAL)),
    parents: [],
    userId: 0,
    version: 1,
  };
  if (process.env.FUZZ_SLATE_DEBUG) (window as any).__slateDebugLog = true;
  const nClients = 2 + Math.floor(rng() * 3);
  const clients: SimClient[] = [];
  for (let id = 0; id < nClients; id++) {
    const client = new SimClient(
      { id, hasSourceFrame: rng() < 0.5 },
      net,
      now,
      [initialPatch as any],
    );
    await step(() => client.start(INITIAL));
    clients.push(client);
  }
  log.push(
    `clients: ${clients.map((c) => `c${c.opts.id}${c.opts.hasSourceFrame ? "+cm" : ""}`).join(" ")}`,
  );

  const traced = process.env.FUZZ_TRACE_TOKEN;
  const trace = (label: string) => {
    if (!traced) return;
    const where = clients
      .map(
        (c) =>
          `c${c.opts.id}[editor:${c.editor && c.shown().includes(traced) ? "Y" : "-"} doc:${c.doc().includes(traced) ? "Y" : "-"}]`,
      )
      .join(" ");
    log.push(`  trace ${traced} ${label}: ${where}`);
  };
  const inserted = new Set<string>(tokensIn(INITIAL));
  const deleted = new Set<string>();
  let seq = 0;
  const newToken = (c: SimClient) =>
    `tk${String.fromCharCode(98 + c.opts.id)}${++seq}q`;

  const ops: Record<string, (c: SimClient) => void> = {
    insertToken(c) {
      const entries = textEntries(c.editor);
      if (entries.length === 0) return;
      const [node, path] = pick(rng, entries);
      const spaces = [0, node.text.length];
      for (let i = 0; i < node.text.length; i++) {
        if (node.text[i] === " ") spaces.push(i + 1);
      }
      const offset = pick(rng, spaces);
      const token = newToken(c);
      inserted.add(token);
      const types = Array.from(Editor.levels(c.editor, { at: path }))
        .map(
          ([n]: any) =>
            n.type ?? (typeof n.text === "string" ? "text" : "editor"),
        )
        .join(">");
      log.push(
        `c${c.opts.id} insertToken ${token} at ${path}:${offset} (${types})${c.editor.syncCausedUpdate ? " [syncCausedUpdate still set]" : ""}`,
      );
      if (process.env.FUZZ_SLATE_DEBUG) {
        // eslint-disable-next-line no-console
        console.log(`### c${c.opts.id} insertToken ${token}`);
      }
      const tracing = process.env.FUZZ_TRACE_TOKEN === token;
      if (tracing) {
        log.push(
          `  node before: ${JSON.stringify(Editor.node(c.editor, path.slice(0, 1))[0])}`,
        );
      }
      Transforms.insertText(c.editor, ` ${token} `, {
        at: { path, offset },
      });
      if (tracing) {
        log.push(
          `  serialized right after insert: ${c.shown().includes(token)}`,
        );
        queueMicrotask(() =>
          log.push(
            `  serialized after microtasks: ${c.shown().includes(token)} (block now: ${JSON.stringify(c.editor.children[path[0]])})`,
          ),
        );
      }
    },
    deleteToken(c) {
      const hits: { path: number[]; offset: number; token: string }[] = [];
      for (const [node, path] of textEntries(c.editor)) {
        for (const m of node.text.matchAll(/tk[a-z]\d+q/g)) {
          hits.push({ path, offset: m.index!, token: m[0] });
        }
      }
      if (hits.length === 0) return;
      const hit = pick(rng, hits);
      deleted.add(hit.token);
      Transforms.delete(c.editor, {
        at: {
          anchor: { path: hit.path, offset: hit.offset },
          focus: { path: hit.path, offset: hit.offset + hit.token.length },
        },
      });
      log.push(`c${c.opts.id} deleteToken ${hit.token}`);
    },
    insertBlock(c) {
      const t = () => {
        const token = newToken(c);
        inserted.add(token);
        return token;
      };
      const fragment = pick(rng, [
        () => `- - ${t()} nested\n- ${t()} flat\n`,
        () => `| x | y |\n| - | - |\n| ${t()} | ${t()} |\n`,
        () => `## Heading ${t()}\n`,
        () => `> quoted ${t()}\n`,
        () => `1. one ${t()}\n   - sub ${t()}\n`,
      ])();
      const nodes = markdown_to_slate(fragment, false, {});
      const at = Math.floor(rng() * (c.editor.children.length + 1));
      Transforms.insertNodes(c.editor, nodes as any, { at: [at] });
      log.push(
        `c${c.opts.id} insertBlock at ${at}: ${JSON.stringify(fragment)}`,
      );
    },
    sourceEdit(c) {
      if (!c.opts.hasSourceFrame) return;
      // A person cannot move from the Slate frame to the source frame faster
      // than Slate's save debounce, and switching frames flushes Slate. Let the
      // debounced save run first. (Programmatic source changes that bypass this
      // are tracked separately in the audit.)
      jest.advanceTimersByTime(200);
      const doc = c.doc();
      const lines = doc.split("\n");
      const kind = pick(rng, ["nest", "unnest", "bold", "line"]);
      let next = doc;
      if (kind === "nest" || kind === "unnest") {
        const idx = lines
          .map((line, i) => [line, i] as const)
          .filter(([line]) =>
            kind === "nest" ? /^- (?!- )/.test(line) : /^- - /.test(line),
          )
          .map(([, i]) => i);
        if (idx.length === 0) return;
        const i = pick(rng, idx);
        lines[i] =
          kind === "nest"
            ? lines[i].replace(/^- /, "- - ")
            : lines[i].replace(/^- - /, "- ");
        next = lines.join("\n");
      } else if (kind === "bold") {
        const tokens = tokensIn(doc).filter(
          (tok) => !doc.includes(`**${tok}**`),
        );
        if (tokens.length === 0) return;
        const tok = pick(rng, tokens);
        next = doc.replace(tok, `**${tok}**`);
      } else {
        const token = newToken(c);
        inserted.add(token);
        const i = Math.floor(rng() * (lines.length + 1));
        lines.splice(i, 0, "", `source line ${token}`, "");
        next = lines.join("\n");
      }
      if (next === doc) return;
      c.actions.set_value(next, undefined, "cm");
      log.push(`c${c.opts.id} sourceEdit ${kind}`);
    },
    focus(c) {
      focus(c);
      log.push(`c${c.opts.id} focus`);
    },
    blur(c) {
      blur(c);
      log.push(`c${c.opts.id} blur`);
    },
  };
  const weighted = [
    ...Array(6).fill("insertToken"),
    ...Array(3).fill("deleteToken"),
    ...Array(2).fill("insertBlock"),
    ...Array(3).fill("sourceEdit"),
    "focus",
    "blur",
  ];

  for (let i = 0; i < steps; i++) {
    const c = pick(rng, clients);
    const op = pick(rng, weighted);
    await step(() => {
      try {
        ops[op](c);
      } catch (err) {
        log.push(`c${c.opts.id} ${op} threw: ${err}`);
      }
    });
    const dt = Math.floor(rng() * 300);
    await step(() => {
      jest.advanceTimersByTime(dt);
      net.deliverDue();
    });
    trace(`after step ${i} (+${dt}ms)`);
    if (process.env.FUZZ_SLATE_DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`### end step ${i}`);
    }
  }

  // Quiesce: deliver everything and let debounced saves and deferred merges run.
  let stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const before = clients.map((c) => c.doc()).join("\u0000");
    await step(() => {
      net.deliverDue(true);
      jest.advanceTimersByTime(3_000);
    });
    const after = clients.map((c) => c.doc()).join("\u0000");
    stable = before === after && net.pending() === 0 ? stable + 1 : 0;
  }

  const docs = clients.map((c) => c.doc());
  if (new Set(docs).size !== 1) {
    problems.push("clients did not converge");
  }
  const final = docs[0];
  const mergeLosses: string[] = [];
  const counts = new Map<string, number>();
  for (const tok of tokensIn(final))
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  for (const [tok, n] of counts) {
    if (n > 1) problems.push(`duplicated token ${tok} (x${n})`);
  }
  for (const tok of inserted) {
    if (!deleted.has(tok) && !counts.has(tok)) {
      const cause = classifyLoss(tok, clients, initialHas(tok));
      if (cause === "lost in merge" && !process.env.FUZZ_STRICT_MERGE) {
        // Known core merge limitation (see core-merge-limitations.test.ts);
        // reported but not failing unless FUZZ_STRICT_MERGE is set.
        mergeLosses.push(tok);
      } else {
        problems.push(`lost token ${tok} (${cause})`);
      }
    }
  }
  for (const c of clients) {
    if (c.editor == null) continue;
    // Compare modulo whitespace: whitespace-only rendering differences are
    // cosmetic; content, structure, and numbering differences are not.
    const squash = (text: string) =>
      text
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => line !== "")
        .join("\n");
    const shown = squash(c.shown());
    const expected = squash(canonical(c.doc()));
    if (shown !== expected) {
      const a = shown.split("\n");
      const b = expected.split("\n");
      let i = 0;
      while (i < a.length && a[i] === b[i]) i++;
      problems.push(
        `c${c.opts.id} editor does not show its document (line ${i}: editor=${JSON.stringify(a.slice(i, i + 3))} doc=${JSON.stringify(b.slice(i, i + 3))})`,
      );
    }
  }
  if (mergeLosses.length > 0) {
    log.unshift(`known core merge losses: ${mergeLosses.join(" ")}`);
    // eslint-disable-next-line no-console
    console.warn(
      `seed ${seed}: known core merge loss of ${mergeLosses.join(" ")}`,
    );
  }
  const stats = `patches=${net.log.length} inserted=${inserted.size} deleted=${deleted.size} final=${final.length} chars, ${counts.size} tokens`;
  if (process.env.FUZZ_VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(
      `seed ${seed}: ${stats}\n${log.join("\n")}\n--- final ---\n${final}`,
    );
  }
  for (const c of clients) c.stop();
  return { seed, problems, log: [stats, ...log] };
}

// FUZZ_MERGE_TRACE=<token>: log SimpleInputMerge inputs whenever a merge drops
// the token from the local value.
if (process.env.FUZZ_MERGE_TRACE) {
  const {
    SimpleInputMerge,
  } = require("@cocalc/sync/editor/generic/simple-input-merge");
  const token = process.env.FUZZ_MERGE_TRACE;
  const originalResolve = SimpleInputMerge.prototype.resolveLocal;
  SimpleInputMerge.prototype.resolveLocal = function (observed: string) {
    const out = originalResolve.call(this, observed);
    (this as any).__lastResolve = out;
    return out;
  };
  const original = SimpleInputMerge.prototype.handleRemote;
  SimpleInputMerge.prototype.handleRemote = function (opts: any) {
    const last = (this as any).last;
    const requested = (this as any).requestedLocalUpdate;
    const pending = [...(this as any).pending];
    const local = opts.getLocal();
    return original.call(this, {
      ...opts,
      applyMerged: (merged: string) => {
        if (local.includes(token) && !merged.includes(token)) {
          // eslint-disable-next-line no-console
          console.log(
            `MERGE DROPPED ${token}: ${JSON.stringify({ last, local, remote: opts.remote, merged, pending, requested, resolved: (this as any).__lastResolve })}`,
          );
        }
        opts.applyMerged(merged);
      },
    });
  };
}

describe("collaborative markdown editing fuzz", () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
    jest.setSystemTime(10_000);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const runs: { seed: number; steps: number; label: string }[] = [];
  if (process.env.FUZZ_SEED == null) {
    for (const r of REGRESSION_SEEDS) {
      runs.push({
        ...r,
        label: `regression seed ${r.seed} (${r.steps} steps)`,
      });
    }
  }
  for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS; seed++) {
    runs.push({ seed, steps: STEPS, label: `seed ${seed}` });
  }
  for (const { seed, steps, label } of runs) {
    test(
      label,
      async () => {
        const result = await runSession(seed, steps);
        if (result.problems.length > 0) {
          throw new Error(
            `seed ${seed}: ${result.problems.join("; ")}\n` +
              result.log.slice(-40).join("\n"),
          );
        }
      },
      120_000,
    );
  }
});
