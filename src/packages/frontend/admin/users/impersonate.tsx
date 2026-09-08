/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card, Input, Typography } from "antd";
import { useEffect, useId, useRef } from "react";
import { impersonationReason } from "@cocalc/util/impersonation-audit";
import { join } from "path";

import { Rendered, useState } from "@cocalc/frontend/app-framework";
import { Icon, Loading } from "@cocalc/frontend/components";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { CopyToClipBoard } from "@cocalc/frontend/components";
import { useLocalizationCtx } from "@cocalc/frontend/app/localize";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";

interface Props {
  account_id: string;
  display_name: string;
  embedded?: boolean;
}

export function Impersonate({ display_name, account_id, embedded }: Props) {
  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);
  const [err, set_err] = useState<string | null>(null);
  const [extraWarning, setExtraWarning] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const linkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (impersonationUrl && !loading) linkRef.current?.focus();
  }, [impersonationUrl, loading]);
  const { locale } = useLocalizationCtx();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function generate_link(): Promise<void> {
    let auditReason: string;
    try {
      auditReason = impersonationReason(reason);
    } catch (error) {
      set_err(`${error}`);
      return;
    }
    setLoading(true);
    try {
      await runFreshAuthAction(async () => {
        const result =
          await webapp_client.admin_client.create_impersonation_grant({
            subject_account_id: account_id,
            reason: auditReason,
            lang_temp: locale,
          });
        setImpersonationUrl(result.url);
        set_err(null);
      });
    } catch (err) {
      set_err(`${err}`);
      setImpersonationUrl(null);
    } finally {
      setLoading(false);
    }
  }

  function render_link(): Rendered {
    if (loading) {
      return <Loading />;
    }
    if (impersonationUrl == null) {
      return (
        <div style={{ textAlign: "center" }}>
          <div style={{ textAlign: "left", marginBottom: 16 }}>
            <label htmlFor={reasonId}>
              Reason and authorization for impersonation (required)
            </label>
            <Input.TextArea
              id={reasonId}
              aria-describedby={`${reasonId}-help`}
              required
              maxLength={512}
              autoSize={{ minRows: 3, maxRows: 8 }}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Describe the investigation, ticket link, and where the user's consent was recorded, or another authorized operational reason."
            />
            <Typography.Paragraph id={`${reasonId}-help`} type="secondary">
              This explanation is retained with the impersonation audit record.
              Only inspect content within the authorized scope. A reason or
              ticket link alone is not user consent.
            </Typography.Paragraph>
          </div>
          <Button
            disabled={!reason.trim()}
            type="primary"
            onClick={() => void generate_link()}
          >
            Generate impersonation link
          </Button>
          <Typography.Paragraph type="secondary" style={{ marginTop: "15px" }}>
            This requires recent admin password verification and 2FA.
          </Typography.Paragraph>
        </div>
      );
    }

    const link = impersonationUrl.startsWith("http")
      ? impersonationUrl
      : join(appBasePath, impersonationUrl);

    const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault(); // Prevent left click from opening the link
      setExtraWarning(true);
    };

    return (
      <div>
        <div style={{ fontSize: "13pt", textAlign: "center" }}>
          <a
            ref={linkRef}
            href={link}
            onClick={handleClick}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external-link" /> Right click and open this link in a
            new <b>Incognito Window</b>, where you will be signed in as "
            {display_name}"...
          </a>
          <br />
          <br />
          or copy the following link and paste it in a different browser:
          <br />
          <br />
          <CopyToClipBoard
            inputWidth="500px"
            value={link.startsWith("http") ? link : `${location.origin}${link}`}
          />
        </div>
        {extraWarning && (
          <Alert
            showIcon
            style={{ margin: "30px auto", maxWidth: "800px" }}
            type="warning"
            title="Open this link in a new Incognito Window!"
            description="Otherwise your current browser session will get overwritten, and potentially sensitive information could leak."
          />
        )}
      </div>
    );
  }

  function render_err(): Rendered {
    if (err != null) {
      return (
        <div role="alert">
          <b>ERROR</b> {err}
        </div>
      );
    }
  }

  const content = (
    <>
      {render_err()}
      {render_link()}
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
  return embedded ? (
    content
  ) : (
    <Card title={<>Impersonate user "{display_name}"</>}>{content}</Card>
  );
}
