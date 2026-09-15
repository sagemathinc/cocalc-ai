#!/usr/bin/env node
// Read-only operator smoke. Run with the entry bay's backend environment.
// This qualifies trusted routing, not browser/session authentication.
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const assert = require("node:assert/strict");
const req = createRequire(
  resolve(__dirname, "../../packages/server/package.json"),
);

async function main() {
  if (process.env.COCALC_AGENT_MESSAGING_SMOKE !== "1")
    throw new Error(
      "set COCALC_AGENT_MESSAGING_SMOKE=1 for this operator smoke",
    );
  // Diagnostic imports must not initialize or synchronize the bay database.
  process.env.COCALC_DB_SKIP_ENSURE_EXISTS = "1";
  process.env.DEBUG_CONSOLE = "no";
  const [account_id, project_id, path, thread_id, agent_id] =
    process.argv.slice(2);
  const { requireUuid } = req("@cocalc/conat/agents/protocol");
  for (const [name, value] of Object.entries({
    account_id,
    project_id,
    agent_id,
  }))
    requireUuid(value, name);
  assert.ok(
    path && thread_id,
    "account project path thread agent arguments are required",
  );
  const { resolveProjectBay } = req("./dist/inter-bay/directory");
  const { getConfiguredBayId } = req("./dist/bay-config");
  const {
    listIdentities,
    resolveIdentity,
    getIdentity,
    listGrants,
    listMessageReceipts,
  } = req("./dist/agents/api");
  const { createInterBayAgentIdentityClient } = req(
    "@cocalc/conat/inter-bay/agent-identities",
  );
  const { getInterBayFabricClient } = req("./dist/inter-bay/fabric");
  const getPool = req("@cocalc/database/pool").default;
  const owner = await resolveProjectBay(project_id);
  assert.ok(owner, "owner must resolve");
  assert.notEqual(
    owner.bay_id,
    getConfiguredBayId(),
    "use a non-owner entry bay",
  );
  const count = async () =>
    (
      await getPool().query(
        "SELECT count(*)::integer AS n FROM agent_identities WHERE project_id=$1",
        [project_id],
      )
    ).rows[0].n;
  const before = await count();
  assert.equal(
    before,
    0,
    "fixture project must have no identities in entry bay",
  );
  const opts = { account_id, project_id, path, thread_id };
  const identity = await resolveIdentity(opts);
  assert.equal(identity.agent_id, agent_id);
  assert.equal(identity.project_id, project_id);
  const list = await listIdentities({ account_id, project_id });
  assert.equal(list.filter((a) => a.agent_id === agent_id).length, 1);
  const lookup = { account_id, project_id, agent_id };
  assert.equal((await getIdentity(lookup)).agent_id, agent_id);
  const grants = await listGrants({ ...lookup, limit: 1 });
  assert.ok(grants.items.length <= 1);
  for (const grant of grants.items)
    assert.ok(
      grant.source_agent_id === agent_id || grant.target_agent_id === agent_id,
    );
  if (grants.next_cursor) {
    const next = await listGrants({
      ...lookup,
      limit: 1,
      cursor: grants.next_cursor,
    });
    assert.ok(next.items.every((g) => g.grant_id !== grants.items[0].grant_id));
  }
  const receipts = await listMessageReceipts({ ...lookup, limit: 1 });
  assert.ok(receipts.items.length <= 1);
  if (receipts.next_cursor) {
    const next = await listMessageReceipts({
      ...lookup,
      limit: 1,
      cursor: receipts.next_cursor,
    });
    assert.ok(
      next.items.every((m) => m.message_id !== receipts.items[0].message_id),
    );
  }
  const peer = createInterBayAgentIdentityClient({
    client: getInterBayFabricClient(),
    bay_id: owner.bay_id,
  });
  await assert.rejects(
    peer.list({
      account_id,
      project_id,
      route: { bay_id: "wrong-owner", epoch: owner.epoch },
    }),
    /stale agent identity project routing/,
  );
  assert.equal(
    await count(),
    before,
    "read must not copy identity into entry bay",
  );
  console.log(
    JSON.stringify({
      entry_bay: getConfiguredBayId(),
      owner_bay: owner.bay_id,
      project_id,
      agent_id,
      entry_identity_count: before,
      stale_route_rejected: true,
      read_only: true,
      project_qualified_inspection: true,
      link_pagination_checked: !!grants.next_cursor,
      receipt_pagination_checked: !!receipts.next_cursor,
      browser_auth_qualified: false,
    }),
  );
}
main().then(
  async () => {
    await new Promise((r) => process.stdout.write("", r));
    process.exit(0);
  },
  async (e) => {
    console.error(e.message);
    await new Promise((r) => process.stderr.write("", r));
    process.exit(1);
  },
);
