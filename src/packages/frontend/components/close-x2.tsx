/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { CSS } from "@cocalc/frontend/app-framework";
import { Icon } from "./icon";

interface Props {
  style?: React.CSSProperties;
  close?: () => void;
}

const DEFAULT_STYLE: CSS = {
  display: "inline-flex",
  alignItems: "center",
  cursor: "pointer",
  fontSize: "13pt",
};

function isSame(prev, next) {
  if (prev == null || next == null) {
    return false;
  }
  return prev.close != next.close;
}

export const CloseX2: React.FC<Props> = React.memo((props: Props) => {
  const { close = undefined, style } = props;
  const mergedStyle = { ...DEFAULT_STYLE, ...style };

  if (!close) {
    return null;
  } else {
    return (
      <button
        type="button"
        className={"lighten"}
        style={{
          ...mergedStyle,
          background: "transparent",
          border: 0,
          padding: 0,
        }}
        onClick={close}
      >
        <Icon name={"times"} />
      </button>
    );
  }
}, isSame);
