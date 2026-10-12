/** @jest-environment node */

// Launchpad serves only the API v2 routes listed in its manifest (it sets
// COCALC_LAUNCHPAD_API_V2_ROUTES=1, so the router skips file discovery).
// Routes Launchpad's own UI links to must be in it.

// An ESM-only dependency of an unrelated auth route; not needed here.
jest.mock("micro-key-producer/ssh.js", () => ({
  __esModule: true,
  default: {},
}));

import { getLaunchpadApiV2Routes } from "./launchpad-routes";
import cliSetup from "../pages/api/v2/cli/setup";

test("the one-line setup script is served on Launchpad", () => {
  const route = getLaunchpadApiV2Routes().find((r) => r.path === "/cli/setup");
  expect(route?.handler).toBe(cliSetup);
});

test("every manifest path is unique", () => {
  const paths = getLaunchpadApiV2Routes().map((r) => r.path);
  expect(new Set(paths).size).toBe(paths.length);
});
