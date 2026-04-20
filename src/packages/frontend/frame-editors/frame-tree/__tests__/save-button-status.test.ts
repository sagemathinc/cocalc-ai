/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { saveStatus } from "../save-button";

describe("saveStatus", () => {
  it("prioritizes file connection and backend confirmation before disk state", () => {
    expect(saveStatus({ read_only: true })).toBe("read-only");
    expect(saveStatus({ is_sync_error: true })).toBe("sync-error");
    expect(saveStatus({ is_connecting: true })).toBe("reconnecting");
    expect(saveStatus({ is_saving: true })).toBe("saving");
    expect(saveStatus({ has_uncommitted_changes: true })).toBe("syncing");
    expect(saveStatus({ has_unsaved_changes: true })).toBe("not-on-disk");
    expect(saveStatus({})).toBe("saved");
  });

  it("shows reconnecting instead of disk dirty while the file sync is not live", () => {
    expect(
      saveStatus({
        is_connecting: true,
        has_uncommitted_changes: true,
        has_unsaved_changes: true,
      }),
    ).toBe("reconnecting");
  });
});
