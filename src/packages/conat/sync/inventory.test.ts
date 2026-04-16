import {
  DISABLE_INVENTORY_UPDATES_ENV,
  inventoryUpdatesDisabled,
} from "./inventory";

describe("inventoryUpdatesDisabled", () => {
  const originalEnv = process.env[DISABLE_INVENTORY_UPDATES_ENV];
  const originalGlobal = (globalThis as any)[DISABLE_INVENTORY_UPDATES_ENV];
  const originalLocalStorage = (globalThis as any).localStorage;

  afterEach(() => {
    if (originalEnv == null) {
      delete process.env[DISABLE_INVENTORY_UPDATES_ENV];
    } else {
      process.env[DISABLE_INVENTORY_UPDATES_ENV] = originalEnv;
    }
    if (originalGlobal === undefined) {
      delete (globalThis as any)[DISABLE_INVENTORY_UPDATES_ENV];
    } else {
      (globalThis as any)[DISABLE_INVENTORY_UPDATES_ENV] = originalGlobal;
    }
    if (originalLocalStorage === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });

  it("uses the Node env switch when present", () => {
    process.env[DISABLE_INVENTORY_UPDATES_ENV] = "1";
    expect(inventoryUpdatesDisabled()).toBe(true);
    process.env[DISABLE_INVENTORY_UPDATES_ENV] = "0";
    expect(inventoryUpdatesDisabled()).toBe(false);
  });

  it("uses a browser global override when env is absent", () => {
    delete process.env[DISABLE_INVENTORY_UPDATES_ENV];
    (globalThis as any)[DISABLE_INVENTORY_UPDATES_ENV] = "true";
    expect(inventoryUpdatesDisabled()).toBe(true);
    (globalThis as any)[DISABLE_INVENTORY_UPDATES_ENV] = "false";
    expect(inventoryUpdatesDisabled()).toBe(false);
  });

  it("uses localStorage when neither env nor global override is set", () => {
    delete process.env[DISABLE_INVENTORY_UPDATES_ENV];
    delete (globalThis as any)[DISABLE_INVENTORY_UPDATES_ENV];
    (globalThis as any).localStorage = {
      getItem: jest.fn().mockReturnValue("yes"),
    };
    expect(inventoryUpdatesDisabled()).toBe(true);
    (globalThis as any).localStorage = {
      getItem: jest.fn().mockReturnValue("off"),
    };
    expect(inventoryUpdatesDisabled()).toBe(false);
  });
});
