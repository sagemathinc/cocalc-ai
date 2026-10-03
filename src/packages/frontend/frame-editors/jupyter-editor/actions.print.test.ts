/** @jest-environment jsdom */
/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/jupyter/widgets/manager", () => ({
  WidgetManager: class {},
}));
jest.mock("@cocalc/frontend/jupyter/download-html", () => ({
  downloadHTML: jest.fn(),
}));

import { Map } from "immutable";
import { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { downloadHTML } from "@cocalc/frontend/jupyter/download-html";
import { cm_options } from "../codemirror/cm-options";
import { JupyterEditorActions } from "./actions";

describe("notebook Print", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(["frame action", "Ctrl-P", "Cmd-P"])(
    "%s opens the browser print flow without downloading HTML",
    async (command) => {
      const popup: any = {
        document: {
          open: jest.fn(),
          write: jest.fn(),
          close: jest.fn(),
          images: [],
        },
        print: jest.fn(),
        close: jest.fn(),
      };
      jest.spyOn(window, "open").mockReturnValue(popup);
      (downloadHTML as jest.Mock).mockClear();
      const jupyter = new JupyterActions("print-test", {
        getStore: jest.fn(() => undefined),
        removeActions: jest.fn(),
      } as any);
      jest.spyOn(jupyter, "isClosed").mockReturnValue(false);
      const setState = jest
        .spyOn(jupyter, "setState")
        .mockImplementation(() => {});
      jest.spyOn(jupyter, "toHTML").mockResolvedValue("<html>Notebook</html>");
      const frame: any = {
        jupyter_actions: jupyter,
        print: JupyterEditorActions.prototype.print,
      };
      if (command === "frame action") {
        frame.print("frame-1");
      } else {
        const options = cm_options(
          "notebook.ipynb",
          Map({ theme: "default" }) as any,
          [],
          frame,
          frame,
          "frame-1",
        );
        options.extraKeys[command]();
      }
      const format = setState.mock.calls[0][0].nbconvert_dialog.to;
      expect(format).toBe("cocalc-pdf");
      await jupyter.nbconvertToHtml(format);
      expect(popup.document.write).toHaveBeenCalledWith(
        "<html>Notebook</html>",
      );
      await popup.onload();
      expect(popup.print).toHaveBeenCalledTimes(1);
      expect(downloadHTML).not.toHaveBeenCalled();
      popup.onafterprint();
      expect(popup.close).toHaveBeenCalledTimes(1);
    },
  );
});
