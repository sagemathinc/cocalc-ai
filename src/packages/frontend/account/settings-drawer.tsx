import { lazy, Suspense, useState } from "react";
import { Button, Drawer, Spin } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  setSettingsDrawerOpen,
  useSettingsDrawerOpen,
} from "./settings-drawer-state";

const Content = lazy(() => import("./settings-drawer-content"));
const WIDTH_KEY = "cocalc-account-settings-drawer-width";
export function SettingsDrawer() {
  const open = useSettingsDrawerOpen();
  const account = useTypedRedux("account", "account_id");
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || 800;
    } catch {
      return 800;
    }
  });
  function resize(value: number) {
    const next = Math.max(280, Math.min(value, window.innerWidth));
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {}
  }
  return (
    <Drawer
      title="Account settings"
      open={open && !!account}
      placement="right"
      size={width}
      resizable={{ onResize: resize }}
      destroyOnHidden
      onClose={() => setSettingsDrawerOpen(false)}
      extra={
        <Button onClick={() => resize(width === 800 ? 480 : 800)}>
          Resize
        </Button>
      }
      styles={{ body: { padding: 16, display: "flex", minWidth: 0 } }}
    >
      <KeyboardBoundary
        style={{
          minWidth: 0,
          width: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {open && (
          <Suspense fallback={<Spin />}>
            <Content />
          </Suspense>
        )}
      </KeyboardBoundary>
    </Drawer>
  );
}
