/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag } from "antd";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";

// The "Upgrade" pill shown to free members. With `interactive` it is a real
// button that opens membership settings.
export function UpgradePill({
  interactive = false,
}: {
  interactive?: boolean;
}) {
  const tag = (
    <Tag color="blue" style={{ marginInlineEnd: 0 }}>
      Upgrade
    </Tag>
  );
  if (!interactive) return tag;
  return (
    <button
      type="button"
      aria-label="Upgrade membership"
      onClick={() => openAccountSettings({ page: "membership" })}
      style={{
        background: "none",
        border: 0,
        cursor: "pointer",
        font: "inherit",
        padding: 0,
      }}
    >
      {tag}
    </button>
  );
}
