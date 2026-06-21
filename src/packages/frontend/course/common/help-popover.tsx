/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popover } from "antd";
import type { ReactNode } from "react";

import { Icon } from "@cocalc/frontend/components";

interface Props {
  content: ReactNode;
  title?: ReactNode;
}

export default function HelpPopover({ content, title }: Props) {
  return (
    <Popover
      content={<div style={{ maxWidth: 420 }}>{content}</div>}
      title={title}
      trigger="click"
    >
      <Button
        aria-label="Help"
        size="small"
        style={{ padding: "0 4px" }}
        type="text"
      >
        <Icon name="question-circle" />
      </Button>
    </Popover>
  );
}
