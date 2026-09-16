/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useMemo, useState } from "react";
import { Alert, Button, Form, InputNumber, Select, Typography } from "antd";
import { defineMessages, FormattedMessage, useIntl } from "react-intl";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Panel } from "@cocalc/frontend/antd-bootstrap";
import { Icon } from "@cocalc/frontend/components/icon";
import { IS_MACOS } from "@cocalc/frontend/feature";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { createTapDetector } from "./detector";
import { navigationPreferences, SHORTCUTS } from "./preferences";

import { OPEN_NAVIGATION_EVENT } from "./events";

export const NAVIGATION_CONTROL_LABELS = defineMessages({
  title: { id: "quick-nav.title", defaultMessage: "Quick Navigation" },
  shortcut: {
    id: "quick-nav.shortcut",
    defaultMessage: "Quick Navigation shortcut",
  },
  delay: {
    id: "quick-nav.delay",
    defaultMessage: "Double-tap interval (milliseconds)",
  },
  test: {
    id: "quick-nav.test",
    defaultMessage: "Focus here and double-tap Shift to test",
  },
});

export function NavigationConfiguration() {
  const intl = useIntl();
  const id = useId();
  const settings = useTypedRedux("account", "other_settings");
  const stored = navigationPreferences(settings);
  const [shortcut, setShortcut] = useState(stored.shortcut);
  const [delay, setDelay] = useState(stored.delay);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [detected, setDetected] = useState(false);
  useEffect(() => {
    setShortcut(stored.shortcut);
    setDelay(stored.delay);
  }, [stored.shortcut, stored.delay]);
  const tester = useMemo(
    () => createTapDetector(delay, () => setDetected(true)),
    [delay],
  );
  function resetTest() {
    tester.reset();
    setDetected(false);
  }
  async function save(key: string, value: string | number) {
    setSaving(true);
    setError("");
    try {
      await redux
        .getActions("account")
        .set_other_settings_many_and_wait({ [key]: value });
    } catch (err) {
      setError(`${err}`);
      setShortcut(stored.shortcut);
      setDelay(stored.delay);
    } finally {
      setSaving(false);
    }
  }
  const mod = IS_MACOS ? "Cmd" : "Ctrl";
  return (
    <KeyboardBoundary
      data-quick-navigation-config="true"
      boundary="quick-navigation-config"
    >
      <Form layout="vertical" component="div">
        <Form.Item
          extra={
            shortcut === "ctrl+k" ? (
              <FormattedMessage
                id="quick-nav.shortcut-editor-conflict"
                defaultMessage="{mod}+K takes precedence over editor keymaps that use it, such as Emacs kill-line and Sublime chords."
                values={{ mod }}
              />
            ) : undefined
          }
          htmlFor={`${id}-shortcut`}
          label={<FormattedMessage {...NAVIGATION_CONTROL_LABELS.shortcut} />}
        >
          <Select
            id={`${id}-shortcut`}
            value={shortcut}
            disabled={saving}
            style={{ width: "100%", maxWidth: 360 }}
            options={SHORTCUTS.map((value) => ({
              value,
              label:
                value === "shift+shift"
                  ? "Shift, Shift"
                  : value === "disabled"
                    ? intl.formatMessage({
                        id: "quick-nav.disabled",
                        defaultMessage: "Disabled",
                      })
                    : value === "ctrl+k"
                      ? `${mod}+K`
                      : `${mod}+Shift+Space`,
            }))}
            onChange={(value) => {
              setShortcut(value);
              void save("quick_navigation_shortcut", value);
            }}
          />
        </Form.Item>
        {shortcut === "shift+shift" && (
          <>
            <Form.Item
              htmlFor={`${id}-delay`}
              label={<FormattedMessage {...NAVIGATION_CONTROL_LABELS.delay} />}
            >
              <InputNumber
                id={`${id}-delay`}
                min={150}
                max={1000}
                step={50}
                value={delay}
                disabled={saving}
                onChange={(value) => {
                  if (value != null) setDelay(value);
                }}
                onBlur={() => {
                  const value = Math.max(150, Math.min(1000, delay));
                  setDelay(value);
                  if (value !== stored.delay)
                    void save("quick_navigation_delay", value);
                }}
              />
            </Form.Item>
            <Button
              style={{ height: "auto", whiteSpace: "normal" }}
              onClick={resetTest}
              onFocus={resetTest}
              onBlur={tester.reset}
              onKeyDown={(event) => tester.event(event.nativeEvent)}
              onKeyUp={(event) => tester.event(event.nativeEvent)}
            >
              <FormattedMessage {...NAVIGATION_CONTROL_LABELS.test} />
            </Button>
            <Typography.Text
              role="status"
              type="secondary"
              style={{ display: "block", minHeight: "1.5em", marginTop: 8 }}
            >
              {detected
                ? intl.formatMessage({
                    id: "quick-nav.detected",
                    defaultMessage: "Double tap detected.",
                  })
                : ""}
            </Typography.Text>
          </>
        )}
        {error && <Alert type="error" showIcon message={error} />}
      </Form>
    </KeyboardBoundary>
  );
}

export function NavigationPreferences() {
  return (
    <Panel
      header={
        <>
          <Icon name="bolt" />{" "}
          <FormattedMessage {...NAVIGATION_CONTROL_LABELS.title} />
        </>
      }
    >
      <NavigationConfiguration />
      <Button
        style={{ marginTop: 12 }}
        icon={<Icon name="bolt" />}
        onClick={() => window.dispatchEvent(new Event(OPEN_NAVIGATION_EVENT))}
      >
        <FormattedMessage
          id="quick-nav.open"
          defaultMessage="Open Quick Navigation"
        />
      </Button>
    </Panel>
  );
}
