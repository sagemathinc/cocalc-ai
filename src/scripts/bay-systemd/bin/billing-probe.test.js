"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  normalizeBillingEnabled,
  billingGeneration,
  readyAfterGeneration,
} = require("./billing-probe");

test("enablement matches Node trim/lowercase semantics", () => {
  for (const value of [
    "1",
    "true",
    "TRUE",
    "Yes",
    " true ",
    " yes ",
    "\tTRUE\r\n",
    "\uFEFFyes\u00a0",
  ]) {
    assert.equal(normalizeBillingEnabled(value), "1");
  }
  for (const value of [
    undefined,
    "",
    "0",
    "false",
    " true false ",
    "invalid",
  ]) {
    assert.equal(normalizeBillingEnabled(value), "0");
  }
});

test("snapshots can capture unready authority but reject malformed health", () => {
  assert.equal(billingGeneration({ ready: false, generation: 7 }), 7);
  assert.equal(billingGeneration({ ready: false }), 0);
  for (const health of [
    null,
    {},
    { ready: true },
    { ready: false, generation: -1 },
    { ready: true, generation: "7" },
  ]) {
    assert.throws(() => billingGeneration(health));
  }
});

test("replacement needs a strictly newer ready generation", () => {
  assert.equal(
    readyAfterGeneration({ ready: true, generation: 7 }, "7"),
    false,
  );
  assert.equal(
    readyAfterGeneration({ ready: true, generation: 6 }, "7"),
    false,
  );
  assert.equal(
    readyAfterGeneration({ ready: false, generation: 8 }, "7"),
    false,
  );
  assert.equal(readyAfterGeneration({ ready: true, generation: 8 }, "7"), true);
  for (const previous of [undefined, "", "bad", "-1", "9007199254740992"]) {
    assert.throws(() =>
      readyAfterGeneration({ ready: true, generation: 8 }, previous),
    );
  }
});
