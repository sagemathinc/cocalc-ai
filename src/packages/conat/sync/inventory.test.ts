import {
  DISABLE_INVENTORY_UPDATES_ENV,
  inventory,
  inventoryDisabledReason,
  inventoryUpdatesDisabled,
} from "./inventory";

describe("inventoryUpdatesDisabled", () => {
  it("is hard disabled regardless of the legacy env switch", () => {
    process.env[DISABLE_INVENTORY_UPDATES_ENV] = "0";
    expect(inventoryUpdatesDisabled()).toBe(true);
    delete process.env[DISABLE_INVENTORY_UPDATES_ENV];
    expect(inventoryUpdatesDisabled()).toBe(true);
  });

  it("rejects inventory creation even with an explicit client", async () => {
    await expect(
      inventory({ project_id: "p", client: { id: "c" } as any }),
    ).rejects.toThrow(inventoryDisabledReason());
  });
});
