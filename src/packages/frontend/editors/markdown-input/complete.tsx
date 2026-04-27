/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
I started with a copy of jupyter/complete.tsx, and will rewrite it
to be much more generically usable here, then hopefully use this
for Jupyter, code editors, (etc.'s) complete.  E.g., I already
rewrote this to use the Antd dropdown, which is more dynamic.
*/

import type { MenuProps } from "antd";
import { Dropdown } from "antd";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { CSS } from "@cocalc/frontend/app-framework";
import ReactDOM from "react-dom";
import type { MenuItems } from "@cocalc/frontend/components";
import { strictMod } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

export interface Item {
  label?: ReactNode;
  value: string;
  search?: string; // useful for clients
}
interface Props0 {
  items: Item[]; // we assume at least one item
  onSelect: (value: string) => void;
  onCancel: () => void;
}

interface Props1 extends Props0 {
  offset: { left: number; top: number }; // offset relative to wherever you placed this in DOM
  position?: undefined;
}

interface Props2 extends Props0 {
  offset?: undefined;
  position: { left: number; top: number }; // or absolute position (doesn't matter where you put this in DOM).
}

type Props = Props1 | Props2;

// WARNING: Complete closing when clicking outside the complete box
// is handled in cell-list on_click.  This is ugly code (since not localized),
// but seems to work well for now.  Could move.
export function Complete({
  items,
  onSelect,
  onCancel,
  offset,
  position,
}: Props) {
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const selected_key_ref = useRef<string | undefined>(undefined);

  useEffect(() => {
    const maxIndex = Math.max(items.length - 1, 0);
    if (selectedIndex > maxIndex) {
      setSelectedIndex(maxIndex);
    }
  }, [items.length, selectedIndex]);

  const select = useCallback(
    (e?) => {
      const key = e?.key ?? selected_key_ref.current;
      if (typeof key === "string") {
        onSelect(key);
      } else {
        onCancel();
      }
    },
    [onSelect, onCancel],
  );

  const onKeyDown = useCallback(
    (e) => {
      switch (e.keyCode) {
        case 27: // escape key
          onCancel();
          break;

        case 13: // enter key
          select();
          break;

        case 38: // up arrow key
          setSelectedIndex((n) => n - 1);
          // @ts-ignore
          $(".ant-dropdown-menu-item-selected").scrollintoview();
          break;

        case 40: // down arrow
          setSelectedIndex((n) => n + 1);
          // @ts-ignore
          $(".ant-dropdown-menu-item-selected").scrollintoview();
          break;
      }
    },
    [onCancel, onSelect],
  );

  useEffect(() => {
    // for clicks, we only listen on the root of the app – otherwise clicks on
    // e.g. the menu items and the sub-menu always trigger a close action
    // (that popup menu is outside the root in the DOM)
    const root = document.getElementById("cocalc-webapp-container");
    document.addEventListener("keydown", onKeyDown);
    root?.addEventListener("click", onCancel);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      root?.removeEventListener("click", onCancel);
    };
  }, [onKeyDown, onCancel]);

  selected_key_ref.current =
    items.length > 0
      ? items[strictMod(selectedIndex, items.length)]?.value
      : undefined;

  const style: CSS = { fontSize: "115%" } as const;

  const menuItems: MenuItems = items.map(({ label, value }) => ({
    key: value,
    label: label ?? value,
    style,
  }));

  if (menuItems.length == 0) {
    menuItems.push({ key: "nothing", label: "No items found", disabled: true });
  }

  const menu: MenuProps = {
    selectedKeys:
      selected_key_ref.current == null ? [] : [selected_key_ref.current],
    onClick: (e) => {
      if (e.key !== "nothing") {
        select(e);
      }
    },
    items: menuItems,
    mode: "vertical",
    style: {
      border: `1px solid ${COLORS.GRAY_L}`,
      maxHeight: "45vh", // so can always position menu above/below current line not obscuring it.
      overflow: "auto",
    },
  };

  function renderDropdown(): React.JSX.Element {
    return (
      <Dropdown
        menu={menu}
        open
        trigger={["click", "hover"]}
        placement="top" // always on top, and paddingBottom makes the entire line visible
        styles={{ root: { paddingBottom: "1em" } }}
      >
        <span />
      </Dropdown>
    );
  }

  if (offset != null) {
    // Relative positioning of the popup (this is in the same React tree).
    return (
      <div style={{ position: "relative" }}>
        <div style={{ ...offset, position: "absolute" }}>
          {renderDropdown()}
        </div>
      </div>
    );
  } else if (position != null) {
    // Absolute position of the popup (this uses a totally different React tree)
    return (
      <Portal>
        <div style={{ ...STYLE, ...position }}>{renderDropdown()}</div>
      </Portal>
    );
  } else {
    throw Error("bug -- not possible");
  }
}

const Portal = ({ children }) => {
  return ReactDOM.createPortal(children, document.body);
};

const STYLE: CSS = {
  top: "-9999px",
  left: "-9999px",
  position: "absolute",
  zIndex: 1,
  padding: "3px",
  background: "white",
  borderRadius: "4px",
  boxShadow: "0 1px 5px rgba(0,0,0,.2)",
  overflowY: "auto",
  maxHeight: "50vh",
} as const;
