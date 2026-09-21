import { Alert, Button, Drawer, Spin } from "antd";
import { lazy, Suspense, useEffect, useState } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { ensureNotificationsInitialized } from "./ensure-init";
import { setNotificationsOpen, useNotificationsOpen } from "./drawer-state";

const WIDTH_KEY = "cocalc-notifications-drawer-width";
const NotificationPage = lazy(async () => ({
  default: (await import("./notification-page")).NotificationPage,
}));
export function NotificationsDrawer() {
  const open = useNotificationsOpen();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [width, setWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(WIDTH_KEY)) || 640;
    } catch {
      return 640;
    }
  });
  function resize(value: number) {
    const next = Math.max(280, Math.min(value, window.innerWidth));
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {}
  }
  useEffect(() => {
    if (!open) return;
    void ensureNotificationsInitialized().then(
      () => setReady(true),
      (err) => setError(String(err)),
    );
  }, [open]);
  return (
    <Drawer
      open={open}
      title="Notifications"
      placement="right"
      size={width}
      resizable={{ onResize: resize }}
      onClose={() => setNotificationsOpen(false)}
      extra={
        <Button onClick={() => resize(width === 640 ? 400 : 640)}>
          Resize
        </Button>
      }
      styles={{ body: { display: "flex", padding: 12, minWidth: 0 } }}
    >
      <KeyboardBoundary
        style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0 }}
      >
        {error ? (
          <Alert type="error" title={error} />
        ) : ready ? (
          <Suspense fallback={<Spin />}>
            <NotificationPage embedded />
          </Suspense>
        ) : (
          <Spin />
        )}
      </KeyboardBoundary>
    </Drawer>
  );
}
