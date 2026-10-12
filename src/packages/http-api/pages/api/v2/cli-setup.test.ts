/** @jest-environment node */

const mockSiteURL = jest.fn(async () => "https://cocalc.example.com");
jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: () => mockSiteURL(),
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
