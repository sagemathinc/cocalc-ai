#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  DEFAULT_LEDGER_ROOT,
  buildEntry,
  formatTaskNote,
  writeLedgerEntry,
} = require("./ledger-utils.js");

function createDefaultNoteOptions() {
  return {
    taskId: "",
    title: "",
    area: "",
    result: "",
    evidence: [],
    artifacts: [],
    validation: [],
    commitSha: "",
    confidence: "",
    iteration: "",
    ledgerRoot: DEFAULT_LEDGER_ROOT,
  };
}

function parseNoteArg(argv, index, note, usageAndExit) {
  const arg = argv[index];
  if (arg === "--task-id") {
    note.taskId =
      `${argv[index + 1] || ""}`.trim() ||
      usageAndExit("--task-id requires a value");
    return index + 1;
  }
  if (arg === "--note-title") {
    note.title = `${argv[index + 1] || ""}`.trim();
    return index + 1;
  }
  if (arg === "--area") {
    note.area =
      `${argv[index + 1] || ""}`.trim() ||
      usageAndExit("--area requires a value");
    return index + 1;
  }
  if (arg === "--result") {
    note.result =
      `${argv[index + 1] || ""}`.trim() ||
      usageAndExit("--result requires a value");
    return index + 1;
  }
  if (arg === "--evidence") {
    note.evidence.push(
      `${argv[index + 1] || ""}`.trim() ||
        usageAndExit("--evidence requires a value"),
    );
    return index + 1;
  }
  if (arg === "--artifact" || arg === "--artifact-dir") {
    note.artifacts.push(
      path.resolve(argv[index + 1] || usageAndExit(`${arg} requires a path`)),
    );
    return index + 1;
  }
  if (arg === "--validation") {
    note.validation.push(
      `${argv[index + 1] || ""}`.trim() ||
        usageAndExit("--validation requires a value"),
    );
    return index + 1;
  }
  if (arg === "--commit-sha") {
    note.commitSha =
      `${argv[index + 1] || ""}`.trim() ||
      usageAndExit("--commit-sha requires a value");
    return index + 1;
  }
  if (arg === "--confidence") {
    note.confidence =
      `${argv[index + 1] || ""}`.trim() ||
      usageAndExit("--confidence requires a value");
    return index + 1;
  }
  if (arg === "--iteration") {
    note.iteration =
      `${argv[index + 1] || ""}`.trim() ||
      usageAndExit("--iteration requires a value");
    return index + 1;
  }
  if (arg === "--ledger-root") {
    note.ledgerRoot = path.resolve(
      argv[index + 1] || usageAndExit("--ledger-root requires a path"),
    );
    return index + 1;
  }
  return index;
}

function noteRequested(note) {
  return [
    note.taskId,
    note.title,
    note.area,
    note.result,
    ...(note.evidence ?? []),
    ...(note.artifacts ?? []),
    ...(note.validation ?? []),
    note.commitSha,
    note.confidence,
    note.iteration,
  ].some((value) => `${value ?? ""}`.trim());
}

function createLedgerNote(note, context, extras = {}, now = new Date()) {
  if (!noteRequested(note)) return undefined;
  const entry = buildEntry(
    {
      taskId: note.taskId,
      title: note.title || extras.title || "",
      area: note.area,
      result: note.result,
      evidence: [...(note.evidence ?? []), ...(extras.evidence ?? [])],
      artifacts: [...(note.artifacts ?? []), ...(extras.artifacts ?? [])],
      validation: [...(note.validation ?? []), ...(extras.validation ?? [])],
      commitSha: note.commitSha || extras.commitSha || "",
      confidence: note.confidence || extras.confidence || "",
      iteration: note.iteration || extras.iteration || "",
      ledgerRoot: note.ledgerRoot || DEFAULT_LEDGER_ROOT,
    },
    context,
    now,
  );
  const paths = writeLedgerEntry(note.ledgerRoot || DEFAULT_LEDGER_ROOT, entry);
  return {
    ...entry,
    ledger_json: paths.json,
    ledger_markdown: paths.markdown,
    task_note: formatTaskNote(entry),
  };
}

module.exports = {
  createDefaultNoteOptions,
  createLedgerNote,
  noteRequested,
  parseNoteArg,
};
