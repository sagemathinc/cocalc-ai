/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Badge } from "antd";
import { CSSProperties, useRef } from "react";
import { useUnreadConversationCount } from "./use-conversations";

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
// Before anything was ever unread it is empty, so nothing is announced.
export function PeopleUnreadBadge() {
  const count = useUnreadConversationCount();
  const hadUnread = useRef(false);
  if (count > 0) hadUnread.current = true;
  const label =
    count > 0
      ? `${count} unread conversation${count === 1 ? "" : "s"}`
      : hadUnread.current
        ? "No unread conversations"
        : "";
  return (
    <>
      {count > 0 && (
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
