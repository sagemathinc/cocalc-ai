/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  resolveTimeTravelGitBrowserCommitHash,
  TIME_TRAVEL_GIT_REVIEW_SUBMISSION_HELP,
} from "./git-browser";

describe("time-travel git browser helpers", () => {
  const gitCommit = (version: number | string | undefined) =>
    version == null ? undefined : { hash: `hash-${version}` };

  it("opens at HEAD when the time-travel source is not git", () => {
    expect(
      resolveTimeTravelGitBrowserCommitHash({
        gitMode: false,
        changesMode: false,
        version: 123,
        gitCommit,
      }),
    ).toBe("HEAD");
  });

  it("opens at the selected git revision in single-version mode", () => {
    expect(
      resolveTimeTravelGitBrowserCommitHash({
        gitMode: true,
        changesMode: false,
        version: 123,
        gitCommit,
      }),
    ).toBe("hash-123");
  });

  it("opens at the newer edge of a selected git compare range", () => {
    expect(
      resolveTimeTravelGitBrowserCommitHash({
        gitMode: true,
        changesMode: true,
        version0: 100,
        version1: 200,
        gitCommit,
      }),
    ).toBe("hash-200");
  });

  it("falls back to HEAD when the selected git revision cannot be resolved", () => {
    expect(
      resolveTimeTravelGitBrowserCommitHash({
        gitMode: true,
        changesMode: false,
        version: 123,
        gitCommit: () => undefined,
      }),
    ).toBe("HEAD");
  });

  it("provides a user-facing explanation for disabled review submission", () => {
    expect(TIME_TRAVEL_GIT_REVIEW_SUBMISSION_HELP).toContain("AI chat");
  });
});
