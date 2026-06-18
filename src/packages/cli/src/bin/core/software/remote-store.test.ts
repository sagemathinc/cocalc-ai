import assert from "node:assert/strict";
import test from "node:test";

import { loadDefaultSoftwareR2Client } from "./remote-store";

test("software R2 loader exposes backend helper functions", () => {
  const client = loadDefaultSoftwareR2Client();
  assert.equal(typeof client.putR2ObjectFromFile, "function");
  assert.equal(typeof client.putR2ObjectFromBuffer, "function");
  assert.equal(typeof client.getR2ObjectBuffer, "function");
  assert.equal(typeof client.copyR2Object, "function");
});
