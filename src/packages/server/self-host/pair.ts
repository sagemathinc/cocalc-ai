import getLogger from "@cocalc/backend/logger";
import {
  activateConnector,
  createConnector,
  revokePairingToken,
  verifyPairingToken,
} from "./connector-tokens";
import { getLaunchpadLocalConfig } from "../launchpad/mode";

const logger = getLogger("server:self-host:pair");

export type SelfHostPairResponse = {
  connector_id: string;
  connector_token: string;
  poll_interval_seconds: number;
  launchpad: ReturnType<typeof getLaunchpadLocalConfig>;
};

export async function pairSelfHostConnector(opts: {
  pairingToken: string;
  connectorInfo?: Record<string, any>;
}): Promise<SelfHostPairResponse> {
  const tokenInfo = await verifyPairingToken(opts.pairingToken);
  if (!tokenInfo) {
    throw new Error("invalid pairing token");
  }

  const connectorInfo = opts.connectorInfo ?? {};
  const name = connectorInfo?.name ? String(connectorInfo.name) : undefined;
  let connector_id: string;
  let token: string;
  if (tokenInfo.connector_id) {
    const activated = await activateConnector({
      connector_id: tokenInfo.connector_id,
      account_id: tokenInfo.account_id,
      name,
      metadata: connectorInfo,
    });
    connector_id = activated.connector_id;
    token = activated.token;
  } else {
    const created = await createConnector({
      account_id: tokenInfo.account_id,
      name,
      metadata: connectorInfo,
      host_id: tokenInfo.host_id ?? undefined,
    });
    connector_id = created.connector_id;
    token = created.token;
  }
  await revokePairingToken(tokenInfo.token_id);
  logger.debug("paired connector via token", {
    connector_id,
    host_id: tokenInfo.host_id,
  });
  return {
    connector_id,
    connector_token: token,
    poll_interval_seconds: 10,
    launchpad: getLaunchpadLocalConfig("local"),
  };
}
