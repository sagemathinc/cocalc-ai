/*
Code for testing for memory leaks.  As of this commit, nothing tested for here
leaks memory in my dev setup.

USAGE:

Run with an account_id from your dev server and pass the expose-gc flag so the
gc command is defined:


ACCOUNT_ID="6aae57c6-08f1-4bb5-848b-3ceb53e61ede" DEBUG=cocalc:* DEBUG_CONSOLE=yes node  --expose-gc

Then do this

   a = require('@cocalc/database/conat/leak-search')
   await a.testQueryOnly(50)
*/

import { db } from "@cocalc/database";
import { delay } from "awaiting";
import { callback2 } from "@cocalc/util/async-utils";

let pre: any = { heapUsed: 0 };
async function before() {
  gc?.();
  await delay(500);
  gc?.();
  pre = process.memoryUsage();
}

async function after() {
  gc?.();
  await delay(500);
  gc?.();
  const post = process.memoryUsage();
  const leak = (post.heapUsed - pre.heapUsed) / 10 ** 6;
  console.log("leaked", leak, "MB");
  return leak;
}

export async function testChangefeed(_n) {
  throw Error(
    "legacy PostgreSQL user_query changefeeds were removed; use an explicit Conat or Lite changefeed path for leak tests",
  );
}

// query only does NOT leak
export async function testQueryOnly(n) {
  await before();
  for (let i = 0; i < n; i++) {
    const d = db();
    await callback2(d.user_query, {
      query: {
        projects: [
          { project_id: null, title: null, state: null, status: null },
        ],
      },
      account_id: "6aae57c6-08f1-4bb5-848b-3ceb53e61ede",
    });
  }
  return await after();
}
