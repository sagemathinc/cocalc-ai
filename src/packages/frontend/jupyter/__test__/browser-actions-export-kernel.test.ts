/** @jest-environment jsdom */
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("../widgets/manager", () => ({ WidgetManager: class {} }));
jest.mock("../download-html", () => ({ downloadHTML: jest.fn() }));

import { fromJS } from "immutable";
import { JupyterStore } from "@cocalc/jupyter/redux/store";
import { JupyterActions } from "../browser-actions";
import { downloadHTML } from "../download-html";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1sAAAAASUVORK5CYII=";
const savedSpec = {
  name: "remote-julia",
  display_name: "Saved Julia",
  language: "julia",
};

const blobHash = "a".repeat(40);

function setup(kernels: unknown, kernel: string | null = savedSpec.name) {
  const state = fromJS({
    notebook: {
      kernel,
      kernels,
      metadata: { kernelspec: savedSpec, language_info: { name: "julia" } },
      cells: {
        text: {
          id: "text",
          cell_type: "markdown",
          input: "Saved notebook text",
        },
        plot: {
          id: "plot",
          cell_type: "code",
          input: "display(saved_plot)",
          output: {
            0: { output_type: "display_data", data: { "image/png": blobHash } },
            1: { output_type: "stream", name: "stdout", text: "Saved result" },
          },
        },
      },
      cell_list: ["text", "plot"],
    },
  });
  const store = new JupyterStore("notebook", {
    reduxStore: { getState: () => state },
  } as any);
  const actions = new JupyterActions("notebook", {} as any);
  Object.assign(actions, {
    store,
    path: "saved.ipynb",
    isClosed: () => false,
    setState: jest.fn(),
  });
  const getBlob = jest.fn(async () =>
    Uint8Array.from(Buffer.from(png, "base64")),
  );
  actions.asyncBlobStore = { get: getBlob } as any;
  return { actions, store, state, getBlob };
}

function checkHTML(html: string) {
  expect(html).toContain("Saved Julia");
  expect(html).toContain("Saved notebook text");
  expect(html).toContain("Saved result");
  const image = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelector("img");
  expect(decodeURIComponent(image!.getAttribute("src")!)).toBe(
    `data:image/png;base64,${png}`,
  );
}

describe("saved-output export without a matching live kernel", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([undefined, null, [], [{ name: "python3", display_name: "Python" }]])(
    "renders text and embedded images with catalog %p",
    async (kernels) => {
      const { actions, store, state, getBlob } = setup(kernels);
      checkHTML(await actions.toHTML());
      expect(getBlob).toHaveBeenCalledTimes(1);
      expect(getBlob).toHaveBeenCalledWith(blobHash);
      expect(store.get("kernel")).toBe(savedSpec.name);
      expect(store.get("metadata").toJS().kernelspec).toEqual(savedSpec);
      expect(store.get("cells")).toBe(state.getIn(["notebook", "cells"]));
      expect(
        store.get("cells").getIn(["plot", "output", "0", "data", "image/png"]),
      ).toBe(blobHash);
      expect(actions.setState).not.toHaveBeenCalled();
    },
  );

  it("uses current catalog metadata when it matches the selected kernel", async () => {
    const { actions } = setup([
      { ...savedSpec, display_name: "Current Julia" },
    ]);
    const html = await actions.toHTML();
    expect(html).toContain("Current Julia");
    expect(html).not.toContain("Saved Julia");
  });

  it("renders an explicitly absent kernel without resurrecting saved metadata", async () => {
    const { actions } = setup(null, "");
    const html = await actions.toHTML();
    expect(html).toContain("No Kernel");
    expect(html).not.toContain("Saved Julia");
    expect(html).toContain("Saved notebook text");
  });

  it("downloads HTML using the real saved-output renderer", async () => {
    const { actions } = setup(undefined);
    await actions.nbconvertToHtml("cocalc-html");
    const [html, filename] = (downloadHTML as jest.Mock).mock.calls.at(-1);
    checkHTML(html);
    expect(filename).toBe("saved.html");
    expect(actions.setState).toHaveBeenLastCalledWith({
      nbconvert: expect.objectContaining({ state: "done", error: "" }),
    });
  });

  it("passes the same rendered outputs to the PDF print window", async () => {
    const { actions } = setup([]);
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
    await actions.nbconvertToHtml("cocalc-pdf");
    checkHTML(popup.document.write.mock.calls[0][0]);
    await popup.onload();
    expect(popup.print).toHaveBeenCalledTimes(1);
  });

  it("still rejects a notebook whose cells have not loaded", async () => {
    const { actions, getBlob } = setup(undefined);
    actions.store = { get: () => undefined } as any;
    await expect(actions.toHTML()).rejects.toThrow("not loaded");
    expect(getBlob).not.toHaveBeenCalled();
  });
});
