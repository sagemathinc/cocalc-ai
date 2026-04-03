import {
  createListingsApiClient,
  createListingsService,
  listingsClient,
} from "./listings";
import { createTimeService, timeClient } from "./time";
import {
  createBrowserClient,
  createBrowserService,
  createTerminalClient,
  createTerminalServer,
} from "./terminal";
import {
  createBrowserSessionClient,
  createBrowserSessionService,
} from "./browser-session";
import {
  client as fileServerClient,
  server as createFileServer,
} from "../files/file-server";
import { init as initLlmServer } from "../llm/server";

describe("service helper explicit client routing", () => {
  it("rejects listings helpers without an explicit client", async () => {
    expect(() => createListingsApiClient({ project_id: "p" } as any)).toThrow(
      "createListingsApiClient must provide an explicit Conat client",
    );
    await expect(
      createListingsService({ project_id: "p", impl: {} } as any),
    ).rejects.toThrow(
      "createListingsService must provide an explicit Conat client",
    );
    await expect(
      listingsClient({ project_id: "p", noCache: true } as any),
    ).rejects.toThrow(
      "createListingsApiClient must provide an explicit Conat client",
    );
  });

  it("rejects time helpers without an explicit client", async () => {
    expect(() => timeClient({} as any)).toThrow(
      "time service helper must provide an explicit Conat client",
    );
    await expect(createTimeService({} as any)).rejects.toThrow(
      "time service helper must provide an explicit Conat client",
    );
  });

  it("rejects terminal helpers without an explicit client", () => {
    expect(() =>
      createTerminalClient({ project_id: "p", termPath: "t" } as any),
    ).toThrow("terminal service helper must provide an explicit Conat client");
    expect(() =>
      createTerminalServer({
        project_id: "p",
        termPath: "t",
        impl: {},
      } as any),
    ).toThrow("terminal service helper must provide an explicit Conat client");
    expect(() =>
      createBrowserClient({ project_id: "p", termPath: "t" } as any),
    ).toThrow("terminal service helper must provide an explicit Conat client");
    expect(() =>
      createBrowserService({
        project_id: "p",
        termPath: "t",
        impl: {},
      } as any),
    ).toThrow("terminal service helper must provide an explicit Conat client");
  });

  it("rejects browser-session helpers without an explicit client", () => {
    expect(() =>
      createBrowserSessionClient({
        account_id: "a",
        browser_id: "b",
      } as any),
    ).toThrow(
      "browser-session service helper must provide an explicit Conat client",
    );
    expect(() =>
      createBrowserSessionService({
        account_id: "a",
        browser_id: "b",
        impl: {},
      } as any),
    ).toThrow(
      "browser-session service helper must provide an explicit Conat client",
    );
  });

  it("rejects shared server helpers without an explicit client", async () => {
    expect(() => fileServerClient({} as any)).toThrow(
      "file-server helper must provide an explicit Conat client",
    );
    await expect(createFileServer({} as any)).rejects.toThrow(
      "file-server helper must provide an explicit Conat client",
    );
    await expect(
      initLlmServer(async () => {}, undefined as any),
    ).rejects.toThrow("llm server init must provide an explicit Conat client");
  });
});
