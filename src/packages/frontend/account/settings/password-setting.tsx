/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Card, Flex, Form, Input, Space, Typography } from "antd";
import { join } from "path";
import { useIntl } from "react-intl";

import {
  Rendered,
  useIsMountedRef,
  useState,
} from "@cocalc/frontend/app-framework";
import {
  A,
  ErrorDisplay,
  LabeledRow,
  Saving,
} from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MIN_PASSWORD_LENGTH } from "@cocalc/util/auth";
import {
  isFreshAuthRequiredError,
  type FreshAuthActionRunner,
} from "@cocalc/frontend/auth/fresh-auth";

interface State {
  state: "view" | "edit" | "saving"; // view --> edit --> saving --> view
  old_password: string;
  new_password: string;
  error: string;
}

interface Props {
  runFreshAuthAction?: FreshAuthActionRunner;
  showLabel?: boolean;
}

export function PasswordSetting({
  runFreshAuthAction,
  showLabel = true,
}: Props) {
  const intl = useIntl();
  const is_mounted = useIsMountedRef();

  const [state, set_state] = useState<State["state"]>("view");
  const [old_password, set_old_password] = useState("");
  const [new_password, set_new_password] = useState("");
  const [error, set_error] = useState("");

  function reset(): void {
    set_state("view");
    set_error("");
    set_old_password("");
    set_new_password("");
  }

  function change_password(): void {
    reset();
    set_state("edit");
  }

  function cancel_editing(): void {
    set_state("view");
    set_old_password("");
    set_new_password("");
  }

  async function runSecurityAction(action: () => Promise<void>) {
    if (runFreshAuthAction != null) {
      return await runFreshAuthAction(action);
    }
    await action();
    return true;
  }

  async function performSaveNewPassword(): Promise<void> {
    set_state("saving");
    try {
      await webapp_client.account_client.change_password(
        old_password,
        new_password,
      );
      if (!is_mounted.current) return;
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        if (!is_mounted.current) return;
        set_state("edit");
        throw err;
      }
      if (!is_mounted.current) return;
      set_state("edit");
      set_error(`Error changing password -- ${err}`);
      return;
    }
    reset();
  }

  async function save_new_password(): Promise<void> {
    await runSecurityAction(performSaveNewPassword);
  }

  function is_submittable(): boolean {
    return !!(
      new_password.length >= MIN_PASSWORD_LENGTH &&
      new_password &&
      new_password !== old_password
    );
  }

  function render_change_button(): Rendered {
    if (is_submittable()) {
      return (
        <Button onClick={save_new_password} type="primary">
          {intl.formatMessage(labels.account_password_change)}
        </Button>
      );
    } else {
      return (
        <Button disabled type="primary">
          {intl.formatMessage(labels.account_password_change)}
        </Button>
      );
    }
  }

  function render_error(): Rendered {
    if (error) {
      return (
        <>
          <ErrorDisplay
            error={error}
            onClose={() => set_error("")}
            style={{ marginTop: "15px" }}
          />
          <A href={join(appBasePath, "auth/password-reset")}>
            {intl.formatMessage(labels.account_password_forgot)}
          </A>
        </>
      );
    }
  }

  function onFinish(): void {
    if (is_submittable()) {
      save_new_password();
    }
  }

  function render_edit(): Rendered {
    const passwordHint =
      new_password.length < MIN_PASSWORD_LENGTH
        ? `at least ${MIN_PASSWORD_LENGTH} characters`
        : new_password.length >= 6 && new_password == old_password
          ? "different than old password"
          : undefined;

    return (
      <Card size="small">
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item
            label={
              <>
                Current password{" "}
                <Typography.Text type="secondary">
                  (leave blank if you have not set a password)
                </Typography.Text>
              </>
            }
          >
            <Input.Password
              autoFocus
              type="password"
              value={old_password}
              placeholder="Current password"
              onChange={(e) => set_old_password(e.target.value)}
            />
          </Form.Item>
          <Form.Item
            label={
              <>
                New password{" "}
                {passwordHint ? (
                  <Typography.Text type="secondary">
                    ({passwordHint})
                  </Typography.Text>
                ) : undefined}
              </>
            }
          >
            <Input.Password
              type="password"
              value={new_password}
              placeholder="New password"
              onChange={(e) => {
                set_new_password(e.target.value);
              }}
            />
          </Form.Item>
        </Form>
        <Space>
          {render_change_button()}
          <Button onClick={cancel_editing}>Cancel</Button>
        </Space>
        {render_error()}
        {render_saving()}
      </Card>
    );
  }

  function render_saving(): Rendered {
    if (state === "saving") {
      return <Saving />;
    }
  }

  if (!showLabel) {
    return (
      <Flex vertical gap="middle">
        {state === "view" ? (
          <Button onClick={change_password}>
            {intl.formatMessage(labels.account_password_change)}...
          </Button>
        ) : undefined}
        {state !== "view" ? render_edit() : undefined}
      </Flex>
    );
  }

  return (
    <LabeledRow
      label={intl.formatMessage(labels.account_password)}
      style={{ marginBottom: "15px" }}
    >
      <div
        style={{ height: "30px", display: "flex", justifyContent: "flex-end" }}
      >
        <Button disabled={state !== "view"} onClick={change_password}>
          {intl.formatMessage(labels.account_password_change)}...
        </Button>
      </div>
      {state !== "view" ? render_edit() : undefined}
    </LabeledRow>
  );
}
