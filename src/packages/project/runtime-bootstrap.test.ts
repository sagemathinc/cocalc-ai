/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { rewriteGroup, rewritePasswd } from "./runtime-bootstrap";

const runtime = {
  user: "user",
  uid: 1000,
  gid: 1000,
  home: "/home/user",
  shell: "/bin/bash",
};

describe("runtime bootstrap rewrite helpers", () => {
  it("replaces an existing uid 1000 passwd entry with canonical user", () => {
    const current = [
      "root:x:0:0:root:/root:/bin/bash",
      "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "",
    ].join("\n");
    expect(rewritePasswd(current, runtime)).toBe(
      [
        "root:x:0:0:root:/root:/bin/bash",
        "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
        "user:x:1000:1000:CoCalc User:/home/user:/bin/bash",
        "",
      ].join("\n"),
    );
  });

  it("replaces an existing gid 1000 group entry with canonical user group", () => {
    const current = ["root:x:0:", "ubuntu:x:1000:", "daemon:x:1:", ""].join(
      "\n",
    );
    expect(rewriteGroup(current, runtime)).toBe(
      ["root:x:0:", "daemon:x:1:", "user:x:1000:", ""].join("\n"),
    );
  });
});
