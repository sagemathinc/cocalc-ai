/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Badge } from "antd";
import { useUnreadConversationCount } from "./use-conversations";

// How many conversations for you have something you haven't read, next to
// People in the navigation. Nothing when there are none.
export function PeopleUnreadBadge() {
  const count = useUnreadConversationCount();
  if (count === 0) return null;
  const label = `${count} unread conversation${count === 1 ? "" : "s"}`;
  return (
    <Badge
      count={count}
      overflowCount={99}
      size="small"
      title={label}
      aria-label={label}
      style={{ marginLeft: 8 }}
    />
  );
}
