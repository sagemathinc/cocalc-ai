/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { buildRunCommand, canRunFile, RUN_COMMANDS } from "./run-commands";

describe("canRunFile", () => {
  it("knows the interpreted languages we care about most", () => {
    expect(canRunFile("a.py")).toBe(true);
    expect(canRunFile("a.sage")).toBe(true);
    expect(canRunFile("a.r")).toBe(true);
  });

  it("matches the extension case insensitively, so .R works", () => {
    expect(canRunFile("a.R")).toBe(true);
    expect(canRunFile("a.PY")).toBe(true);
  });

  it("is false for files we have no interpreter for", () => {
    expect(canRunFile("a.txt")).toBe(false);
    expect(canRunFile("a.tex")).toBe(false);
    expect(canRunFile("Makefile")).toBe(false);
    expect(canRunFile("")).toBe(false);
  });
});

describe("buildRunCommand", () => {
  it("returns undefined for a file it cannot run", () => {
    expect(buildRunCommand("a.txt")).toBe(undefined);
  });

  it("builds the expected commands for python, sage and R", () => {
    expect(buildRunCommand("a.py")).toBe(`cd -- "$HOME" && python3 'a.py'`);
    expect(buildRunCommand("a.sage")).toBe(`cd -- "$HOME" && sage 'a.sage'`);
    expect(buildRunCommand("a.r")).toBe(`cd -- "$HOME" && Rscript 'a.r'`);
    expect(buildRunCommand("a.R")).toBe(`cd -- "$HOME" && Rscript 'a.R'`);
  });

  it("substitutes {name} for compiled languages", () => {
    expect(buildRunCommand("hello.c", { cd: false })).toBe(
      "gcc 'hello.c' -o ./'hello' && ./'hello'",
    );
    expect(buildRunCommand("Hello.java", { cd: false })).toBe(
      "javac 'Hello.java' && java 'Hello'",
    );
  });

  it("cds relative to HOME, since editor paths are relative to HOME", () => {
    // A fresh terminal frame for a/b/c.py already starts in a/b, so a
    // relative "cd a/b" would look for a/b/a/b -- and a terminal we reuse can
    // be anywhere at all.
    expect(buildRunCommand("a/b/c.py")).toBe(
      `cd -- "$HOME"/'a/b' && python3 'c.py'`,
    );
  });

  it("does not anchor an absolute path at HOME", () => {
    expect(buildRunCommand("/tmp/x/c.py")).toBe(
      `cd -- '/tmp/x' && python3 'c.py'`,
    );
  });

  it("omits the cd for the display form", () => {
    expect(buildRunCommand("a/b/c.py", { cd: false })).toBe("python3 'c.py'");
  });

  it("quotes filenames with spaces", () => {
    expect(buildRunCommand("my dir/my file.py")).toBe(
      `cd -- "$HOME"/'my dir' && python3 'my file.py'`,
    );
  });

  it("escapes single quotes rather than ending the quoted string", () => {
    expect(buildRunCommand("it's.py", { cd: false })).toBe(
      `python3 'it'\\''s.py'`,
    );
    expect(buildRunCommand("it's dir/x.py")).toBe(
      `cd -- "$HOME"/'it'\\''s dir' && python3 'x.py'`,
    );
  });

  it("does not let a filename act as a regexp replacement pattern", () => {
    // "$&" means "the matched text" to String.replace -- a filename must
    // never be able to inject anything into the command.
    expect(buildRunCommand("x$&y.py", { cd: false })).toBe("python3 'x$&y.py'");
    expect(buildRunCommand("x$'y.py", { cd: false })).toBe(
      `python3 'x$'\\''y.py'`,
    );
  });

  it("does not shell-inject via metacharacters in the name", () => {
    expect(buildRunCommand("a; rm -rf ~.py", { cd: false })).toBe(
      "python3 'a; rm -rf ~.py'",
    );
  });

  it("does not use npx, which can download or prompt", () => {
    expect(buildRunCommand("a.ts", { cd: false })).toBe("ts-node 'a.ts'");
  });

  it("has a template for every extension in the table", () => {
    for (const ext in RUN_COMMANDS) {
      expect(ext).toBe(ext.toLowerCase());
      expect(RUN_COMMANDS[ext]).toContain("{file}");
      expect(buildRunCommand(`x.${ext}`)).toBeTruthy();
    }
  });
});
