import {
  accountAwareCodexDefault,
  discoverAccountCodexModels,
  preferredAvailableCodexModel,
} from "../codex-model-discovery";
import {
  readCachedCodexModelCatalog,
  writeCachedCodexModelCatalog,
  getLiveCodexUsageStatus,
} from "@cocalc/frontend/account/codex-usage";
import { fetchCodexPaymentSourceForSubmit } from "../use-codex-payment-source";

let account = "account-1";
let runtime = "runtime-1";
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => account, getIn: () => runtime }) },
}));
jest.mock("@cocalc/frontend/account/codex-usage", () => ({
  readCachedCodexModelCatalog: jest.fn(),
  writeCachedCodexModelCatalog: jest.fn(),
  getLiveCodexUsageStatus: jest.fn(),
}));
jest.mock("../use-codex-payment-source", () => ({
  fetchCodexPaymentSourceForSubmit: jest.fn(),
}));
const source = { source: "subscription", subscriptionRevision: "rev-1" } as any;
const models = [{ model: "terra", default: true }, { model: "luna" }] as any;

beforeEach(() => {
  jest.resetAllMocks();
  account = "account-1";
  runtime = "runtime-1";
  (fetchCodexPaymentSourceForSubmit as jest.Mock).mockResolvedValue(source);
});

it("selects advertised defaults but preserves supported preferences", () => {
  expect(preferredAvailableCodexModel(models, "sol")?.model).toBe("terra");
  expect(preferredAvailableCodexModel(models, "luna")?.model).toBe("luna");
  expect(preferredAvailableCodexModel(models, undefined, "terra")?.model).toBe(
    "luna",
  );
  expect(preferredAvailableCodexModel([])).toBeUndefined();
});

it("uses the credential/project/runtime cache without live discovery", async () => {
  (readCachedCodexModelCatalog as jest.Mock).mockReturnValue({ models });
  expect(await accountAwareCodexDefault("project", "sol")).toBe("terra");
  expect(readCachedCodexModelCatalog).toHaveBeenCalledWith({
    accountId: account,
    projectId: "project",
    runtimeVersion: runtime,
    subscriptionRevision: "rev-1",
  });
  expect(getLiveCodexUsageStatus).not.toHaveBeenCalled();
});

it("does not wait for slow discovery on a cold first send", async () => {
  let finish;
  (getLiveCodexUsageStatus as jest.Mock).mockReturnValue(
    new Promise((r) => {
      finish = r;
    }),
  );
  expect(await accountAwareCodexDefault("project", "sol")).toBe("sol");
  expect(getLiveCodexUsageStatus).toHaveBeenCalledTimes(1);
  finish({ paymentSource: source, models });
  await discoverAccountCodexModels("project", source);
});

it("coalesces discovery and ignores results after an account switch", async () => {
  let finish;
  (getLiveCodexUsageStatus as jest.Mock).mockReturnValue(
    new Promise((r) => {
      finish = r;
    }),
  );
  const a = discoverAccountCodexModels("project", source, true);
  const b = discoverAccountCodexModels("project", source, true);
  account = "account-2";
  finish({ paymentSource: source, models });
  expect(await a).toBeUndefined();
  expect(await b).toBeUndefined();
  expect(getLiveCodexUsageStatus).toHaveBeenCalledTimes(1);
  expect(writeCachedCodexModelCatalog).not.toHaveBeenCalled();
});

it.each(["account-api-key", "site-api-key", "none"])(
  "does not change %s model defaults",
  async (kind) => {
    (fetchCodexPaymentSourceForSubmit as jest.Mock).mockResolvedValue({
      source: kind,
    });
    expect(await accountAwareCodexDefault("project", "sol")).toBe("sol");
    expect(getLiveCodexUsageStatus).not.toHaveBeenCalled();
  },
);

it("ignores a credential revision mismatch from live discovery", async () => {
  (getLiveCodexUsageStatus as jest.Mock).mockResolvedValue({
    paymentSource: { ...source, subscriptionRevision: "rev-2" },
    models,
  });
  expect(
    await discoverAccountCodexModels("project", source, true),
  ).toBeUndefined();
  expect(writeCachedCodexModelCatalog).not.toHaveBeenCalled();
});

it("does not let an older probe overwrite a forced recovery refresh", async () => {
  let finishOld;
  (getLiveCodexUsageStatus as jest.Mock)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValueOnce({ paymentSource: source, models });
  const old = discoverAccountCodexModels("project", source);
  expect(await discoverAccountCodexModels("project", source, true)).toEqual(
    models,
  );
  finishOld({ paymentSource: source, models: [{ model: "sol" }] });
  expect(await old).toBeUndefined();
  expect(writeCachedCodexModelCatalog).toHaveBeenCalledTimes(1);
  expect(writeCachedCodexModelCatalog).toHaveBeenCalledWith(
    expect.objectContaining({ models }),
  );
});
