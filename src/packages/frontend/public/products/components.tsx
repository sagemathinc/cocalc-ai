/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, App as AntdApp } from "antd";
import { COLORS } from "@cocalc/util/theme";

export function CodeCommand({ value }: { value: string }) {
  return (
    <div
      style={{
        background: "#f8fafc",
        border: `1px solid ${COLORS.GRAY_LL}`,
        borderRadius: 12,
        padding: 16,
      }}
    >
      <code style={{ fontSize: "0.95rem", wordBreak: "break-all" }}>
        {value}
      </code>
    </div>
  );
}

export function CopyCommandButton({ value }: { value: string }) {
  const { message } = AntdApp.useApp();

  return (
    <Button
      onClick={() => {
        if (typeof navigator === "undefined" || navigator.clipboard == null) {
          void message.info("Copy the command manually from the box below.");
          return;
        }
        void navigator.clipboard.writeText(value).then(
          () => void message.success("Install command copied."),
          () => void message.error("Unable to copy command."),
        );
      }}
    >
      Copy command
    </Button>
  );
}
