import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import NotebookView, { parseNotebook, sourceText } from "./notebook-view";

jest.mock("./highlighted-code", () => ({
  __esModule: true,
  default: ({
    className,
    contents,
    language,
  }: {
    className: string;
    contents: string;
    language?: string;
  }) => (
    <pre className={className} data-language={language} data-testid="code-cell">
      {contents}
    </pre>
  ),
}));

test("joins Jupyter multiline sources without changing content", () => {
  expect(sourceText(["print('a')\n", "print('b')\n"])).toBe(
    "print('a')\nprint('b')\n",
  );
});

test("accepts notebook cell arrays", () => {
  expect(parseNotebook('{"nbformat":4,"cells":[]}')).toEqual({
    nbformat: 4,
    cells: [],
  });
});

test("rejects non-notebook JSON", () => {
  expect(() => parseNotebook('{"value":1}')).toThrow(
    "This file is not a valid Jupyter notebook.",
  );
});

test("does not execute notebook HTML output", () => {
  render(
    <NotebookView
      notebook={{
        cells: [
          {
            cell_type: "code",
            outputs: [
              {
                data: { "text/html": "<script>window.pwned = true</script>" },
              },
            ],
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/Interactive HTML output is omitted/)).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
});

test("renders Markdown notebook cells instead of their source", async () => {
  render(
    <NotebookView
      notebook={{
        cells: [{ cell_type: "markdown", source: "# A notebook heading" }],
      }}
    />,
  );
  expect(
    await screen.findByRole("heading", { name: "A notebook heading" }),
  ).toBeVisible();
});

test("highlights read-only code using notebook language metadata", () => {
  render(
    <NotebookView
      notebook={{
        cells: [{ cell_type: "code", source: "print('hello')" }],
        metadata: { language_info: { name: "python" } },
      }}
    />,
  );

  expect(screen.getByTestId("code-cell")).toHaveAttribute(
    "data-language",
    "python",
  );
});

test("loads referenced image output from the notebook blob resolver", async () => {
  const createObjectURL = jest.fn(() => "blob:notebook-output");
  const revokeObjectURL = jest.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  const blobResolver = {
    close: jest.fn(),
    resolve: jest.fn(async () => new Uint8Array([1, 2, 3])),
  };
  const { unmount } = render(
    <NotebookView
      blobResolver={blobResolver}
      notebook={{
        cells: [
          {
            cell_type: "code",
            outputs: [
              {
                data: { "image/png": "a".repeat(40) },
                output_type: "display_data",
              },
            ],
          },
        ],
      }}
    />,
  );

  expect(
    await screen.findByRole("img", { name: "Notebook output 1" }),
  ).toHaveAttribute("src", "blob:notebook-output");
  expect(blobResolver.resolve).toHaveBeenCalledWith("a".repeat(40));
  unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:notebook-output");
  delete (URL as any).createObjectURL;
  delete (URL as any).revokeObjectURL;
});
