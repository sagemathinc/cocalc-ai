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
  UncommittedChanges,
  VisibleMDLG,
} from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";

interface Props {
  has_unsaved_changes?: boolean;
  has_uncommitted_changes?: boolean;
  read_only?: boolean;
  is_connecting?: boolean;
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

export function SaveButton({
  has_unsaved_changes,
  has_uncommitted_changes,
  read_only,
  is_connecting,
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
    if (!no_labels || showReadOnly || showConnecting) {
      if (showConnecting) {
        return intl.formatMessage(labels.frame_editors_title_bar_connecting);
      }
      return intl.formatMessage(labels.frame_editors_title_bar_save_label, {
        type: showReadOnly ? "read_only" : "save",
      });
    } else {
      return null;
    }
  }, [intl, no_labels, showConnecting, showReadOnly]);

  const disabled = useMemo(
    () => !has_unsaved_changes || !!read_only,
    [has_unsaved_changes, read_only],
  );

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

  // The funny style in the icon below is because the width changes
  // slightly depending on which icon we are showing.
  // whiteSpace:"nowrap" due to https://github.com/sagemathinc/cocalc/issues/4434
  return (
    <Button
      size={size}
      disabled={disabled}
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
      <UncommittedChanges
        has_uncommitted_changes={has_uncommitted_changes}
        show_uncommitted_changes={show_uncommitted_changes}
        set_show_uncommitted_changes={set_show_uncommitted_changes}
      />
    </Button>
  );
}
