/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { Checkbox, Typography } from "antd";
import { useId } from "react";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  SUPPORT_CONTENT_CONSENT_LABEL,
  SUPPORT_CONTENT_CONSENT_DESCRIPTION,
} from "@cocalc/util/support-content-consent";

import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";

const { Paragraph } = Typography;

export default function SupportSubmissionNotice({
  style,
  contentConsent,
  onContentConsentChange,
  disabled,
}: {
  style?: CSSProperties;
  contentConsent: boolean;
  onContentConsentChange: (consent: boolean) => void;
  disabled?: boolean;
}) {
  const descriptionId = useId();
  return (
    <div
      style={{
        border: `2px solid ${UI_COLORS.border}`,
        borderRadius: 8,
        padding: 20,
        ...style,
      }}
    >
      <Checkbox
        checked={contentConsent}
        disabled={disabled}
        onChange={(event) => onContentConsentChange(event.target.checked)}
        aria-describedby={descriptionId}
        style={{
          fontSize: 17,
          fontWeight: 600,
          minHeight: 44,
          alignItems: "center",
        }}
      >
        {SUPPORT_CONTENT_CONSENT_LABEL}
      </Checkbox>
      <Paragraph id={descriptionId} style={{ marginTop: 12 }}>
        {SUPPORT_CONTENT_CONSENT_DESCRIPTION}
      </Paragraph>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        By submitting, you allow support staff and AI-assisted tools to review
        what you send and relevant backend diagnostic logs. Project-content
        inspection requires your separate permission above. All support handling
        is subject to our{" "}
        <a
          href={joinUrlPath(appBasePath, "policies/privacy")}
          style={{ textDecoration: "underline" }}
          target="_blank"
          rel="noreferrer"
        >
          Privacy Policy
        </a>{" "}
        and{" "}
        <a
          href={joinUrlPath(appBasePath, "policies/terms")}
          style={{ textDecoration: "underline" }}
          target="_blank"
          rel="noreferrer"
        >
          Terms of Service
        </a>
        .
      </Paragraph>
    </div>
  );
}
