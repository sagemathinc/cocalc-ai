import type { AddressInfo } from "node:net";
import express from "express";
import getAccount from "@cocalc/server/auth/get-account";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import {
  getPublicHomeExperimentReport,
  recordPublicHomeExperimentEvent,
} from "@cocalc/server/public-home-experiment";
import initPublicHomeExperiment, { PER_WINDOW } from "./public-home-experiment";

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

  it("answers 204 only after the event is stored, and sets no cookie", async () => {
    let stored = false;
    jest
      .mocked(recordPublicHomeExperimentEvent)
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        stored = true;
        return true;
      });
    const res = await post({ variant: "math", event: "view" });
    expect(stored).toBe(true);
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(recordPublicHomeExperimentEvent).toHaveBeenCalledWith({
      variant: "math",
      event: "view",
    });
  });

  it("answers an unknown or inactive version like a counted one", async () => {
    jest.mocked(recordPublicHomeExperimentEvent).mockResolvedValue(false);
    const res = await post({ variant: "nope", event: "x" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers with an error when the write fails", async () => {
    jest
      .mocked(recordPublicHomeExperimentEvent)
      .mockRejectedValue(Error("database down"));
    const res = await post({ variant: "math", event: "view" });
    expect(res.status).toBe(503);
  });

  it("counts a busy shared address, and answers 429 only past the flood ceiling", async () => {
    // Hundreds of visitors behind one school or office NAT address.
    const busy = await Promise.all(
      Array.from({ length: 300 }, () =>
        post({ variant: "math", event: "view" }),
      ),
    );
    expect(busy.every((res) => res.status === 204)).toBe(true);
    for (let i = 300; i < PER_WINDOW; i += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, PER_WINDOW - i) }, () =>
          post({ variant: "math", event: "view" }),
        ),
      );
    }
    const calls = jest.mocked(recordPublicHomeExperimentEvent).mock.calls
      .length;
    expect(calls).toBe(PER_WINDOW);
    const over = await post({ variant: "math", event: "view" });
    expect(over.status).toBe(429);
    expect(jest.mocked(recordPublicHomeExperimentEvent).mock.calls.length).toBe(
      PER_WINDOW,
    );
  });

  it("refuses the report on a multi-bay site with the reason", async () => {
    jest.mocked(getAccount).mockResolvedValue("a" as any);
    jest.mocked(userIsInGroup).mockResolvedValue(true);
    jest
      .mocked(getPublicHomeExperimentReport)
      .mockRejectedValue(
        Error(
          "the Home experiment report covers single-bay sites only; summing counts across bays is not implemented yet",
        ),
      );
    const res = await fetch(`${base}/home-experiment/report`);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/single-bay/);
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
