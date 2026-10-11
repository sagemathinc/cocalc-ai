/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";

import { BrowserStartScreen } from "./start-screen";

describe("BrowserStartScreen", () => {
  it("shows the browser's name and where it is in starting", () => {
    const { container, rerender } = render(
      <BrowserStartScreen name="work.browser" step="project" />,
    );
    expect(screen.getByText("work.browser")).toBeTruthy();
    expect(screen.getByText("Starting the project")).toBeTruthy();
    expect(screen.getByText("Starting Chromium")).toBeTruthy();
    expect(container.querySelector(".cc-bs-now")?.textContent).toBe(
      "Starting the project",
    );

    rerender(<BrowserStartScreen name="work.browser" step="connecting" />);
    expect(screen.getByText("Project ready")).toBeTruthy();
    expect(screen.getByText("Chromium ready")).toBeTruthy();
    expect(container.querySelector(".cc-bs-now")?.textContent).toBe(
      "Connecting",
    );
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Connecting: work.browser",
    );
  });

  it("resumes from the last picture, and fades out when the page is there", () => {
    const picture = "data:image/jpeg;base64,AAAA";
    const { container, rerender } = render(
      <BrowserStartScreen name="work.browser" step="browser" picture={picture} />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(picture);
    expect(screen.getByText("Resuming where it was")).toBeTruthy();
    expect(container.querySelector(".cc-bs-sk")).toBeNull();
    expect(container.querySelector(".cc-bs-done")).toBeNull();

    rerender(
      <BrowserStartScreen
        name="work.browser"
        step="connecting"
        picture={picture}
        done
      />,
    );
    expect(container.querySelector(".cc-bs-done")).not.toBeNull();
  });
});
