/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AccountFeedCollaboratorRow } from "@cocalc/conat/hub/api/account-feed";
import { collaboratorFeedEventsForAccount } from "./account-collaborator-index-projector";

function row(
  account_id: string,
  overrides: Partial<AccountFeedCollaboratorRow> = {},
): AccountFeedCollaboratorRow {
  return {
    account_id,
    display_name: null,
    first_name: "First",
    last_name: account_id,
    name: `First ${account_id}`,
    last_active: "2026-10-07T12:00:00.000Z",
    profile: null,
    common_project_count: 1,
    updated_at: "2026-10-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("collaboratorFeedEventsForAccount", () => {
  it("publishes nothing for rows whose content did not change", () => {
    const peers = Array.from({ length: 200 }, (_, i) => row(`peer-${i}`));
    const rewritten = peers.map((peer) => ({
      ...peer,
      updated_at: "2026-10-07T13:00:00.000Z",
    }));
    expect(
      collaboratorFeedEventsForAccount({
        account_id: "acct",
        previous_rows: peers,
        current_rows: rewritten,
        event_ts: 5,
      }),
    ).toEqual([]);
  });

  it("publishes only added, changed, and removed collaborators", () => {
    const events = collaboratorFeedEventsForAccount({
      account_id: "acct",
      previous_rows: [row("same"), row("count"), row("renamed"), row("gone")],
      current_rows: [
        row("same", { updated_at: "2026-10-07T13:00:00.000Z" }),
        row("count", { common_project_count: 2 }),
        row("renamed", { name: "New Name" }),
        row("new"),
      ],
      event_ts: "2026-10-07T12:00:07.000Z",
    });
    expect(events).toEqual([
      {
        type: "collaborator.remove",
        ts: Date.parse("2026-10-07T12:00:07.000Z"),
        account_id: "acct",
        collaborator_account_id: "gone",
        reason: "membership_removed",
      },
      expect.objectContaining({
        type: "collaborator.upsert",
        collaborator: expect.objectContaining({
          account_id: "count",
          common_project_count: 2,
        }),
      }),
      expect.objectContaining({
        type: "collaborator.upsert",
        collaborator: expect.objectContaining({
          account_id: "renamed",
          name: "New Name",
        }),
      }),
      expect.objectContaining({
        type: "collaborator.upsert",
        collaborator: expect.objectContaining({ account_id: "new" }),
      }),
    ]);
  });

  it("treats profile changes as content changes", () => {
    expect(
      collaboratorFeedEventsForAccount({
        account_id: "acct",
        previous_rows: [row("p", { profile: { color: "red" } })],
        current_rows: [row("p", { profile: { color: "blue" } })],
        event_ts: 1,
      }),
    ).toHaveLength(1);
  });
});
