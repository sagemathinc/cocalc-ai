/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mentionEmailSubject, mentionPathLabel } from "./notify";

describe("mention notification email copy", () => {
  it("puts the mention event first in the subject", () => {
    expect(
      mentionEmailSubject({
        sourceName: "Ada Lovelace",
        projectTitle: "Release Planning",
        path: "notes/launch/notebook.ipynb",
      }),
    ).toBe("Ada Lovelace mentioned you in notebook.ipynb (Release Planning)");
  });

  it("uses the filename instead of the full path in subjects", () => {
    expect(mentionPathLabel("home/user/deep/path/project-chat.md")).toBe(
      "project-chat.md",
    );
  });

  it("bounds long subjects for inbox display", () => {
    const subject = mentionEmailSubject({
      sourceName: "A very long account name that should not take over inboxes",
      projectTitle:
        "A very long project title that should still leave room for the file name",
      path: "home/user/research/a-very-long-file-name-with-important-context.ipynb",
    });

    expect(subject.length).toBeLessThanOrEqual(120);
    expect(subject).toContain("mentioned you in");
  });
});
