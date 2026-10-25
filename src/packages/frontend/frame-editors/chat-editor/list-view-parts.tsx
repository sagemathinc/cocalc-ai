/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, ConfigProvider } from "antd";
import type { ReactNode } from "react";

/** What a calendar or todo file could not say: the first ten problems, and
 * whether the rest is still shown. */
export function ParseProblems({
  problems,
  shown,
  what,
}: {
  problems: { path: string; message: string }[];
  shown: boolean;
  what: string;
}) {
  if (problems.length === 0) return null;
  return (
    <Alert
      type={shown ? "info" : "error"}
      title={
        shown
          ? `Some of this ${what} could not be read; the rest is shown.`
          : `This is not a ${what} CoCalc can show.`
      }
      description={
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {problems.slice(0, 10).map((p, i) => (
            <li key={i}>
              {p.path ? <code>{p.path}</code> : null} {p.message}
            </li>
          ))}
        </ul>
      }
      style={{ marginBottom: 8 }}
    />
  );
}

/** The chat's font size (View > Zoom) or a frame's scales the text and the
 * antd controls together, like the other artifacts. */
export function FontScale({
  fontSize,
  children,
}: {
  fontSize?: number;
  children: ReactNode;
}) {
  if (!fontSize) return <>{children}</>;
  return (
    <ConfigProvider
      theme={{
        token: { fontSize, controlHeight: Math.round((32 * fontSize) / 14) },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
