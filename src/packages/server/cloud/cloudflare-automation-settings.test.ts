jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  decryptSettingValue: async (_name: string, value: string) => ({ value }),
}));

import {
  getServerSettings,
  resetServerSettingsCache,
} from "@cocalc/database/settings/server-settings";
import { EXTRAS } from "@cocalc/util/db-schema/site-settings-extras";

const mockQuery = jest.fn();
const values = {
  cloudflare_automation_token_id: "automation-id",
  cloudflare_zone_id: "a".repeat(32),
  cloudflare_zone_name: "example.com",
};

beforeEach(() => resetServerSettingsCache());

test("server settings retain durable token and zone metadata for audit/rotation", async () => {
  mockQuery.mockResolvedValue({
    rows: Object.entries(values).map(([name, value]) => ({
      name,
      value: ` ${value} `,
    })),
  });
  expect(await getServerSettings()).toMatchObject(values);
  for (const key of Object.keys(values)) {
    expect(EXTRAS[key].password).not.toBe(true);
    expect(EXTRAS[key].hidden).toBe(true);
  }
});

test("unconfigured automation metadata defaults to empty strings", async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  const settings = await getServerSettings();
  for (const key of Object.keys(values)) expect(settings[key]).toBe("");
});
