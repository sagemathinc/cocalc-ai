/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Input, Space, Typography } from "antd";
import type { InputRef } from "antd";
import { useEffect, useId, useRef, useState } from "react";

import { dispatchUsernameChanged } from "../username-events";
import { useUsername } from "./use-username";
import { useUsernameSession } from "./username-session";
import type { UsernameSession } from "./username-session";

export function UsernameSetting() {
  const session = useUsernameSession();
  return <UsernameEditor key={session.key} session={session} />;
}

function UsernameEditor({ session }: { session: UsernameSession }) {
  const {
    info,
    setInfo,
    loading,
    error: loadError,
    reload,
    isCurrent,
  } = useUsername(session);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const input = useRef<InputRef>(null);
  const focusAfterRequest = useRef(false);
  const pending = useRef(false);
  const id = useId();
  const username = value.trim() || null;
  const changed = info != null && username !== info.username;

  useEffect(() => {
    if (info != null) setValue(info.username ?? "");
  }, [info]);

  useEffect(() => {
    if (
      !loading &&
      !saving &&
      info != null &&
      focusAfterRequest.current &&
      isCurrent()
    ) {
      focusAfterRequest.current = false;
      input.current?.focus();
    }
  }, [info, loading, saving]);

  async function save() {
    if (!changed || loading || pending.current || !isCurrent()) return;
    pending.current = true;
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const next = await session.client.hub.personalUrls.setUsername({
        username,
      });
      if (!isCurrent()) return;
      if (next.account_id !== session.accountId) {
        throw Error("Username response belongs to a different account.");
      }
      setInfo(next);
      setStatus(
        next.username == null
          ? "Username removed. Your UUID link still works and old names remain reserved redirects."
          : "Username saved. Old names remain reserved redirects.",
      );
      dispatchUsernameChanged(next);
    } catch (err) {
      if (isCurrent()) setError(`${err}`);
    } finally {
      if (isCurrent()) {
        pending.current = false;
        focusAfterRequest.current = true;
        setSaving(false);
      }
    }
  }

  return (
    <section
      aria-label="Personal URL"
      style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Space vertical style={{ width: "100%" }}>
          <label htmlFor={id}>Username (optional)</label>
          <Typography.Paragraph id={`${id}-help`}>
            Choose a username for readable personal links such as{" "}
            <code>/u/name</code>. This is optional: your account UUID link works
            without a username. Changing or removing your username keeps old
            names reserved as redirects to you; it does not make them available
            to other people. Leave this field blank to use your UUID link.
          </Typography.Paragraph>
          <Input
            id={id}
            ref={input}
            value={value}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            disabled={loading || saving || info == null}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            aria-invalid={!!error}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
              setStatus("");
            }}
          />
          {info != null && (
            <div style={{ overflowWrap: "anywhere" }}>
              Personal URL prefix:{" "}
              <code>/u/{info.username ?? info.account_id}</code>
              <br />
              UUID fallback: <code>/u/{info.account_id}</code>
              {info.redirects.length > 0 && (
                <>
                  <div>Reserved redirects:</div>
                  <ul>
                    {info.redirects.map((name) => (
                      <li key={name}>
                        <code>/u/{name}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {loadError && (
            <>
              <Alert
                type="error"
                title={`Could not load username: ${loadError}`}
              />
              <Button
                disabled={loading}
                onClick={() => {
                  focusAfterRequest.current = true;
                  reload();
                }}
              >
                Retry loading username
              </Button>
            </>
          )}
          {error && <Alert id={`${id}-error`} type="error" title={error} />}
          <Space wrap>
            <Button
              htmlType="submit"
              type="primary"
              loading={saving}
              disabled={!changed || loading || saving}
            >
              Save username
            </Button>
            <Button
              disabled={!changed || loading || saving}
              onClick={() => {
                if (!isCurrent()) return;
                setValue(info?.username ?? "");
                setError("");
                setStatus("");
                input.current?.focus();
              }}
            >
              Reset username
            </Button>
          </Space>
          <div role="status">
            {loading
              ? "Loading username..."
              : saving
                ? "Saving username..."
                : status}
          </div>
        </Space>
      </form>
    </section>
  );
}
