import { createMarkdownParser } from "./parser";

const md = createMarkdownParser();

function rows(markdown: string): string[][] {
  const result: string[][] = [];
  for (const token of md.parse(markdown, {})) {
    if (token.type === "tr_open") result.push([]);
    if (token.type === "inline") result[result.length - 1]?.push(token.content);
  }
  return result;
}

describe("table cells beyond the header's columns", () => {
  it("keeps text after a row's last pipe in its last cell", () => {
    expect(rows("| x | y |\n| - | - |\n| a | b | extra\n")).toEqual([
      ["x", "y"],
      ["a", "b | extra"],
    ]);
  });

  it("keeps whole extra cells, with or without outer pipes", () => {
    expect(rows("| x | y |\n| - | - |\n| a | b | c | d |\na | b |extra\n")).toEqual([
      ["x", "y"],
      ["a", "b | c | d"],
      ["a", "b | extra"],
    ]);
  });

  it("leaves ordinary, short and escaped-pipe rows alone", () => {
    expect(rows("| x | y |\n| - | - |\n| a \\| b | c |\n| d |\n")).toEqual([
      ["x", "y"],
      ["a | b", "c"],
      ["d", ""],
    ]);
  });

  it("works for tables in quotes and lists", () => {
    expect(rows("> | x | y |\n> | - | - |\n> | a | b | c |\n")).toEqual([
      ["x", "y"],
      ["a", "b | c"],
    ]);
    expect(rows("- item\n\n  | x |\n  | - |\n  | a | b |\n")).toEqual([
      ["x"],
      ["a | b"],
    ]);
  });
});
