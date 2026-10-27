/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Non-Python libzmq kernels on the selected Jupyter transport: kernel_info,
an execution with its result, and a display.  ZMTP_KERNELS names the
kernelspecs to try (comma-separated), for example "tslab,xpython"; unset, the
suite is skipped.  (tslab links libzmq through zeromq.js, xeus-python through
cppzmq: two stacks besides pyzmq.)

ZMTP_KERNELS=tslab,xpython pnpm test `pwd`/zmtp-kernels.test.ts
*/

import { kernel } from "../kernel";

const names = (process.env.ZMTP_KERNELS ?? "").split(",").filter(Boolean);
const CASES: Record<
  string,
  { code: string; result: string; display: string; shown: string }
> = {
  tslab: {
    code: "2 + 3",
    result: "5",
    display: 'import * as tslab from "tslab"; tslab.display.text("shown")',
    shown: "shown",
  },
  xpython: {
    code: "2 + 3",
    result: "5",
    display: "from IPython.display import display\ndisplay('shown')",
    shown: "shown",
  },
};

async function run(k, code: string) {
  const out: any[] = [];
  for await (const x of k.execute_code({ code }).iter()) out.push(x);
  return out;
}

describe("non-Python libzmq kernels", () => {
  if (!names.length) {
    it("skipped: ZMTP_KERNELS names no kernelspec", () => {});
  }
  for (const name of names) {
    const c = CASES[name];
    it(`${name}: kernel_info, a result and a display`, async () => {
      expect(c).toBeTruthy();
      const k = kernel({ name, path: `zmtp-${name}.ipynb` });
      try {
        await k.spawn();
        const info = await k.kernel_info();
        expect(info.protocol_version).toBeTruthy();
        console.log(
          `ZMTP kernel ${name}: ${info.implementation} ${info.implementation_version}, protocol ${info.protocol_version}`,
        );
        const r = await run(k, c.code);
        expect(JSON.stringify(r)).toContain(c.result);
        const d = await run(k, c.display);
        expect(JSON.stringify(d)).toContain(c.shown);
      } finally {
        k.close();
      }
    }, 120_000);
  }
});
