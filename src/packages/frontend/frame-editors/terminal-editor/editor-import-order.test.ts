/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

describe("terminal editor registration", () => {
  it.each(["terminal", "code", "factory"])(
    "keeps the terminal frame defined when %s is imported first",
    (first) => {
      jest.isolateModules(() => {
        if (first === "terminal") {
          require("./editor");
        } else if (first === "code") {
          require("../code-editor/editor");
        } else {
          require("../frame-tree/editor");
        }
        const { terminal, Editor: TerminalEditor } = require("./editor");
        const { Editor: CodeEditor } = require("../code-editor/editor");
        expect(terminal).toBeDefined();
        expect(TerminalEditor.editor_spec.terminal).toBe(terminal);
        expect(CodeEditor.editor_spec.terminal).toBe(terminal);
        expect(terminal.component).toBeDefined();
      });
    },
  );
});
