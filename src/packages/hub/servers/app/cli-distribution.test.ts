/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { execFileSync } from "node:child_process";
import { CLI_INSTALLER_URL } from "@cocalc/server/cli-setup/setup-script";
import initCliDistribution from "./cli-distribution";

// A router that records its GET handlers, and a response that records the
// reply.
function routes() {
  const handlers: Record<string, (req: any, res: any) => Promise<void>> = {};
  initCliDistribution(
    { get: (path: string, fn: any) => (handlers[path] = fn) } as any,
    { origin: async () => "https://example.test" },
  );
  return handlers;
}

function response() {
  const out: { status: number; body: string; type?: string } = {
    status: 200,
    body: "",
  };
  const res: any = {
    headersSent: false,
    set: () => res,
    status: (code: number) => ((out.status = code), res),
    type: (type: string) => ((out.type = type), res),
    send: (body: string) => ((out.body = body), res),
  };
  return { res, out };
}

describe("/cli/install.sh on a site that serves no CLI releases", () => {
  const saved = process.env.COCALC_CLI_RELEASE_SOURCE;
  beforeAll(() => {
    process.env.COCALC_CLI_RELEASE_SOURCE = "off";
  });
  afterAll(() => {
    if (saved == null) delete process.env.COCALC_CLI_RELEASE_SOURCE;
    else process.env.COCALC_CLI_RELEASE_SOURCE = saved;
  });

  it("hands over to the standalone installer instead of a 404", async () => {
    const { res, out } = response();
    await routes()["/cli/install.sh"]({}, res);
    expect(out.status).toBe(200);
    expect(out.body).toContain(`curl -fsSL '${CLI_INSTALLER_URL}' | bash`);
    execFileSync("sh", ["-n"], { input: out.body });
  });

  it("still answers 404 for the release files", async () => {
    const { res, out } = response();
    await routes()["/cli/site.json"]({}, res);
    expect(out.status).toBe(404);
  });
});
