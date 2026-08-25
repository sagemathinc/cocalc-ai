/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Icon } from "@cocalc/frontend/components";

interface ProjectActionsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

export const ProjectActionsTrigger = forwardRef<
  HTMLButtonElement,
  ProjectActionsTriggerProps
>(function ProjectActionsTrigger({ icon, style, ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label="Project actions"
      aria-haspopup="menu"
      style={{
        appearance: "none",
        background: "transparent",
        border: 0,
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        fontSize: "18px",
        lineHeight: "normal",
        padding: "4px 8px",
        ...style,
      }}
    >
      {icon ?? <Icon name="ellipsis-vertical" />}
    </button>
  );
});
