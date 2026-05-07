/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Card } from "antd";
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
  first_name: string;
  last_name: string;
}

export function Impersonate({ first_name, last_name, account_id }: Props) {
  const [impersonationUrl, setImpersonationUrl] = useState<string | null>(null);
  const [err, set_err] = useState<string | null>(null);
  const [extraWarning, setExtraWarning] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const { locale } = useLocalizationCtx();
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction({
    onUnhandledError: (err) => set_err(`${err}`),
  });

  async function generate_link(): Promise<void> {
    setLoading(true);
    try {
      await runFreshAuthAction(async () => {
        const result =
          await webapp_client.admin_client.create_impersonation_grant({
            subject_account_id: account_id,
            reason: "admin-ui",
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
          <Button type="primary" onClick={() => void generate_link()}>
            Generate impersonation link
          </Button>
          <div style={{ marginTop: "15px", color: "#666" }}>
            This requires recent admin password verification and 2FA.
          </div>
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
            href={link}
            onClick={handleClick}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="external-link" /> Right click and open this link in a
            new <b>Incognito Window</b>, where you will be signed in as "
            {first_name} {last_name}"...
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
        <div>
          <b>ERROR</b> {err}
        </div>
      );
    }
  }

  return (
    <Card
      title={
        <>
          Impersonate user "{first_name} {last_name}"
        </>
      }
    >
      {render_err()}
      {render_link()}
      <FreshAuthModal {...freshAuthModalProps} />
    </Card>
  );
}
