/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  rewriteGroup,
  rewritePasswd,
  rewriteShadow,
} from "./runtime-bootstrap";

const runtime = {
  user: "user",
  uid: 2001,
  gid: 2001,
  home: "/home/user",
  shell: "/bin/bash",
};

describe("runtime bootstrap rewrite helpers", () => {
  it("appends a canonical runtime user without disturbing unrelated uid 1000 users", () => {
    const current = [
      "root:x:0:0:root:/root:/bin/bash",
      "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
      "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
      "",
    ].join("\n");
    expect(rewritePasswd(current, runtime)).toBe(
      [
        "root:x:0:0:root:/root:/bin/bash",
        "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
        "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
        "user:x:2001:2001:CoCalc User:/home/user:/bin/bash",
        "",
      ].join("\n"),
    );
  });

  it("appends a canonical runtime group without disturbing unrelated gid 1000 groups", () => {
    const current = ["root:x:0:", "ubuntu:x:1000:", "daemon:x:1:", ""].join(
      "\n",
    );
    expect(rewriteGroup(current, runtime)).toBe(
      ["root:x:0:", "ubuntu:x:1000:", "daemon:x:1:", "user:x:2001:", ""].join(
        "\n",
      ),
    );
  });

  it("ensures the runtime user has a valid shadow entry", () => {
    const current = [
      "root:*:19993:0:99999:7:::",
      "ubuntu:!:19993:0:99999:7:::",
      "",
    ].join("\n");
    expect(rewriteShadow(current, runtime)).toContain("user:$6$cocalcruntime$");
  });
});
