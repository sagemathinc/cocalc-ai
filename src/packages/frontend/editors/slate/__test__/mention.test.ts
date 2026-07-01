/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ALL_PROJECT_COLLABORATORS_MENTION_ID } from "@cocalc/frontend/editors/markdown-input/mention-all";
import { createMentionStatic } from "../elements/mention";
import "../elements/mention/editable";
import { getSlateToMarkdown } from "../elements/register";

describe("slate mention elements", () => {
  it("renders the all-collaborators sentinel as @all", () => {
    expect(
      createMentionStatic(ALL_PROJECT_COLLABORATORS_MENTION_ID, "ignored"),
    ).toMatchObject({
      account_id: ALL_PROJECT_COLLABORATORS_MENTION_ID,
      name: "all",
      type: "mention",
    });
  });

  it("serializes the all-collaborators sentinel as @all", () => {
    const fromSlate = getSlateToMarkdown("mention");

    expect(
      fromSlate({
        node: {
          account_id: ALL_PROJECT_COLLABORATORS_MENTION_ID,
          name: ALL_PROJECT_COLLABORATORS_MENTION_ID,
          type: "mention",
        },
      } as any),
    ).toBe(
      `<span class="user-mention" account-id=${ALL_PROJECT_COLLABORATORS_MENTION_ID}>@all</span>`,
    );
  });
});
