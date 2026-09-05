/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider, theme } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { Button, Panel, Well } from "./antd-bootstrap";

test.each([theme.defaultAlgorithm, theme.darkAlgorithm])(
  "legacy panels and buttons use owned semantic colors and keep focus",
  (algorithm) => {
    const click = jest.fn();
    const { container } = render(
      <ConfigProvider theme={{ algorithm }}>
        <Panel header="Settings">
          <span>Panel content</span>
        </Panel>
        <Well>Well content</Well>
        <Button bsStyle="warning" onClick={click}>
          Retry
        </Button>
      </ConfigProvider>,
    );
    const header = container.querySelector<HTMLElement>(".ant-card-head")!;
    expect(header.style.backgroundColor).toBe(UI_COLORS.inset);
    expect(header.style.color).toBe(UI_COLORS.text);
    const button = screen.getByRole("button", { name: "Retry" });
    expect(button.style.backgroundColor).toBe(UI_COLORS.warningBg);
    expect(button.style.color).toBe(UI_COLORS.warning);
    button.focus();
    fireEvent.click(button);
    expect(click).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
  },
);
