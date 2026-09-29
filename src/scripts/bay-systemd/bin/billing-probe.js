#!/usr/bin/env node
"use strict";

function normalizeBillingEnabled(value) {
  return ["1", "true", "yes"].includes(`${value ?? ""}`.trim().toLowerCase())
    ? "1"
    : "0";
}

function billingGeneration(health) {
  if (health == null || typeof health.ready !== "boolean") {
    throw new Error("invalid billing health response");
  }
  const generation = health.generation ?? (health.ready ? undefined : 0);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("invalid billing generation");
  }
  return generation;
}

function readyAfterGeneration(health, previous) {
  if (
    !/^(0|[1-9][0-9]*)$/.test(previous) ||
    !Number.isSafeInteger(Number(previous))
  ) {
    throw new Error("invalid previous billing generation");
  }
  return billingGeneration(health) > Number(previous) && health.ready === true;
}

module.exports = {
  normalizeBillingEnabled,
  billingGeneration,
  readyAfterGeneration,
};

if (require.main === module) {
  try {
    const mode = process.argv[2];
    if (mode === "enabled") {
      process.stdout.write(
        normalizeBillingEnabled(process.env.COCALC_BILLING_AUTHORITY_ENABLED),
      );
    } else {
      const health = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (mode === "generation") {
        process.stdout.write(`${billingGeneration(health)}\n`);
      } else if (mode === "ready-after") {
        process.exitCode = readyAfterGeneration(health, process.argv[3])
          ? 0
          : 1;
      } else {
        throw new Error("unknown billing probe mode");
      }
    }
  } catch {
    process.stderr.write("invalid billing probe input\n");
    process.exitCode = 1;
  }
}
