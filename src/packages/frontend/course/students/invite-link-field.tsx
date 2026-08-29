/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Button, Input, Space } from "antd";
import { useId } from "react";

import { Icon } from "@cocalc/frontend/components";

interface Props {
  onCopy: () => void;
  value: string;
}

export function CourseInviteLinkField({ onCopy, value }: Props) {
  const inputId = useId();
  return (
    <div style={{ width: "100%" }}>
      <label htmlFor={inputId} style={{ display: "block", fontWeight: 600 }}>
        Invite link
      </label>
      <Space.Compact style={{ display: "flex", width: "100%" }}>
        <Input
          aria-label="Invite link"
          id={inputId}
          onFocus={(event) => event.target.select()}
          readOnly
          style={{ minWidth: 0 }}
          value={value}
        />
        <Button aria-label="Copy invite link" onClick={onCopy}>
          <Icon name="copy" /> Copy
        </Button>
      </Space.Compact>
    </div>
  );
}
