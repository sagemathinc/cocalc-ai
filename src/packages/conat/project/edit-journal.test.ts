/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  editJournalAvailable,
  editJournalSubject,
  parseEditJournalSubject,
  saveTextJournal,
} from "./edit-journal";

const account_id = "00000000-0000-4000-8000-000000000001";
const project_id = "11111111-1111-4111-8111-111111111111";

describe("project edit journal client", () => {
  it("round trips its authenticated service subject", () => {
    const subject = editJournalSubject({ account_id, project_id });
    expect(subject).toBe(
      `services.account-${account_id}._.${project_id}._.edit-journal`,
    );
    expect(parseEditJournalSubject(subject)).toEqual({
      account_id,
      project_id,
    });
  });

  it("rejects malformed subjects", () => {
    expect(() => parseEditJournalSubject("services.account-nope")).toThrow(
      "invalid edit journal subject",
    );
  });

  it("calls the account-scoped project-host service", async () => {
    const request = jest.fn(async () => ({
      data: {
        committed: true,
        contents: "next",
        sha256: "abc",
      },
    }));
    await saveTextJournal({
      client: { request } as any,
      account_id,
      project_id,
      request: {
        path: "/home/user/a.ts",
        base_sha256: "base",
        journal_id: "journal",
        sequence: 1,
        patch: [],
      },
    });
    expect(request).toHaveBeenCalledWith(
      `services.account-${account_id}._.${project_id}._.edit-journal`,
      ["saveText", [expect.objectContaining({ sequence: 1 })]],
      expect.objectContaining({ waitForInterest: true }),
    );
  });

  it("caches project-host service availability per client", async () => {
    const interest = jest.fn(async () => false);
    const client = { interest } as any;
    await expect(
      editJournalAvailable({ client, account_id, project_id }),
    ).resolves.toBe(false);
    await expect(
      editJournalAvailable({ client, account_id, project_id }),
    ).resolves.toBe(false);
    expect(interest).toHaveBeenCalledTimes(1);
  });
});
