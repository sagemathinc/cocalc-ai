/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The Jupyter transport is the pure-JS ZMTP one (zmq/transport.ts).

import assert from "node:assert/strict";
import * as zmtp from "./zmtp";
import { transport } from "./transport";

describe("transport", () => {
  test("the pure-JS ZMTP sockets, the same for the whole process", () => {
    const t = transport();
    assert.equal(transport(), t);
    const d = new t.Dealer({ routingId: "x" });
    assert.ok(d instanceof zmtp.Dealer);
    d.close();
    const s = new t.Subscriber();
    assert.ok(s instanceof zmtp.Subscriber);
    s.close();
  });
});
