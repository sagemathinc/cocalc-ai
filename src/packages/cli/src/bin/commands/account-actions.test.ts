import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerAccountCommand } from "./account";

const review = {
  request_id: "11111111-1111-4111-8111-111111111111",
  action: { kind: "revoke_api_key", target_key_id: "target-key" },
  binding: {
    account_id: "22222222-2222-4222-8222-222222222222",
    requesting_key_id: "requester-key",
    requesting_scope_revision: 1,
    target_key_id: "target-key",
    target_scope_revision: 2,
  },
  target_name: "Target",
  target_trunc: "abc",
  created_at: 1000,
  expires_at: 2000,
  status: "pending",
};

function programFor(ctx: any, output = (_value: any) => {}) {
  const program = new Command();
  registerAccountCommand(program, {
    withContext: async (_command, _label, fn) => output(await fn(ctx)),
    toIso: (x) => x,
  } as any);
  return program;
}

test("managed request uses the credential file and exact retry id without primary Hub fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "key-action-"));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "synthetic-secret", { mode: 0o600 });
    globalThis.fetch = (async (url, opts) => {
      calls++;
      assert.equal(
        `${url}`,
        "https://example.invalid/api/conat/api-key-action",
      );
      assert.equal(opts.headers.Authorization, "Bearer synthetic-secret");
      assert.deepEqual(JSON.parse(opts.body), {
        request_id: review.request_id,
        action: review.action,
      });
      return { ok: true, json: async () => review };
    }) as any;
    const ctx = {
      apiBaseUrl: "https://example.invalid",
      managedConnector: { keyFile, sourceProjectId: review.binding.account_id },
      hub: new Proxy(
        {},
        {
          get() {
            throw new Error("primary fallback");
          },
        },
      ),
    };
    let output: any;
    await programFor(ctx, (x) => {
      output = x;
    }).parseAsync([
      "node",
      "cli",
      "account",
      "api-key",
      "request-revocation",
      "target-key",
      "--request-id",
      review.request_id,
    ]);
    assert.deepEqual(output, review);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("human decision accepts CLI JSON output and sends only exact review and decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "key-action-"));
  try {
    const file = join(dir, "review.json");
    writeFileSync(
      file,
      JSON.stringify({
        ok: true,
        command: "account api-key request-revocation",
        data: review,
      }),
    );
    let captured: any;
    const ctx = {
      accountId: review.binding.account_id,
      hub: {
        apiKeys: {
          decideAction: async (opts) => {
            captured = opts;
            return { ...review, status: "executed" };
          },
        },
      },
    };
    const args = [
      "node",
      "cli",
      "account",
      "api-key",
      "decide-action",
      file,
      "--decision",
      "execute",
      "--target-key-id",
      "target-key",
    ];
    await programFor(ctx).parseAsync(args);
    assert.deepEqual(captured, { reviewed: review, decision: "execute" });
    for (const override of [
      { apiKey: "key" },
      { managedConnector: {} },
      { remote: { user: { auth_actor: "agent" } } },
      { accountId: "other" },
    ]) {
      captured = undefined;
      await assert.rejects(
        programFor({ ...ctx, ...override }).parseAsync(args),
      );
      assert.equal(captured, undefined);
    }
    captured = undefined;
    await assert.rejects(
      programFor(ctx).parseAsync([...args.slice(0, -1), "different-key"]),
      /target confirmation/,
    );
    assert.equal(captured, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request without a scoped credential does not fall back to an account session", async () => {
  await assert.rejects(
    programFor({}).parseAsync([
      "node",
      "cli",
      "account",
      "api-key",
      "request-revocation",
      "target-key",
      "--request-id",
      review.request_id,
    ]),
    /scoped API key/,
  );
});
