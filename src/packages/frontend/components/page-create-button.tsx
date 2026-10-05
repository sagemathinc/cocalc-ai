/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The "+ New …" action of a top-level page (Agents, Projects, Artifacts,
// People). Every page puts it last in its header row, after search, so
// creating something looks and sits the same everywhere.

import type { Ref } from "react";
import { Button } from "antd";
import { Icon } from "./icon";

export function PageCreateButton({
  label,
  onClick,
  disabled,
  title,
  buttonRef,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Button
      ref={buttonRef}
      type="primary"
      icon={<Icon name="plus" />}
      disabled={disabled}
      title={title}
      onClick={onClick}
      style={{ flex: "0 0 auto" }}
    >
      {label}
    </Button>
  );
}
