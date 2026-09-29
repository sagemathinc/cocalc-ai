/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// One agent turn as a linear list of small rows: agent output, human
// guidance, and artifacts, in the order they happened. Rows are the unit of
// virtualization, rendering, and selection, so a turn that runs for days only
// renders the rows near the viewport and a streamed update only changes the
// last row. Row ids depend only on content before the row, so finished rows
// keep their identity (and measured height) while the turn continues.

import type { ArtifactPublication } from "@cocalc/chat";
import { markdownBlockBoundaries } from "@cocalc/chat";
import type { InlineCodexActivityBlock } from "./message-state";

// Target size, not a hard limit: non-code markdown blocks stay intact so their
// links, tables, and math still render correctly in independently parsed rows.
export const MAX_TIMELINE_ROW_CHARS = 4_000;

export type TurnTimelineRow =
  | { kind: "agent"; id: string; text: string; time?: number }
  | {
      kind: "guidance";
      id: string;
      text: string;
      time?: number;
      state?: InlineCodexActivityBlock["state"];
    }
  | { kind: "artifact"; id: string; publication: ArtifactPublication };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Split oversized fenced code at line boundaries. A fenced code
// block is closed and reopened around each cut so every part still renders
// as code with the same language.
function splitOversizedBlock(block: string, maxChars: number): string[] {
  const lines = block.split("\n");
  const fence = FENCE.exec(lines[0] ?? "");
  // Arbitrary cuts can bisect even a short link within a long paragraph, and
  // tables/math cannot be rendered independently without their block context.
  if (!fence) return [block];
  const closingIndex = lines.findIndex((line, index) => {
    if (index === 0) return false;
    const match = FENCE.exec(line);
    return (
      match != null &&
      match[1][0] === fence[1][0] &&
      match[1].length >= fence[1].length &&
      match[2].trim() === ""
    );
  });
  // A blank-line block can contain prose or another fence after the code.
  // Do not reinterpret that trailing content as part of this code block.
  if (closingIndex >= 0 && closingIndex < lines.length - 1) return [block];
  const open = lines[0];
  const close = fence[1];
  const body = lines.slice(1, closingIndex >= 0 ? closingIndex : undefined);
  const budget = Math.max(1, maxChars - open.length - close.length - 2);
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n");
    parts.push(`${open}\n${text}\n${close}`);
    current = [];
    size = 0;
  };
  for (const line of body) {
    for (const piece of splitLongLine(line, budget)) {
      if (size > 0 && size + piece.length + 1 > budget) flush();
      current.push(piece);
      size += piece.length + 1;
    }
  }
  flush();
  return parts.length > 0 ? parts : [block];
}

function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const pieces: string[] = [];
  let start = 0;
  while (start < line.length) {
    let end = Math.min(line.length, start + maxChars);
    // Never split a surrogate pair.
    if (
      end < line.length &&
      /[\uD800-\uDBFF]/.test(line[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(line[end])
    ) {
      // With a one-unit budget, keep the pair and exceed the soft limit rather
      // than retreating to start and looping forever.
      end += end - start === 1 ? 1 : -1;
    }
    pieces.push(line.slice(start, end));
    start = end;
  }
  return pieces;
}

// Split agent markdown into row-sized parts at top-level block boundaries,
// greedily packing whole blocks. Only oversized fenced code is cut inside.
export function splitAgentMarkdown(
  text: string,
  maxChars = MAX_TIMELINE_ROW_CHARS,
): string[] {
  if (text.length <= maxChars) return [text];
  const blocks: string[] = [];
  let start = 0;
  for (const boundary of markdownBlockBoundaries(text)) {
    blocks.push(text.slice(start, boundary.end));
    start = boundary.start;
  }
  blocks.push(text.slice(start));
  const parts: string[] = [];
  let current = "";
  for (const block of blocks) {
    if (block.length > maxChars) {
      if (current) parts.push(current);
      current = "";
      parts.push(...splitOversizedBlock(block, maxChars));
      continue;
    }
    if (current && current.length + 2 + block.length > maxChars) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${block}` : block;
  }
  if (current) parts.push(current);
  return parts;
}

function publicationTime(publication: ArtifactPublication): number {
  const time = Date.parse(publication.published_at ?? publication.date ?? "");
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

// Remembers how each agent block was split so a long turn's finished output
// is not re-split on every streamed update. Keyed by block position; a block
// whose text changed is split again.
export type AgentSplitCache = Map<number, { text: string; parts: string[] }>;

export function buildTurnTimelineRows({
  blocks,
  artifacts = [],
  maxChars = MAX_TIMELINE_ROW_CHARS,
  splitCache,
}: {
  blocks: readonly InlineCodexActivityBlock[];
  artifacts?: readonly ArtifactPublication[];
  maxChars?: number;
  splitCache?: AgentSplitCache;
}): TurnTimelineRow[] {
  const rows: TurnTimelineRow[] = [];
  // Artifacts are placed before the first block last updated after they were
  // published, i.e. after the output that preceded their publication.
  const pending = [...artifacts].sort(
    (a, b) => publicationTime(a) - publicationTime(b),
  );
  const emitArtifactsBefore = (time: number) => {
    while (pending.length > 0 && publicationTime(pending[0]) < time) {
      const publication = pending.shift()!;
      rows.push({
        kind: "artifact",
        id: `artifact:${publication.artifact_id}`,
        publication,
      });
    }
  };
  let agentIndex = 0;
  const guidanceIds = new Map<string, number>();
  for (const block of blocks) {
    const text = `${block.text ?? ""}`;
    if (!text.trim()) continue;
    if (typeof block.time === "number") emitArtifactsBefore(block.time);
    if (block.kind === "guidance") {
      const base = `guidance:${block.time ?? ""}`;
      const n = guidanceIds.get(base) ?? 0;
      guidanceIds.set(base, n + 1);
      // Long guidance uses the same soft row limit as agent output.
      splitAgentMarkdown(text, maxChars).forEach((part, part_index) => {
        rows.push({
          kind: "guidance",
          id: `${base}:${n}:${part_index}`,
          text: part,
          time: block.time,
          state: block.state,
        });
      });
      continue;
    }
    let parts =
      splitCache?.get(agentIndex)?.text === text
        ? splitCache.get(agentIndex)!.parts
        : undefined;
    if (parts == null) {
      parts = splitAgentMarkdown(text, maxChars);
      splitCache?.set(agentIndex, { text, parts });
    }
    parts.forEach((part, part_index) => {
      rows.push({
        kind: "agent",
        id: `agent:${agentIndex}:${part_index}`,
        text: part,
        time: block.time,
      });
    });
    agentIndex += 1;
  }
  emitArtifactsBefore(Number.POSITIVE_INFINITY);
  for (const publication of pending) {
    rows.push({
      kind: "artifact",
      id: `artifact:${publication.artifact_id}`,
      publication,
    });
  }
  return rows;
}
