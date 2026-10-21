/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The board recovery child's entry point: the program the root launcher execs
as the recovery user, in the job's leaf, with only stdin, stdout and stderr,
an environment of PATH only, and the heap flag as a fixed argument. It takes
no arguments of its own and reads only the real /proc and cgroup paths.
*/

import { runChild } from "./recovery-child";

runChild({ input: process.stdin, output: process.stdout }).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err}`.slice(0, 4096) + "\n");
    process.exit(1);
  },
);
