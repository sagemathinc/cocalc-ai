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

// What to say about unread conversations, or "" for nothing: the count, and
// "No unread conversations" once they have all been read. Nothing until
// something was unread for this account, and nothing while a list is loading
// (after signing in as someone else, the count is 0 only because nothing has
// arrived yet), so nothing false is said.
function useUnreadLabel(): { count: number; loaded: boolean; label: string } {
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
  return { count, loaded, label };
}

// The one place screen readers hear unread-count changes, which happen in
// the background (polling, notifications): a polite live region, mounted
// once for the whole app (app/page.tsx) and never hidden, whatever badges
// are shown or hidden (a collapsed sidebar, a closed menu, Lite).
export function PeopleUnreadAnnouncer() {
  const { label } = useUnreadLabel();
  return (
    <span role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
      {label}
    </span>
  );
}

// How many conversations for you have something you haven't read, next to
// People in the navigation (the sidebar, the menu). No badge when there are
// none. It announces nothing itself (PeopleUnreadAnnouncer does, once), but
// keeps the count in the item's accessible name.
export function PeopleUnreadBadge() {
  const { count, loaded, label } = useUnreadLabel();
  if (!loaded || count === 0) return null;
  return (
    <>
      <Badge
        count={count}
        overflowCount={99}
        size="small"
        title={label}
        aria-hidden
        style={{ marginLeft: 8 }}
      />
      <span style={VISUALLY_HIDDEN}>{` ${label}`}</span>
    </>
  );
}
