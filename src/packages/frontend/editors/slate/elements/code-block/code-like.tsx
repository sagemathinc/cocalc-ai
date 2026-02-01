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
}

export function CodeBlockBody({
  children,
  className,
  style,
}: CodeBlockBodyProps) {
  return (
    <div
      className={["cocalc-slate-code-block", className].filter(Boolean).join(" ")}
      style={style}
    >
      {children}
    </div>
  );
}
