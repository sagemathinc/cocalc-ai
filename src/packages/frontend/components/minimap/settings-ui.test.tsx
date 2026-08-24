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
      screen.getByRole("spinbutton", { name: /minimap width/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("slider", { name: /minimap width/i }),
    ).toBeInTheDocument();
  });

  it("exposes the two styles as named radio options", () => {
    openModal();
    expect(screen.getByRole("radio", { name: "Text" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Stylized" })).not.toBeChecked();
  });

  it("keeps an unsaved width edit when switching style and back", () => {
    openModal();
    fireEvent.click(screen.getByRole("radio", { name: "Stylized" }));
    const width = screen.getByRole("spinbutton", { name: /minimap width/i });
    fireEvent.change(width, { target: { value: "88" } });
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    fireEvent.click(screen.getByRole("radio", { name: "Stylized" }));
    expect(width).toHaveValue("88");
  });

  it("only persists on Apply", () => {
    openModal();
    fireEvent.click(screen.getByRole("switch", { name: /show minimap/i }));
    expect(api.read().enabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    expect(api.read().enabled).toBe(false);
  });
});
