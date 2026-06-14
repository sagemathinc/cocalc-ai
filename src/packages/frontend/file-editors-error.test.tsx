/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

jest.mock("antd", () => ({
  Alert: ({ title, description }: any) => (
    <div>
      <div>{title}</div>
      {description}
    </div>
  ),
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: any) => <span>{name}</span>,
  Paragraph: ({ children }: any) => <p>{children}</p>,
}));

import { EditorLoadError } from "./file-editors-error";

describe("EditorLoadError", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("logs the original error and stack trace when rendered", () => {
    const error = new Error("Cannot read properties of undefined");
    error.stack = "Error: Cannot read properties of undefined\n    at chunk";

    render(<EditorLoadError path="/tmp/example.md" error={error} />);

    expect(screen.getByText("Editor Load Failed")).toBeTruthy();
    expect(screen.getByText(/Full error details/)).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      "CoCalc editor load failed",
      expect.objectContaining({
        path: "/tmp/example.md",
        phase: "error-component",
        message: error.message,
        stack: error.stack,
        error,
      }),
    );
    expect(warn).toHaveBeenCalledWith(error.stack);
  });
});
