/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

const registerFileEditor = jest.fn();

jest.mock("@cocalc/frontend/file-associations", () => ({
  file_associations: {
    json: { editor: "codemirror" },
    png: { editor: "media" },
    txt: { editor: "codemirror" },
  },
}));

jest.mock("../frame-tree/register", () => ({
  register_file_editor: (options) => registerFileEditor(options),
}));

jest.mock("./editor", () => ({
  Editor: function CodeEditor() {
    return null;
  },
}));

jest.mock("./actions", () => ({
  Actions: class CodeEditorActions {},
}));

import "./register";

describe("code editor registration", () => {
  it("loads the CodeMirror editor when requested", async () => {
    expect(registerFileEditor).toHaveBeenCalledTimes(1);
    const registration = registerFileEditor.mock.calls[0][0];
    expect(registration.ext).toEqual(["json", "txt"]);
    expect(registration.codemirror).toBe(true);
    expect(registration.component).toBeUndefined();
    expect(registration.Actions).toBeUndefined();
    expect((await registration.editor()).Editor).toBeInstanceOf(Function);
    expect((await registration.actions()).Actions).toBeInstanceOf(Function);
  });
});
