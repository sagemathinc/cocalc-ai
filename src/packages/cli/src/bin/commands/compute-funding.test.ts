import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import { registerComputeFundingCommand } from "./compute-funding";

const id = "11111111-1111-4111-8111-111111111111";
function harness(user = {}, attempts = 1) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerComputeFundingCommand(program, {
    readTerms: () => JSON.stringify({ action: "close", pool_id: id }),
    withContext: async (_cmd, _name, fn) => {
      for (let i = 0; i < attempts; i++)
        await fn({
          remote: { user },
          hub: {
            computeFunding: new Proxy(
              {},
              {
                get: (_, name) => async (args) => {
                  calls.push({ name: String(name), args });
                  return {
                    id,
                    status: "pending",
                    approval_url: "https://approval.test",
                  };
                },
              },
            ),
          },
        });
    },
  });
  return {
    program,
    calls,
    run: (...args: string[]) =>
      program.parseAsync(["computeFunding", ...args], { from: "user" }),
  };
}
it("requires an explicit payer and authoritative bay for the read-only audit", async () => {
  const h = harness();
  await assert.rejects(h.run("audit", "--payer", id));
  assert.equal(h.calls.length, 0);
  await h.run("audit", "--payer", id, "--bay", "payer-home");
  assert.deepEqual(h.calls, [
    { name: "audit", args: { payer_account_id: id, bay_id: "payer-home" } },
  ]);
});
it("routes source discovery and summaries through the funding namespace", async () => {
  const h = harness();
  await h.run("sources");
  await h.run("summary", "--course-project", id, "--course-instance", id);
  assert.deepEqual(h.calls, [
    { name: "listSources", args: undefined },
    {
      name: "getCourseSummary",
      args: { course_project_id: id, course_instance_id: id },
    },
  ]);
});
it("proposes exact pool terms with stable operation IDs across context retries", async () => {
  const h = harness({}, 2);
  await h.run("propose-change", "--terms", "terms.json", "--operation", id);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0], h.calls[1]);
  assert.deepEqual(h.calls[0], {
    name: "proposePoolChange",
    args: { operation_id: id, terms: { action: "close", pool_id: id } },
  });
});
it("previews and polls without exposing any approval command", async () => {
  const h = harness();
  await h.run("preview-change", "--terms", "-");
  await h.run("status", id);
  assert.deepEqual(
    h.calls.map((c) => c.name),
    ["previewPoolChange", "getAllocationStatus"],
  );
  await assert.rejects(h.run("approve", id));
});
it("rejects project and agent credentials before any financial RPC", async () => {
  for (const user of [
    { project_id: id },
    { auth_actor: "agent" },
    { host_id: id },
  ]) {
    const h = harness(user);
    await assert.rejects(h.run("sources"), /account authentication/);
    assert.equal(h.calls.length, 0);
  }
});
it("requires an explicit operation ID for a financial proposal", async () => {
  const h = harness();
  await assert.rejects(h.run("propose-allocation", "--terms", "terms.json"));
  assert.equal(h.calls.length, 0);
});

it("requests complete inactive history only when explicitly selected", async () => {
  const h = harness();
  await h.run("sources", "--include-inactive");
  assert.deepEqual(h.calls, [
    { name: "listSources", args: { include_inactive: true } },
  ]);
});
