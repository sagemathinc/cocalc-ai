/*
A real kernel whose libzmq speaks ZMTP 3.0 (libzmq 4.2 and older), on the
pure-JS transport.  Opt-in, since CI has no such kernel:
set COCALC_TEST_ZMTP30_KERNEL to its kernel name.  For example, IRkernel with
the ZeroMQ 4.2.2 that R's pbdZMQ bundles:

  mkdir -p /tmp/rlib-zmq422
  R -e 'install.packages("pbdZMQ", lib="/tmp/rlib-zmq422",
        configure.args="--enable-internal-zmq")'
  # a copy of the ir kernelspec, with "env": {"R_LIBS": "/tmp/rlib-zmq422"},
  # in ~/.local/share/jupyter/kernels/ir-zmq422/kernel.json
  COCALC_TEST_ZMTP30_KERNEL=ir-zmq422 pnpm test `pwd`/zmtp30-kernel.test.ts

Before the fix, the pure-JS SUB only subscribed with ZMTP 3.1's SUBSCRIBE
command, which such a peer ignores: the kernel published nothing, so it never
left "starting" and code never ran.
*/

import { kernel } from "../kernel";

const name = process.env.COCALC_TEST_ZMTP30_KERNEL;
const maybe = name ? test : test.skip;

maybe(
  `a kernel speaking ZMTP 3.0 (${name ?? "set COCALC_TEST_ZMTP30_KERNEL"}) runs code`,
  async () => {
    const k = kernel({ name: name!, path: `zmtp30-${Date.now()}.ipynb` });
    try {
      const outputs = await k.execute_code_now({ code: "1 + 41" });
      const results = outputs
        .map((mesg) => mesg.content?.data?.["text/plain"])
        .filter((x) => x != null);
      expect(results.join(" ")).toContain("42");
      expect(k.get_state()).toBe("running");
    } finally {
      k.close();
    }
  },
  60000,
);
