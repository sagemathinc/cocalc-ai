/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Tag } from "antd";
import type React from "react";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import type { PublicDirectorySharePathIndicators } from "@cocalc/util/public-directory-share-labels";
import { COLORS } from "@cocalc/util/theme";

function shareLabel(path: string, slug: string): string {
  return `${path === "." ? "Project files" : path} (${slug})`;
}

export function PublicDirectoryShareIndicator({
  indicators,
  compact = false,
}: {
  indicators?: PublicDirectorySharePathIndicators;
  compact?: boolean;
}): React.JSX.Element | null {
  if (indicators == null) return null;
  const directCount = indicators.direct.length;
  const descendantCount = indicators.descendants.length;
  if (directCount === 0 && descendantCount === 0) return null;

  const direct = directCount > 0;
  const shares = direct ? indicators.direct : indicators.descendants;
  const label = direct
    ? directCount === 1
      ? "Published"
      : `${directCount} shares`
    : descendantCount === 1
      ? "Contains published"
      : `${descendantCount} published`;
  const title = (
    <div>
      <div style={{ fontWeight: 600 }}>
        {direct
          ? "This path is published."
          : "This folder contains published paths."}
      </div>
      {shares.slice(0, 5).map((share) => (
        <div key={share.id}>{shareLabel(share.path, share.slug)}</div>
      ))}
      {shares.length > 5 && <div>and {shares.length - 5} more</div>}
    </div>
  );

  return (
    <Tooltip title={title}>
      <Tag
        style={{
          marginLeft: compact ? 4 : 8,
          marginRight: 0,
          flex: "0 0 auto",
          color: direct ? COLORS.ANTD_LINK_BLUE : COLORS.GRAY_D,
          borderColor: direct ? COLORS.ANTD_LINK_BLUE : COLORS.GRAY_M,
          background: COLORS.GRAY_LLL,
          cursor: "default",
        }}
      >
        <Icon name="link" style={{ marginRight: compact ? 0 : 4 }} />
        {!compact && label}
      </Tag>
    </Tooltip>
  );
}
