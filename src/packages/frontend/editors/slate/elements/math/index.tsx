/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { Element, Node } from "slate";
import { register, RenderElementProps, SlateElement } from "../register";
import { useFileContext } from "@cocalc/frontend/lib/file-context";
import DefaultMath from "@cocalc/frontend/components/math/ssr";

export interface DisplayMath extends SlateElement {
  type: "math_block";
  value: string;
  isVoid?: boolean;
}

export interface InlineMath extends SlateElement {
  type: "math_inline";
  value: string;
  display?: boolean; // inline but acts as displayed math
  isInline: true;
  isVoid?: boolean;
}

export const StaticElement: React.FC<RenderElementProps> = ({
  attributes,
  element,
}) => {
  const { MathComponent } = useFileContext();
  if (element.type != "math_block" && element.type != "math_inline") {
    // type guard.
    throw Error("bug");
  }
  const value = stripMathDelimiters(element.value ?? Node.string(element));
  const C = MathComponent ?? DefaultMath;
  return (
    <span {...attributes}>
      <C
        data={wrap(value, element.type == "math_inline" && !element.display)}
      />
    </span>
  );
};

function wrap(math, isInline) {
  math = "$" + math + "$";
  if (!isInline) {
    math = "$" + math + "$";
  }
  return math;
}

function stripMathDelimiters(s: string): string {
  const trimmed = s.trim();
  if (
    trimmed.startsWith("$$") &&
    trimmed.endsWith("$$") &&
    trimmed.length >= 4
  ) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("$") && trimmed.endsWith("$") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return trimmed.slice(2, -2).trim();
  }
  if (trimmed.startsWith("\\(") && trimmed.endsWith("\\)")) {
    return trimmed.slice(2, -2).trim();
  }
  return s;
}

register({
  slateType: ["math_inline", "math_inline_double"],
  StaticElement,
  toSlate: ({ token }) => {
    const value = stripMathDelimiters(stripMathEnvironment(token.content));
    return {
      type: "math_inline",
      value,
      isInline: true,
      isVoid: true,
      children: [{ text: value }],
      display: token.type == "math_inline_double",
    } as Element;
  },
});

export function toDisplayMath({ token }) {
  const value = stripMathEnvironment(token.content).trim();
  return {
    type: "math_block",
    value,
    isVoid: true,
    children: [{ text: value }],
  } as Element;
}

register({
  slateType: ["math_block", "math_block_eqno"],
  StaticElement,
  toSlate: toDisplayMath,
});

export function stripMathEnvironment(s: string): string {
  // These environments get detected, but we must remove them, since once in
  // math mode they make no sense. All the other environments do make sense.
  for (const env of ["math", "displaymath"]) {
    if (s.startsWith(`\\begin{${env}}`)) {
      return s.slice(
        `\\begin{${env}}`.length,
        s.length - `\\end{${env}}`.length,
      );
    }
  }
  return s;
}
