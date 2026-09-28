/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space, Typography } from "antd";
import type { InputRef } from "antd";
import { useEffect, useId, useRef, useState } from "react";

import { useUsername } from "@cocalc/frontend/account/settings/use-username";
import { useUsernameSession } from "@cocalc/frontend/account/settings/username-session";
import type { UsernameSession } from "@cocalc/frontend/account/settings/username-session";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function AdminPersonalUrls({ account_id }: { account_id: string }) {
  const session = useUsernameSession();
  return (
    <PersonalUrls
      key={`${account_id}:${session.key}`}
      account_id={account_id}
      session={session}
    />
  );
}

function PersonalUrls({
  account_id,
  session,
}: {
  account_id: string;
  session: UsernameSession;
}) {
  const {
    info,
    setInfo,
    loading,
    error: loadError,
    reload,
    isCurrent,
  } = useUsername(session, account_id);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const [selected, setSelected] = useState<string>();
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const reasonInput = useRef<InputRef>(null);
  const errorDisplay = useRef<HTMLDivElement>(null);
  const focusAfterRequest = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pending = useRef(false);
  const id = useId();
  const redirects =
    info?.redirects.filter((name) => name !== info.username) ?? [];
  const canRelease =
    selected != null &&
    redirects.includes(selected) &&
    reason.trim().length > 0 &&
    confirmation === selected;

  useEffect(() => {
    if (!busy && selected != null && focusAfterRequest.current && isCurrent()) {
      focusAfterRequest.current = false;
      if (error) errorDisplay.current?.focus();
      else reasonInput.current?.focus();
    }
  }, [busy, error, selected]);

  async function release() {
    if (
      !canRelease ||
      pending.current ||
      loading ||
      selected == null ||
      !isCurrent()
    )
      return;
    const username = selected;
    const request = {
      owner_account_id: account_id,
      username,
      reason: reason.trim(),
    };
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        // Fresh auth can retry long after the confirmation was submitted.
        if (!isCurrent())
          throw Error("Account session changed; reopen the confirmation.");
        try {
          await session.client.hub.personalUrls.releaseRedirect(request);
        } catch (err) {
          if (!isCurrent())
            throw Error("Account session changed; reopen the confirmation.");
          throw err;
        }
      });
      if (!completed || !isCurrent()) return;
      setInfo((current) =>
        current == null
          ? current
          : {
              ...current,
              redirects: current.redirects.filter((name) => name !== username),
            },
      );
      setStatus(
        `Released redirect /u/${username}. The name is available for reuse.`,
      );
      setSelected(undefined);
      reload();
    } catch (err) {
      if (isCurrent()) setError(`${err}`);
    } finally {
      if (isCurrent()) {
        pending.current = false;
        focusAfterRequest.current = true;
        setBusy(false);
      }
    }
  }

  return (
    <section
      aria-labelledby={`${id}-heading`}
      style={{ overflowWrap: "anywhere" }}
    >
      <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
        Personal URLs
      </h3>
      <Typography.Paragraph>
        Usernames are optional; UUID links still work. Old names are reserved
        redirects. Only a redirect can be released here, never the current
        username.
      </Typography.Paragraph>
      {info != null && (
        <>
          <p>
            Current username:{" "}
            {info.username == null ? "Not set" : <code>{info.username}</code>}
          </p>
          <p>
            UUID fallback: <code>/u/{info.account_id}</code>
          </p>
          <h4>Reserved redirects</h4>
          {redirects.length === 0 ? (
            <p>No reserved redirects.</p>
          ) : (
            <ul>
              {redirects.map((name) => (
                <li key={name} style={{ marginBottom: 8 }}>
                  <Space wrap>
                    <code>/u/{name}</code>
                    <Button
                      danger
                      aria-label={`Release redirect /u/${name}`}
                      disabled={loading || busy || !!loadError}
                      onClick={(event) => {
                        if (!isCurrent()) return;
                        trigger.current = event.currentTarget;
                        setReason("");
                        setConfirmation("");
                        setError("");
                        setStatus("");
                        focusAfterRequest.current = false;
                        setSelected(name);
                      }}
                    >
                      Release redirect
                    </Button>
                  </Space>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {loadError && (
        <Alert
          type="error"
          title={`Could not load personal URLs: ${loadError}`}
        />
      )}
      <Button disabled={loading || busy} onClick={reload}>
        Refresh personal URLs
      </Button>
      <div role="status">{loading ? "Loading personal URLs..." : status}</div>
      <Modal
        open={selected != null}
        title={`Release redirect /u/${selected ?? ""}?`}
        styles={{
          header: { overflowWrap: "anywhere" },
          body: { overflowWrap: "anywhere" },
        }}
        okText="Release redirect"
        okButtonProps={{
          danger: true,
          disabled: !canRelease || busy || loading,
        }}
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: false }}
        focusable={{ focusTriggerAfterClose: false }}
        onOk={() => void release()}
        onCancel={() => {
          if (!pending.current) setSelected(undefined);
        }}
        afterOpenChange={(open) => {
          if (open && isCurrent()) reasonInput.current?.focus();
        }}
        afterClose={() => {
          if (!isCurrent()) return;
          if (
            trigger.current?.isConnected &&
            !trigger.current.hasAttribute("disabled")
          ) {
            trigger.current.focus();
          } else {
            heading.current?.focus();
          }
        }}
        modalRender={(modal) => (
          <KeyboardBoundary boundary="admin-release-redirect">
            {modal}
          </KeyboardBoundary>
        )}
      >
        <Space vertical style={{ width: "100%" }}>
          <Alert
            type="warning"
            title="Old URLs may identify a new owner after reuse."
            description={`Releasing /u/${selected ?? ""} removes its redirect to this account and lets someone else claim the name. Existing links using that name may then identify the new owner. This does not release the current username or change UUID links.`}
          />
          <p>
            Owner account: <code>{account_id}</code>
          </p>
          <label htmlFor={`${id}-reason`}>Reason for release (required)</label>
          <Input
            ref={reasonInput}
            id={`${id}-reason`}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            aria-required="true"
            aria-describedby={error ? `${id}-error` : undefined}
          />
          <label htmlFor={`${id}-confirmation`}>
            Type {selected} to confirm release
          </label>
          <Input
            id={`${id}-confirmation`}
            value={confirmation}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-required="true"
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {error && (
            <div ref={errorDisplay} tabIndex={-1}>
              <Alert id={`${id}-error`} type="error" title={error} />
            </div>
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </section>
  );
}
