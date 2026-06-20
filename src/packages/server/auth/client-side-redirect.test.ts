/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import clientSideRedirect from "./client-side-redirect";

describe("clientSideRedirect", () => {
  it("escapes target in script and HTML contexts", async () => {
    const send = jest.fn();
    const type = jest.fn(() => ({ send }));

    await clientSideRedirect({
      res: { type } as any,
      target: `/" ; alert(1); // </script><img src=x onerror=alert(2)>`,
    });

    expect(type).toHaveBeenCalledWith("html");
    const html = send.mock.calls[0][0];
    expect(html).toContain(
      'window.location.href = "/\\" ; alert(1); // \\u003c/script>\\u003cimg src=x onerror=alert(2)>"',
    );
    expect(html).toContain(
      '<a href="/&quot; ; alert(1); // &lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;">',
    );
    expect(html).not.toContain("</script><img");
  });
});
