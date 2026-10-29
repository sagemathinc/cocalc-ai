/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Badge } from "antd";
import { useRef } from "react";
import type { CSSProperties } from "react";
import { useUnreadConversations } from "./use-conversations";

// Read by screen readers, not shown.
const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// How many conversations for you have something you haven't read, next to
// People in the navigation. No badge when there are none.
//
// The count changes in the background (polling, notifications), so screen
// readers hear it through a polite live region that stays mounted: it says
// the new count, and "No unread conversations" once they have all been read.
// It is empty until something was unread for this account, and while a
// list is loading (after signing in as someone else, the count is 0 only
// because nothing has arrived yet), so nothing false is announced.
export function PeopleUnreadBadge() {
  const { count, loaded, account_id } = useUnreadConversations();
  // The account that had something unread, if it is still this one.
  const hadUnreadFor = useRef<string | undefined>(undefined);
  if (hadUnreadFor.current !== account_id) hadUnreadFor.current = undefined;
  if (loaded && count > 0) hadUnreadFor.current = account_id;
  const label = !loaded
    ? ""
    : count > 0
      ? `${count} unread conversation${count === 1 ? "" : "s"}`
      : hadUnreadFor.current != null
        ? "No unread conversations"
        : "";
  return (
    <>
      {loaded && count > 0 && (
        <Badge
          count={count}
          overflowCount={99}
          size="small"
          title={label}
          aria-hidden
          style={{ marginLeft: 8 }}
        />
      )}
      <span role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {label}
      </span>
    </>
  );
}
