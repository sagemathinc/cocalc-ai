/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { searchCandidates } from "./search";
import type { Candidate } from "./model";
const candidate = (title: string, detail = "", priority = 0): Candidate => ({
  id: title,
  title,
  detail,
  priority,
  destination: { kind: "project", projectId: title },
});

describe("Quick Navigation matching", () => {
  it("matches every term across project, filename and frame, with highlights", () => {
    const item = candidate("PDF Preview", "Algebra › notes.tex");
    const result = searchCandidates(
      [item, candidate("Notes", "Biology")],
      "alg not pdf",
    );
    expect(result.map((x) => x.item)).toEqual([item]);
    expect(result[0].title).toEqual([[0, 3]]);
    expect(result[0].detail).toEqual([
      [0, 3],
      [10, 13],
    ]);
  });
  it("ranks exact names before prefixes, substrings and typo matches regardless of project", () => {
    const items = [
      candidate("Notes", "", 99),
      candidate("Notes2026"),
      candidate("MyNotes"),
      candidate("footnotes"),
      candidate("Ntoes"),
    ];
    expect(
      searchCandidates(items.reverse(), "notes").map((x) => x.item.title),
    ).toEqual(["Notes", "Notes2026", "MyNotes", "footnotes"]);
    // Typo tolerance only kicks in when nothing matches exactly.
    expect(searchCandidates(items, "ntoes").map((x) => x.item.title)).toEqual([
      "Ntoes",
    ]);
    const typo = searchCandidates(
      items.filter((x) => x.title !== "Ntoes"),
      "ntoes",
    ).map((x) => x.item.title);
    expect(typo).toContain("Notes");
    expect(typo).toContain("Notes2026");
    expect(typo).not.toContain("footnotes");
  });
  it("recognizes word boundaries and accents without corrupting highlight offsets", () => {
    const result = searchCandidates(
      [candidate("ÉtudeNotes.tex", "Reports/Überblick")],
      "ETU not uber",
    )[0];
    expect(result.title).toEqual([
      [0, 3],
      [5, 8],
    ]);
    expect(result.detail).toEqual([[8, 12]]);
  });
  it("tolerates a swapped, missing, wrong or extra character, anchored on the first letter", () => {
    expect(
      searchCandidates([candidate("Appearance")], "apearance"),
    ).toHaveLength(1);
    expect(
      searchCandidates([candidate("Appearance")], "apperaance"),
    ).toHaveLength(1);
    expect(searchCandidates([candidate("PDF")], "pfd")).toHaveLength(1);
    expect(searchCandidates([candidate("rnw.rnw")], "rwn")).toHaveLength(1);
    expect(searchCandidates([candidate("rnw.rnw")], "rnww")).toHaveLength(1);
    expect(searchCandidates([candidate("chapter2")], "chatper")).toHaveLength(
      1,
    );
    // Two characters are too little to guess, and the first letter must match.
    expect(searchCandidates([candidate("PDF")], "pf")).toHaveLength(0);
    expect(searchCandidates([candidate("Notes")], "botes")).toHaveLength(0);
    expect(searchCandidates([candidate("Notes")], "other")).toHaveLength(0);
  });
  it("uses open/bookmarked project priority and recency for equivalent matches", () => {
    const items = [
      candidate("Notes old", "", 30),
      candidate("Notes bookmark", "", 20),
      candidate("Notes open", "", 10),
    ];
    expect(
      searchCandidates(items, "notes").map((x) => x.item.priority),
    ).toEqual([10, 20, 30]);
    const a = { ...candidate("Notes A"), recent: 1 };
    const b = { ...candidate("Notes B"), recent: 2 };
    expect(searchCandidates([a, b], "notes")[0].item).toBe(b);
  });
  it("treats digits, punctuation and regex metacharacters as literal searchable text", () => {
    expect(
      searchCandidates([candidate("2026 [draft].tex")], "2026 [draft]"),
    ).toHaveLength(1);
  });
  it("matches a prefix of a longer word with an extra typed character", () => {
    expect(
      searchCandidates([candidate("spectral.ipynb")], "specct"),
    ).toHaveLength(1);
    expect(
      searchCandidates([candidate("spectral.ipynb")], "spectral")[0].title,
    ).toEqual([[0, 8]]);
  });
});
