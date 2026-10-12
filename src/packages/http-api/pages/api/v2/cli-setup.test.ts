/** @jest-environment node */

const mockSiteURL = jest.fn(async () => "https://cocalc.example.com");
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: () => mockSiteURL(),
}));

jest.mock("@cocalc/server/computers/routing", () => ({
  pairingUrl: async (id: string) => `https://bay-2.example.com/c/${id}`,
}));

let mockLaunchpad = false;
jest.mock("@cocalc/server/launchpad/mode", () => ({
  isLaunchpadProduct: () => mockLaunchpad,
}));

import handle from "./cli/setup";

function call(method: string, query: Record<string, unknown>) {
  let body = "";
  let status = 200;
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
    status: (s: number) => ((status = s), res),
    send: (b: string) => ((body = b), res),
  };
  return handle({ method, query } as any, res).then(() => ({
    body,
    status,
    headers,
  }));
}

const PROJECT = "11111111-2222-4333-8444-555555555555";

test("serves the SSH setup script for a project, as plain text, with this site's URL", async () => {
  const r = await call("GET", { action: "ssh", project: PROJECT });
  expect(r.status).toBe(200);
  expect(r.headers["content-type"]).toMatch(/^text\/plain/);
  expect(r.headers["cache-control"]).toBe("no-store");
  expect(r.body.startsWith("#!/bin/sh")).toBe(true);
  expect(r.body).toContain(
    `'--api' 'https://cocalc.example.com' 'project' 'ssh-config' 'add' '-w' '${PROJECT}'`,
  );
});

test("anything else gets a script that only prints why and fails", async () => {
  for (const query of [
    { action: "ssh", project: "x'; rm -rf ~; '" },
    { action: "anything" },
    { action: "ssh", project: ["a", "b"] },
  ]) {
    const r = await call("GET", query);
    expect(r.body).toMatch(/^#!\/bin\/sh\nprintf '%s\\n' 'CoCalc: /);
    expect(r.body).toContain("exit 1");
    expect(r.body).not.toContain("rm -rf");
    expect(r.body).not.toContain('cocalc"');
  }
  expect((await call("POST", {})).status).toBe(405);
});

test("serves the computer connect script with the home bay's pairing line", async () => {
  const r = await call("GET", { action: "computer", request: "R-396W8E8XD1" });
  expect(r.body).toContain(
    `"$cocalc" 'computer' 'connect' 'https://bay-2.example.com/c/R-396W8E8XD1' <"$tty"`,
  );
  const bad = await call("GET", { action: "computer", request: "R-x; id" });
  expect(bad.body).toContain("t a pairing request");
  expect(bad.body).not.toContain("; id");
});

test("Launchpad doesn't offer computers: the computer action only says so", async () => {
  mockLaunchpad = true;
  try {
    const r = await call("GET", {
      action: "computer",
      request: "R-396W8E8XD1",
    });
    expect(r.body).toContain("computers aren");
    expect(r.body).not.toContain("connect");
    // SSH setup is still served there.
    const ssh = await call("GET", {
      action: "ssh",
      project: "11111111-2222-4333-8444-555555555555",
    });
    expect(ssh.body).toContain("'ssh-config' 'add'");
  } finally {
    mockLaunchpad = false;
  }
});
