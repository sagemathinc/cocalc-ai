/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ComponentProps } from "react";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import { readableNotificationMarkdown } from "./markdown-preview";

export function NotificationMarkdown({
  value,
  style,
  ...props
}: ComponentProps<typeof StaticMarkdown>) {
  return (
    <div
      onClick={(event) => {
        // The link handles its own authorized navigation, not the parent row's.
        if (
          event.target instanceof Element &&
          event.target.closest("a,button,[role=button]")
        )
          event.stopPropagation();
      }}
    >
      <StaticMarkdown
        {...props}
        value={readableNotificationMarkdown(value)}
        style={{ ...style, overflowWrap: "anywhere" }}
      />
    </div>
  );
}
