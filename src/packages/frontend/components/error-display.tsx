/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// DEPRECATED -- the ShowError component in ./error.tsx is much better.

import { Alert } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { COLORS } from "@cocalc/util/theme";
import { normalizeUserFacingError } from "./user-facing-error";

// use "style" to customize
const ELEMENT_STYLE: CSSProperties = {
  overflowY: "auto",
} as const;

// use "body_style" prop to customize
const BODY_STYLE: CSSProperties = {
  marginRight: "10px",
  whiteSpace: "pre-wrap",
} as const;

const TECHNICAL_DETAILS_STYLE: CSSProperties = {
  marginTop: "8px",
  fontSize: "12px",
} as const;

const TECHNICAL_PRE_STYLE: CSSProperties = {
  background: COLORS.GRAY_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: "4px",
  marginTop: "6px",
  maxHeight: "160px",
  overflow: "auto",
  padding: "8px",
  whiteSpace: "pre-wrap",
} as const;

interface Props {
  error?: string | object;
  error_component?: React.JSX.Element | React.JSX.Element[];
  title?: string;
  style?: CSSProperties;
  body_style?: CSSProperties;
  componentStyle?: CSSProperties;
  bsStyle?: string;
  onClose?: () => void;
  banner?: boolean;
}

export function ErrorDisplay({
  error,
  error_component,
  title,
  body_style,
  componentStyle,
  style,
  bsStyle,
  onClose,
  banner = false,
}: Props) {
  function render_title() {
    return <h4>{title}</h4>;
  }

  function render_error(): ReactNode {
    if (error) {
      const { message, details } = normalizeUserFacingError(error);
      return (
        <>
          <div>{message}</div>
          {details && (
            <details style={TECHNICAL_DETAILS_STYLE}>
              <summary>Technical details</summary>
              <pre style={TECHNICAL_PRE_STYLE}>{details}</pre>
            </details>
          )}
        </>
      );
    } else {
      return error_component;
    }
  }

  function type(): string {
    if (
      // only types that antd has...
      bsStyle != null &&
      ["success", "info", "warning", "error"].includes(bsStyle)
    ) {
      return bsStyle;
    } else {
      return "error";
    }
  }

  function msgdesc() {
    const body = (
      <div style={{ ...BODY_STYLE, ...body_style }}>{render_error()}</div>
    );
    if (title) {
      return [render_title(), body];
    } else {
      return [body, undefined];
    }
  }

  function render_alert() {
    const [title, description] = msgdesc();
    return (
      <Alert
        banner={banner}
        showIcon
        style={{ ...ELEMENT_STYLE, ...style }}
        type={type() as any}
        title={title}
        description={description}
        closable={onClose != null || banner}
        onClose={onClose}
      />
    );
  }

  return <div style={componentStyle}>{render_alert()}</div>;
}
