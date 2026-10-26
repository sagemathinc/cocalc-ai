import type { AddressInfo } from "node:net";
import express from "express";
import getAccount from "@cocalc/server/auth/get-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import {
  getPublicHomeExperimentReport,
  recordPublicHomeExperimentEvent,
} from "@cocalc/server/public-home-experiment";
import initPublicHomeExperiment from "./public-home-experiment";

jest.mock("@cocalc/server/public-home-experiment", () => ({
  getPublicHomeExperimentReport: jest.fn(),
  recordPublicHomeExperimentEvent: jest.fn(),
}));
jest.mock("@cocalc/server/auth/get-account", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: jest.fn(),
}));

describe("the public Home experiment endpoints", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let base: string;
  beforeEach(async () => {
    jest.mocked(recordPublicHomeExperimentEvent).mockReset();
    jest.mocked(recordPublicHomeExperimentEvent).mockResolvedValue(true);
    jest.mocked(getPublicHomeExperimentReport).mockReset();
    jest.mocked(getAccount).mockReset();
    jest.mocked(userIsInGroup).mockReset();
    const app = express();
    const router = express.Router();
    initPublicHomeExperiment(router);
    app.use("/base", router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  async function post(body: unknown) {
    return await fetch(`${base}/home-experiment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("counts an event and sets no cookie", async () => {
    const res = await post({ variant: "math", event: "view" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    await new Promise((r) => setTimeout(r, 20));
    expect(recordPublicHomeExperimentEvent).toHaveBeenCalledWith({
      variant: "math",
      event: "view",
    });
  });

  it("answers the same whether or not the event was counted", async () => {
    jest
      .mocked(recordPublicHomeExperimentEvent)
      .mockRejectedValue(Error("database down"));
    const res = await post({ variant: "nope", event: "x" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("drops events beyond the per-address limit", async () => {
    for (let i = 0; i < 70; i++) await post({ variant: "math", event: "view" });
    await new Promise((r) => setTimeout(r, 20));
    expect(
      jest.mocked(recordPublicHomeExperimentEvent).mock.calls.length,
    ).toBeLessThanOrEqual(60);
  });

  it("shows the report only to admins", async () => {
    jest.mocked(getAccount).mockResolvedValue(undefined as any);
    expect((await fetch(`${base}/home-experiment/report`)).status).toBe(404);
    jest.mocked(getAccount).mockResolvedValue("a" as any);
    jest.mocked(userIsInGroup).mockResolvedValue(false);
    expect((await fetch(`${base}/home-experiment/report`)).status).toBe(404);
    jest.mocked(userIsInGroup).mockResolvedValue(true);
    jest
      .mocked(getPublicHomeExperimentReport)
      .mockResolvedValue({ arms: [] } as any);
    const res = await fetch(`${base}/home-experiment/report?days=7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ arms: [] });
    expect(getPublicHomeExperimentReport).toHaveBeenCalledWith({ days: 7 });
  });
});
