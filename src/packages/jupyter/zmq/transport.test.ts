/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// COCALC_JUPYTER_ZMQ: the default, the native fallback, and the errors that
// replace any silent fallback (zmq/transport.ts).

import assert from "node:assert/strict";
import * as zmtp from "./zmtp";
import { selectTransport } from "./transport";

describe("COCALC_JUPYTER_ZMQ", () => {
  test("unset, empty or js: the pure-JS transport", () => {
    for (const v of [undefined, "", "js"]) {
      const t = selectTransport(v);
      assert.equal(t.name, "js");
      const d = new t.Dealer({ routingId: "x" });
      assert.ok(d instanceof zmtp.Dealer);
      d.close();
    }
  });

  test("native: zeromq.js, when the build has it", () => {
    const fake = { Dealer: class {}, Subscriber: class {}, context: { blocky: true } };
    const t = selectTransport("native", () => fake);
    assert.equal(t.name, "native");
    assert.equal(t.Dealer, fake.Dealer);
    assert.equal(fake.context.blocky, false);
  });

  test("native in a build without the addon: a clear error, not a fallback", () => {
    assert.throws(
      () => selectTransport("native", () => { throw new Error("Cannot find module 'zeromq'"); }),
      /COCALC_JUPYTER_ZMQ=native, but the native zeromq transport isn't available in this build: Error: Cannot find module 'zeromq'/,
    );
  });

  test("any other value: an error naming the allowed values", () => {
    assert.throws(() => selectTransport("zmq"), /COCALC_JUPYTER_ZMQ="zmq" isn't a Jupyter transport: use "js" \(the default\) or "native"/);
  });
});
