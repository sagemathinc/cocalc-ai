/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type TokenLike = {
  type: string;
  block?: boolean;
  nesting: number;
  level: number;
  map?: [number, number] | null;
};

function isTopLevelBlockStart(token: TokenLike): boolean {
  if (!token.block || token.level !== 0 || token.map == null) {
    return false;
  }
  return token.nesting === 1 || token.nesting === 0;
}

function addBlankTokens(
  tokens: any[],
  Token: any,
  startLine: number,
  endLine: number
): void {
  for (let line = startLine; line < endLine; line++) {
    const blank = new Token("blank_line", "p", 0);
    blank.block = true;
    blank.level = 0;
    blank.map = [line, line + 1];
    blank.content = "";
    tokens.push(blank);
  }
}

export function blankLinesPlugin(md): void {
  md.core.ruler.push("blank_lines", (state) => {
    const tokens = state.tokens ?? [];
    if (tokens.length === 0) return;

    const totalLines = state.src.split("\n").length;
    const out: any[] = [];
    let lastEnd = 0;
    let sawBlock = false;

    for (const token of tokens) {
      if (isTopLevelBlockStart(token)) {
        const start = token.map?.[0] ?? 0;
        const end = token.map?.[1] ?? start;

        if (!sawBlock) {
          if (start > 0) {
            addBlankTokens(out, state.Token, 0, start);
          }
          sawBlock = true;
        } else {
          const gap = start - lastEnd;
          if (gap > 1) {
            addBlankTokens(out, state.Token, lastEnd + 1, start);
          }
        }

        lastEnd = end;
      }

      out.push(token);
    }

    if (sawBlock) {
      const trailing = totalLines - lastEnd - 1;
      if (trailing > 0) {
        addBlankTokens(out, state.Token, lastEnd, lastEnd + trailing);
      }
    }

    state.tokens = out;
  });
}
