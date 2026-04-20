/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ButtonProps } from "antd";
import { Button } from "antd";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useIntl } from "react-intl";

import {
  Icon,
  Tooltip,
  UncommittedChanges,
  VisibleMDLG,
} from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { COLORS } from "@cocalc/util/theme";

interface Props {
  has_unsaved_changes?: boolean;
  has_uncommitted_changes?: boolean;
  read_only?: boolean;
  is_connecting?: boolean;
  is_sync_error?: boolean;
  is_saving?: boolean;
  no_labels?: boolean;
  size?: ButtonProps["size"];
  onClick?: (e) => void;
  show_uncommitted_changes?: boolean;
  set_show_uncommitted_changes?: Function;
  style?: CSSProperties;
}

const CONNECTING_INDICATOR_DELAY_MS = 2000;
const READ_ONLY_INDICATOR_DELAY_MS = 2000;
const STATUS_UPDATE_DELAY_MS = 750;
const STATUS_CHIP_WIDTH = 94;
const STATUS_DOT_WIDTH = 18;

export type SaveStatus =
  | "read-only"
  | "sync-error"
  | "reconnecting"
  | "saving"
  | "syncing"
  | "not-on-disk"
  | "saved";

export type SaveStatusInput = {
  has_unsaved_changes?: boolean;
  has_uncommitted_changes?: boolean;
  read_only?: boolean;
  is_connecting?: boolean;
  is_sync_error?: boolean;
  is_saving?: boolean;
};

type SaveStatusInfo = {
  label: string;
  title: string;
  background: string;
  border: string;
  color: string;
};

export function saveStatus({
  has_unsaved_changes,
  has_uncommitted_changes,
  read_only,
  is_connecting,
  is_sync_error,
  is_saving,
}: SaveStatusInput): SaveStatus {
  if (read_only) return "read-only";
  if (is_sync_error) return "sync-error";
  if (is_connecting) return "reconnecting";
  if (is_saving) return "saving";
  if (has_uncommitted_changes) return "syncing";
  if (has_unsaved_changes) return "not-on-disk";
  return "saved";
}

function useDebouncedStatus(status: SaveStatus): SaveStatus {
  const [debounced, setDebounced] = useState<SaveStatus>(status);

  useEffect(() => {
    if (status === debounced) return;
    const timer = globalThis.setTimeout(() => {
      setDebounced(status);
    }, STATUS_UPDATE_DELAY_MS);
    return () => globalThis.clearTimeout(timer);
  }, [status, debounced]);

  return debounced;
}

function statusInfo(status: SaveStatus): SaveStatusInfo {
  switch (status) {
    case "read-only":
      return {
        label: "Read-only",
        title: "This file is read-only.",
        background: COLORS.GRAY_LL,
        border: COLORS.GRAY_L0,
        color: COLORS.GRAY_D,
      };
    case "sync-error":
      return {
        label: "Sync error",
        title:
          "This file has a sync error. Changes may not be confirmed by CoCalc.",
        background: COLORS.ANTD_BG_RED_L,
        border: COLORS.ANTD_BG_RED_M,
        color: COLORS.FG_RED,
      };
    case "reconnecting":
      return {
        label: "Reconnecting",
        title:
          "This file is reconnecting. Recent changes may not be confirmed by CoCalc yet.",
        background: COLORS.YELL_LLL,
        border: COLORS.YELL_LL,
        color: COLORS.BRWN,
      };
    case "saving":
      return {
        label: "Saving",
        title: "Saving this file to disk.",
        background: COLORS.ANTD_BG_BLUE_L,
        border: COLORS.BLUE_LLL,
        color: COLORS.BLUE_DD,
      };
    case "syncing":
      return {
        label: "Syncing",
        title:
          "Changes are waiting for CoCalc confirmation. Another browser may not see them yet, and they may be lost if you close this browser tab.",
        background: COLORS.ANTD_BG_BLUE_L,
        border: COLORS.BLUE_LLL,
        color: COLORS.BLUE_DD,
      };
    case "not-on-disk":
      return {
        label: "Not on disk",
        title:
          "Changes are confirmed by CoCalc but have not been saved to the project file on disk.",
        background: COLORS.GRAY_LLL,
        border: COLORS.GRAY_L0,
        color: COLORS.GRAY_D,
      };
    case "saved":
    default:
      return {
        label: "Saved",
        title:
          "No pending changes. This file is confirmed by CoCalc and saved to disk.",
        background: COLORS.BS_GREEN_LL,
        border: COLORS.ANTD_GREEN,
        color: COLORS.ANTD_GREEN_D,
      };
  }
}

export function SaveButton({
  has_unsaved_changes,
  has_uncommitted_changes,
  read_only,
  is_connecting,
  is_sync_error,
  is_saving,
  no_labels,
  size,
  onClick,
  show_uncommitted_changes,
  set_show_uncommitted_changes,
  style,
}: Props) {
  const intl = useIntl();
  const [showConnecting, setShowConnecting] = useState(false);
  const [showReadOnly, setShowReadOnly] = useState(false);
  const rawStatus = saveStatus({
    has_unsaved_changes,
    has_uncommitted_changes,
    read_only,
    is_connecting,
    is_sync_error,
    is_saving,
  });
  const debouncedStatus = useDebouncedStatus(rawStatus);
  const status = useMemo(
    () => statusInfo(rawStatus === "sync-error" ? rawStatus : debouncedStatus),
    [rawStatus, debouncedStatus],
  );

  useEffect(() => {
    if (!is_connecting) {
      setShowConnecting(false);
      return;
    }
    const timer = globalThis.setTimeout(() => {
      setShowConnecting(true);
    }, CONNECTING_INDICATOR_DELAY_MS);
    return () => globalThis.clearTimeout(timer);
  }, [is_connecting]);

  useEffect(() => {
    if (!read_only) {
      setShowReadOnly(false);
      return;
    }
    const timer = globalThis.setTimeout(() => {
      setShowReadOnly(true);
    }, READ_ONLY_INDICATOR_DELAY_MS);
    return () => globalThis.clearTimeout(timer);
  }, [read_only]);

  const label = useMemo(() => {
    if (showReadOnly) {
      return intl.formatMessage(labels.frame_editors_title_bar_save_label, {
        type: "read_only",
      });
    } else {
      return null;
    }
  }, [intl, no_labels, showReadOnly]);

  const icon = useMemo(
    () =>
      showConnecting ? "spinner" : is_saving ? "arrow-circle-o-left" : "save",
    [showConnecting, is_saving],
  );

  function renderLabel() {
    if (label) {
      return <VisibleMDLG>{` ${label}`}</VisibleMDLG>;
    }
  }

  function renderStatus() {
    const width = no_labels ? STATUS_DOT_WIDTH : STATUS_CHIP_WIDTH;
    return (
      <Tooltip title={status.title}>
        <span
          aria-label={status.title}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width,
            minWidth: width,
            maxWidth: width,
            height: no_labels ? 12 : 18,
            marginLeft: no_labels ? 4 : 8,
            borderRadius: 9,
            border: `1px solid ${status.border}`,
            background: status.background,
            color: status.color,
            fontSize: 11,
            fontWeight: 500,
            lineHeight: "16px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            verticalAlign: "middle",
          }}
        >
          {no_labels ? "" : status.label}
        </span>
      </Tooltip>
    );
  }

  // The funny style in the icon below is because the width changes
  // slightly depending on which icon we are showing.
  // whiteSpace:"nowrap" due to https://github.com/sagemathinc/cocalc/issues/4434
  return (
    <Button
      size={size}
      disabled={read_only}
      onClick={onClick}
      style={{
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <Icon
        name={icon}
        spin={!!showConnecting || !!is_saving}
        style={{ display: "inline-block" }}
      />
      {renderLabel()}
      {renderStatus()}
      <UncommittedChanges
        has_uncommitted_changes={has_uncommitted_changes}
        show_uncommitted_changes={show_uncommitted_changes}
        set_show_uncommitted_changes={set_show_uncommitted_changes}
        show_visual={false}
      />
    </Button>
  );
}
