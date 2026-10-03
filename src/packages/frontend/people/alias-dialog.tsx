/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { Alert, Form, Input, Modal } from "antd";
import { PublicAliasInfo } from "@cocalc/frontend/components/public-alias-info";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import CopyToClipBoard from "@cocalc/frontend/components/copy-to-clipboard";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  personalUrlPath,
  type PersonalUrlKind,
} from "@cocalc/util/personal-urls";

// The saved alias as a /u/<username or account id>/<kind>/<alias> link.
function PersonalLink({
  kind,
  alias,
}: {
  kind: PersonalUrlKind;
  alias: string;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    let canceled = false;
    webapp_client.conat_client.hub.personalUrls
      .getUsername({})
      .then((r) => !canceled && setUsername(r.username))
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, []);
  if (!account_id) return null;
  let path: string;
  try {
    path = personalUrlPath(username ?? account_id, kind, alias);
  } catch {
    return null;
  }
  const base = appBasePath === "/" ? "" : appBasePath;
  return (
    <Form.Item
      label="Personal link"
      extra={
        kind === "people"
          ? "Only you can open this link."
          : `Opens for anyone who already has access to the ${kind === "projects" ? "project" : "project it is in"}.`
      }
    >
      <CopyToClipBoard value={`${location.origin}${base}${path}`} />
    </Form.Item>
  );
}

// Edit an @alias. Saving an empty value clears it.
export function AliasDialog({
  open,
  title,
  alias,
  urlKind,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  alias?: string | null;
  urlKind?: PersonalUrlKind;
  onSave: (alias: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(alias ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(alias ?? "");
      setError("");
    }
  }, [open, alias]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(value);
      onClose();
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      title={`Personal alias for ${title}`}
      okText="Save"
      confirmLoading={busy}
      onOk={save}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form layout="vertical" onFinish={save}>
        <Form.Item
          label={
            urlKind && urlKind !== "people" ? (
              <span>
                Alias <PublicAliasInfo kind={urlKind} />
              </span>
            ) : (
              "Alias"
            )
          }
          htmlFor="people-alias-input"
          extra={
            urlKind && urlKind !== "people"
              ? "A public name in your personal link, e.g. @team. Leave empty to remove."
              : "Only you see this alias. Use it to find this quickly, e.g. @team. Leave empty to remove."
          }
        >
          <Input
            id="people-alias-input"
            prefix="@"
            autoFocus
            maxLength={64}
            value={value.replace(/^@/, "")}
            onChange={(e) => setValue(e.target.value)}
          />
        </Form.Item>
        {urlKind && alias && value.replace(/^@/, "") === alias && (
          <PersonalLink kind={urlKind} alias={alias} />
        )}
        {error && <Alert role="alert" type="error" title={error} />}
      </Form>
    </Modal>
  );
}
