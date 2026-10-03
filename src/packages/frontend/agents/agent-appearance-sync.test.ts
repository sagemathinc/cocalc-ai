import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  appearanceWrites,
  mergeAgentAppearances,
} from "./agent-appearance-sync";

const agent = (id: string, appearance?: NamedAgent["appearance"]) =>
  ({
    name: id,
    endpoint: { project_id: "p", agent_id: id },
    appearance,
  }) as NamedAgent;

test("stored themes show before the chat loads; a loaded chat's theme wins", () => {
  const merged = mergeAgentAppearances(
    [
      agent("a", { name: "Stored A" }),
      agent("b", { name: "Stored B" }),
      agent("c"),
    ],
    new Map([["b", { name: "Loaded B" }]]),
  );
  expect(merged.get("a")?.name).toBe("Stored A");
  expect(merged.get("b")?.name).toBe("Loaded B");
  expect(merged.has("c")).toBe(false);
});

test("only changed, unsent themes are written, normalized", () => {
  const agents = [
    agent("same", { name: "Same", thread_color: "#111111" }),
    agent("changed", { name: "Old title" }),
    agent("new"),
  ];
  const loaded = new Map([
    ["same", { name: " Same ", thread_color: "#111111", thread_icon: "" }],
    ["changed", { name: "New title" }],
    ["new", { name: "Fresh", thread_image: "blob-uuid" }],
    ["unknown", { name: "Not mine" }],
  ]);
  const sent = new Map<string, string>();
  const writes = appearanceWrites(agents, loaded, sent);
  expect(writes.map((w) => [w.agent_id, w.appearance])).toEqual([
    ["changed", { name: "New title" }],
    ["new", { name: "Fresh", thread_image: "blob-uuid" }],
  ]);
  for (const w of writes) sent.set(w.agent_id, w.key);
  expect(appearanceWrites(agents, loaded, sent)).toEqual([]);
});

test("a cleared theme is written as null; an overlong one is skipped", () => {
  expect(
    appearanceWrites(
      [agent("a", { name: "Had a theme" })],
      new Map([["a", { name: "" }]]),
      new Map(),
    )[0].appearance,
  ).toBeNull();
  expect(
    appearanceWrites(
      [agent("a")],
      new Map([["a", { name: "x".repeat(500) }]]),
      new Map(),
    ),
  ).toEqual([]);
});
