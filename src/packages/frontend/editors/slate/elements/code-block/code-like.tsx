/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ReactNode } from "react";

interface CodeLineProps {
  attributes: any;
  children: ReactNode;
}

export function CodeLineElement({ attributes, children }: CodeLineProps) {
  return (
    <div
      {...attributes}
      className="cocalc-slate-code-line"
      style={{ position: "relative" }}
    >
      {children}
    </div>
  );
}

interface CodeBlockBodyProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onPaste?: React.ClipboardEventHandler<HTMLDivElement>;
}

export function CodeBlockBody({
  children,
  className,
  style,
  onPaste,
}: CodeBlockBodyProps) {
  return (
    <div
      className={["cocalc-slate-code-block", className].filter(Boolean).join(" ")}
      style={style}
      onPaste={onPaste}
    >
      {children}
    </div>
  );
}
