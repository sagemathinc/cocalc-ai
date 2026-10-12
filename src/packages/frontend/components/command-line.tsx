/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A command to run in a terminal, made easy to copy: a big Copy button in
// front, and clicking the command itself copies it too (and says so). Use it
// for the one line someone must paste elsewhere (setting up SSH, connecting a
// computer), not for every snippet.

import { Button } from "antd";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "@cocalc/frontend/components/icon";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { copyTextToClipboard } from "./copy-to-clipboard-util";

/**
 * The URL of a one-line setup script on this site (see
 * server/cli-setup/setup-script.ts), for `curl -fsSL '<url>' | sh`.
 */
export function cliSetupUrl(params: Record<string, string>): string {
  const url = new URL(
    `${appBasePath.replace(/\/+$/, "")}/api/v2/cli/setup`,
    window.location.origin,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

/** The line to show: fetch the script and run it (prompts use the terminal). */
export function cliSetupLine(params: Record<string, string>): string {
  return `curl -fsSL '${cliSetupUrl(params).replace(/'/g, "%27")}' | sh`;
}

export function CommandLine({
  command,
  copiedHint = "Copied: paste it in a terminal.",
  style,
}: {
  command: string;
  /** Said after copying. */
  copiedHint?: string;
  style?: CSSProperties;
}) {
  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setCopied(false);
  }, [command]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    // Select it too, so it is obvious what was copied.
    const node = textRef.current;
    if (node != null && typeof window !== "undefined") {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    if (await copyTextToClipboard({ text: command })) {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 4000);
    }
  }

  return (
    <div style={{ width: "100%", ...style }}>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <Button
          type="primary"
          size="large"
          icon={<Icon name={copied ? "check" : "copy"} />}
          onClick={() => void copy()}
          aria-label="Copy the command"
          style={{ height: "auto", minHeight: 40 }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <code
          ref={textRef}
          role="button"
          tabIndex={0}
          title="Click to copy"
          onClick={() => void copy()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void copy();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            padding: "8px 12px",
            fontFamily: "monospace",
            fontSize: "0.95em",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            background: UI_COLORS.inset,
            border: `1px solid ${copied ? UI_COLORS.success : UI_COLORS.border}`,
            borderRadius: 6,
            cursor: "copy",
          }}
        >
          {command}
        </code>
      </div>
      <div
        role="status"
        aria-live="polite"
        style={{
          minHeight: "1.5em",
          marginTop: 4,
          fontSize: "0.9em",
          color: copied ? UI_COLORS.success : UI_COLORS.secondary,
        }}
      >
        {copied ? copiedHint : "Click to copy."}
      </div>
    </div>
  );
}
