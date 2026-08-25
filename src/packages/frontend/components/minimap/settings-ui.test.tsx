/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { createMinimapSettings } from "./settings";
import { useMinimapSettingsModal } from "./settings-ui";

function makeApi() {
  return createMinimapSettings({
    enabledKey: "e",
    kindKey: "k",
    widthKeys: { text: "wt", stylized: "ws" },
    changedEvent: "changed",
    openSettingsEvent: "open-settings",
    defaultEnabled: true,
    defaultKind: "text",
    widths: {
      text: { default: 120, min: 56, max: 240 },
      stylized: { default: 40, min: 16, max: 120 },
    },
  });
}

const api = makeApi();

function Harness() {
  const { modal, open } = useMinimapSettingsModal({ api });
  return (
    <div>
      <button onClick={open}>open</button>
      {modal}
    </div>
  );
}

function openModal() {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "open" }));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("minimap settings dialog", () => {
  it("gives every control an accessible name", () => {
    openModal();
    expect(
      screen.getByRole("switch", { name: /show minimap/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: /text minimap width/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("spinbutton", { name: /stylized minimap width/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("slider", { name: /text minimap width/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("slider", { name: /stylized minimap width/i }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("exposes the two styles as named radio options", () => {
    openModal();
    expect(screen.getByRole("radio", { name: "Text" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Stylized" })).not.toBeChecked();
  });

  it("keeps an unsaved width edit when switching style and back", () => {
    openModal();
    fireEvent.click(screen.getByRole("radio", { name: "Stylized" }));
    const width = screen.getByRole("spinbutton", {
      name: /stylized minimap width/i,
    });
    fireEvent.change(width, { target: { value: "88" } });
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    fireEvent.click(screen.getByRole("radio", { name: "Stylized" }));
    expect(width).toHaveValue("88");
  });

  it("marks the default width and offers a reset action", () => {
    openModal();
    const width = screen.getByRole("spinbutton", {
      name: /text minimap width/i,
    });
    const reset = screen.getByRole("button", {
      name: /reset text minimap width to 120 pixels/i,
    });

    expect(screen.getByText("120 px")).toBeInTheDocument();
    expect(reset).toBeDisabled();

    fireEvent.change(width, { target: { value: "200" } });
    expect(reset).toBeEnabled();
    fireEvent.click(screen.getByText("120 px"));
    expect(width).toHaveValue("120");

    fireEvent.change(width, { target: { value: "200" } });
    fireEvent.click(reset);
    expect(width).toHaveValue("120");
    expect(reset).toBeDisabled();
  });

  it("persists a width edit for each style, not only the active one", () => {
    render(<Harness />);
    const open = () =>
      fireEvent.click(screen.getByRole("button", { name: "open" }));
    const width = (kind: "text" | "stylized") =>
      screen.getByRole("spinbutton", {
        name: new RegExp(`${kind} minimap width`, "i"),
      });

    open();
    // Edit each width while its style is selected.
    fireEvent.change(width("text"), { target: { value: "200" } });
    expect(width("text")).toHaveValue("200");
    fireEvent.click(screen.getByRole("radio", { name: "Stylized" }));
    expect(width("text")).toBeDisabled();
    expect(width("stylized")).toBeEnabled();
    fireEvent.change(width("stylized"), { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));

    expect(api.read().widths).toEqual({ text: 200, stylized: 88 });
    expect(api.read().kind).toBe("stylized");

    // reopening shows both saved values again
    open();
    expect(width("stylized")).toHaveValue("88");
    expect(width("text")).toHaveValue("200");
  });

  it("discards both width edits on Cancel", () => {
    openModal();
    const textWidth = screen.getByRole("spinbutton", {
      name: /text minimap width/i,
    });
    const stylizedWidth = screen.getByRole("spinbutton", {
      name: /stylized minimap width/i,
    });

    fireEvent.change(textWidth, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("radio", { name: "Stylized" }));
    fireEvent.change(stylizedWidth, { target: { value: "88" } });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: "open" }));

    expect(textWidth).toHaveValue("120");
    expect(stylizedWidth).toHaveValue("40");
  });

  it("only persists on Apply", () => {
    openModal();
    fireEvent.click(screen.getByRole("switch", { name: /show minimap/i }));
    expect(api.read().enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    expect(api.read().enabled).toBe(false);
  });
});
