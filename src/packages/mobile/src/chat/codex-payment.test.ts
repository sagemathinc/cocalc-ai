/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  codexPaymentCredential,
  codexPaymentPreference,
  storedCodexCredential,
} from "./codex-payment";

const credential = (credential_id: string) => ({
  version: 1,
  provider: "codex",
  mode: "credential",
  credential_id,
});
const agentWith = (result: any) => ({
  getPaymentSelections: async () => result,
});
const stale = { paymentSource: "subscription", credentialId: "removed" };

test("uses the agent's selection, else the account default, never a stale shared pin", async () => {
  const pinned = agentWith({
    selections: [
      { thread_id: "t", provider: "codex", selection: credential("pinned") },
    ],
    defaults: { codex: credential("default") },
  });
  assert.equal(await codexPaymentCredential(pinned, "p", "t", stale), "pinned");
  const followsDefault = agentWith({
    selections: [],
    defaults: { codex: credential("default") },
  });
  assert.equal(
    await codexPaymentCredential(followsDefault, "p", "t", stale),
    "default",
  );
  // The hub answered with no choice: it uses the designated default, so the
  // removed credential in shared config must not be checked.
  const none = agentWith({ selections: [], defaults: {} });
  assert.equal(await codexPaymentCredential(none, "p", "t", stale), undefined);
});

test("falls back to the thread's saved credential only when the hub cannot answer", async () => {
  assert.equal(
    await codexPaymentCredential(undefined, "p", "t", stale),
    "removed",
  );
  const failing = {
    getPaymentSelections: async () => {
      throw Error("offline");
    },
  };
  assert.equal(
    await codexPaymentCredential(failing, "p", "t", stale),
    "removed",
  );
  assert.equal(
    await codexPaymentCredential(undefined, "p", "t", {
      paymentSource: "auto",
      credentialId: "x",
    }),
    undefined,
  );
  assert.deepEqual(
    await storedCodexCredential(
      agentWith({ selections: [], defaults: { codex: credential("d") } }),
      "p",
      "t",
    ),
    { resolved: true, credentialId: "d", defaultCredentialId: "d" },
  );
});

test("treats a legacy subscription-credential source as a ChatGPT subscription", async () => {
  assert.equal(
    codexPaymentPreference("subscription-credential"),
    "subscription",
  );
  assert.equal(codexPaymentPreference("auto"), "auto");
  assert.equal(codexPaymentPreference(undefined), undefined);
  const followsDefault = agentWith({
    selections: [],
    defaults: { codex: credential("default") },
  });
  assert.equal(
    await codexPaymentCredential(followsDefault, "p", "t", {
      paymentSource: "subscription-credential",
      credentialId: "removed",
    }),
    "default",
  );
});
