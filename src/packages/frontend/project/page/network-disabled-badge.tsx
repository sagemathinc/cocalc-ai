/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popover, Typography } from "antd";
import { useEffect, useId, useRef, useState } from "react";

import { Icon } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { COLORS } from "@cocalc/util/theme";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Text } = Typography;

export function networkAccessDisabledFromRunQuota(runQuota: unknown): boolean {
  const value =
    (runQuota as any)?.get?.("network") ?? (runQuota as any)?.network;
  return value === false || value === 0;
}

export function NetworkDisabledBadge() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      title="No network access"
      content={
        <div
          aria-label="No network access details"
          id={dialogId}
          role="dialog"
          style={{ maxWidth: 320 }}
        >
          <Text>
            Free projects do not have network access.{" "}
            <a href={joinUrlPath(appBasePath, "settings", "membership")}>
              Upgrade your membership
            </a>
            .
          </Text>
        </div>
      }
    >
      <Button
        aria-label="Network unavailable"
        aria-controls={dialogId}
        aria-expanded={open}
        aria-haspopup="dialog"
        ref={buttonRef}
        size="small"
        type="text"
        style={{
          alignSelf: "center",
          color: COLORS.ANTD_RED_WARN,
          flex: "0 0 auto",
          height: 26,
          marginRight: 2,
          paddingInline: 6,
        }}
      >
        <Icon name="global" />{" "}
        <span style={{ textDecoration: "line-through" }}>Network</span>
      </Button>
    </Popover>
  );
}
