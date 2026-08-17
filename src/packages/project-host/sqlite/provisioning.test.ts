import { closeDatabase } from "@cocalc/lite/hub/sqlite/database";
import {
  listUnreportedProvisioning,
  markProjectProvisionedReported,
  setProjectProvisioned,
} from "./provisioning";

describe("project provisioning reports", () => {
  const previousFilename = process.env.COCALC_LITE_SQLITE_FILENAME;
  const project_id = "225016f6-acf7-4e2a-b19f-6850bde0baef";

  beforeEach(() => {
    process.env.COCALC_LITE_SQLITE_FILENAME = ":memory:";
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    if (previousFilename == null) {
      delete process.env.COCALC_LITE_SQLITE_FILENAME;
    } else {
      process.env.COCALC_LITE_SQLITE_FILENAME = previousFilename;
    }
  });

  it("can force an unchanged acknowledged value to be reported again", () => {
    expect(setProjectProvisioned(project_id, true)).toBe(true);
    markProjectProvisionedReported(project_id);
    expect(setProjectProvisioned(project_id, true)).toBe(false);

    expect(setProjectProvisioned(project_id, true, { forceReport: true })).toBe(
      true,
    );
    expect(listUnreportedProvisioning()).toEqual([
      { project_id, provisioned: true },
    ]);
  });
});
