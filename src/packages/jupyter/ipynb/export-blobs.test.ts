import { export_to_ipynb } from "./export-to-ipynb";

const sha = "0123456789abcdef0123456789abcdef01234567";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";

function notebook(mime: string, value: string | undefined) {
  const blob_store = {
    getBase64: jest.fn(() => value),
    getString: jest.fn(() => value),
  };
  const ipynb = export_to_ipynb({
    cell_list: ["cell-1"],
    cells: {
      "cell-1": {
        cell_type: "code",
        input: "display(image)",
        exec_count: 1,
        output: { "0": { data: { [mime]: sha, "text/plain": "image" } } },
      },
    },
    blob_store,
  });
  return { ipynb, output: ipynb.cells[0].outputs![0], blob_store };
}

describe("exporting blob-backed MIME bundles", () => {
  it.each([
    ["image/png", png],
    ["application/pdf", Buffer.from("%PDF-1.4\n").toString("base64")],
  ])("keeps decoded %s under data", (mime, value) => {
    const { output, blob_store } = notebook(mime, value);
    expect(output.data[mime]).toBe(value);
    expect(output).not.toHaveProperty(mime);
    expect(blob_store.getBase64).toHaveBeenCalledWith(sha);
    expect(blob_store.getString).not.toHaveBeenCalled();
    expect(output.output_type).toBe("execute_result");
    expect(output.execution_count).toBe(1);
  });

  it("restores SVG text rather than base64 encoding it", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    const { output, blob_store } = notebook("image/svg+xml", svg);
    expect(output.data["image/svg+xml"]).toBe(svg);
    expect(output).not.toHaveProperty("image/svg+xml");
    expect(blob_store.getString).toHaveBeenCalledWith(sha);
    expect(blob_store.getBase64).not.toHaveBeenCalled();
  });

  it("maps iframe blobs to text/html inside the MIME bundle", () => {
    const html = "<div>first</div>\n<div>second</div>";
    const { output } = notebook("iframe", html);
    expect(output.data["text/html"].join("")).toBe(html);
    expect(output.data).not.toHaveProperty("iframe");
    expect(output).not.toHaveProperty("iframe");
    expect(output).not.toHaveProperty("text/html");
  });

  it.each(["image/png", "image/svg+xml", "application/pdf", "iframe"])(
    "omits an unavailable %s blob without embedding its hash",
    (mime) => {
      const { output } = notebook(mime, undefined);
      expect(output.data).not.toHaveProperty(mime);
      expect(JSON.stringify(output)).not.toContain(sha);
      expect(output.data["text/plain"]).toEqual(["image"]);
    },
  );
});
