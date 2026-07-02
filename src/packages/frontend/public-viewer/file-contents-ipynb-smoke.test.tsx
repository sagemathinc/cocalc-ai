import { render, screen } from "@testing-library/react";
import PublicViewerIpynbRenderer from "./renderers/ipynb";

jest.mock("@cocalc/frontend/codemirror/static", () => ({
  __esModule: true,
  default: {
    runMode: (value: string, _mode: unknown, append: (text: string) => void) =>
      append(value),
  },
}));

test("renders ipynb content as a readable notebook", async () => {
  const content = JSON.stringify({
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: ["# Demo Notebook\n", "\n", "A short introduction.\n"],
      },
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: ["print('hello world')\n"],
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: ["hello world\n"],
          },
        ],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        name: "python3",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });

  render(
    <PublicViewerIpynbRenderer
      content={content}
      fileContext={{ noSanitize: false }}
    />,
  );

  expect(await screen.findByText("Demo Notebook")).toBeTruthy();
  expect(await screen.findByText("A short introduction.")).toBeTruthy();
  expect(
    (
      await screen.findAllByText((_, elt) => {
        return (
          elt?.tagName === "PRE" &&
          elt.classList.contains("CodeMirror") &&
          `${elt.textContent ?? ""}`.includes("print('hello world')")
        );
      })
    ).length,
  ).toBeGreaterThan(0);
  expect(await screen.findByText("hello world")).toBeTruthy();
  expect(await screen.findByText("Kernel:")).toBeTruthy();
  expect(await screen.findByText("Python 3")).toBeTruthy();
});

test("renders ordinary notebook html output inline", async () => {
  const content = JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: ["display_html()"],
        outputs: [
          {
            output_type: "display_data",
            data: {
              "text/html":
                "<div data-testid='public-html-output'><h2>Notebook HTML</h2><button>Click me</button></div>",
            },
            metadata: {},
          },
        ],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        name: "python3",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });

  render(
    <PublicViewerIpynbRenderer
      content={content}
      fileContext={{ noSanitize: false }}
    />,
  );

  expect(await screen.findByText("Notebook HTML")).toBeTruthy();
  expect(await screen.findByText("Click me")).toBeTruthy();
  expect(screen.queryByTitle("Jupyter HTML output")).toBeNull();
});

test("renders full-document notebook html output inside an iframe", async () => {
  const content = JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: ["display_full_html()"],
        outputs: [
          {
            output_type: "display_data",
            data: {
              "text/html":
                "<html><body><h2>Full Notebook HTML</h2><button>Click me</button></body></html>",
            },
            metadata: {},
          },
        ],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        name: "python3",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  });

  render(
    <PublicViewerIpynbRenderer
      content={content}
      fileContext={{ noSanitize: false }}
    />,
  );

  const iframe = await screen.findByTitle("Jupyter HTML output");
  expect(iframe.tagName).toBe("IFRAME");
  expect(iframe.getAttribute("srcdoc")).toContain("Full Notebook HTML");
});
