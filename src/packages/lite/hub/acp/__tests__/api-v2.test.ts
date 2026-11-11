import { isApiV2Enabled, isMissingHttpApi, loadHttpApi } from "../../../api-v2";

describe("Lite API v2 mode", () => {
  it("is disabled for standalone Lite by default", () => {
    expect(isApiV2Enabled({})).toBe(false);
  });

  it("is enabled for the restricted Launchpad manifest", () => {
    expect(
      isApiV2Enabled({
        COCALC_LAUNCHPAD_API_V2_ROUTES: "1",
      }),
    ).toBe(true);
  });

  it("supports explicit standalone opt-in and opt-out", () => {
    expect(isApiV2Enabled({ COCALC_LITE_API_V2: "yes" })).toBe(true);
    expect(
      isApiV2Enabled({
        COCALC_LITE_API_V2: "off",
        COCALC_LAUNCHPAD_API_V2_ROUTES: "1",
      }),
    ).toBe(false);
  });

  it("keeps CoCalc Plus disabled", () => {
    expect(
      isApiV2Enabled({
        COCALC_PRODUCT: "plus",
        COCALC_LITE_API_V2: "1",
      }),
    ).toBe(false);
  });
});

describe("loading @cocalc/http-api", () => {
  const notFound = (code: string, message: string) =>
    Object.assign(new Error(message), { code });

  it("is undefined only when the package itself is missing", async () => {
    for (const err of [
      notFound(
        "MODULE_NOT_FOUND",
        "Cannot find module '@cocalc/http-api'\nRequire stack:\n- /x/lite/dist/http.js",
      ),
      notFound(
        "ERR_MODULE_NOT_FOUND",
        "Cannot find package '@cocalc/http-api' imported from /x/lite/http.js",
      ),
      notFound(
        "ERR_MODULE_NOT_FOUND",
        "Cannot find module '@cocalc/http-api' from '/x/bundle/index.js'",
      ),
    ]) {
      expect(isMissingHttpApi(err)).toBe(true);
      await expect(
        loadHttpApi(() => Promise.reject(err)),
      ).resolves.toBeUndefined();
    }
  });

  it("throws when a dependency of it, a part of it, or its initialization fails", async () => {
    for (const err of [
      // a missing transitive dependency names that module, not @cocalc/http-api
      notFound(
        "MODULE_NOT_FOUND",
        "Cannot find module 'next-rest-framework'\nRequire stack:\n- /x/http-api/dist/index.js",
      ),
      notFound(
        "MODULE_NOT_FOUND",
        "Cannot find module '@cocalc/http-api/dist/lib/router'",
      ),
      notFound(
        "MODULE_NOT_FOUND",
        "Cannot find module '@cocalc/http-api-extra'",
      ),
      new Error("invalid COCALC_API_V2_ROUTES_BUNDLE"),
    ]) {
      expect(isMissingHttpApi(err)).toBe(false);
      await expect(loadHttpApi(() => Promise.reject(err))).rejects.toBe(err);
    }
  });

  it("returns the module when it loads", async () => {
    const mod = { createApiV2Router: () => "router" } as any;
    await expect(loadHttpApi(async () => mod)).resolves.toBe(mod);
  });
});
