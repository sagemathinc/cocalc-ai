/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal, Select } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import { Button, Col, Row } from "@cocalc/frontend/antd-bootstrap";
import {
  React,
  useActions,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { labels } from "@cocalc/frontend/i18n";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ConnectionTargetSnapshot } from "@cocalc/frontend/conat/client";
import { ConnectionStatsDisplay } from "./connection-status";

export const ConnectionInfo: React.FC = React.memo(() => {
  const intl = useIntl();

  const ping = useTypedRedux("page", "ping");
  const avgping = useTypedRedux("page", "avgping");
  const status = useTypedRedux("page", "connection_status");
  const conat = useTypedRedux("page", "conat");
  const page_actions = useActions("page");
  const [targets, setTargets] = React.useState<ConnectionTargetSnapshot[]>([]);
  const [selectedTargetId, setSelectedTargetId] = React.useState("hub");
  const [selectedTargetPing, setSelectedTargetPing] = React.useState<
    number | undefined
  >();

  React.useEffect(() => {
    const refresh = () => {
      setTargets(webapp_client.conat_client.getConnectionTargets());
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, []);

  React.useEffect(() => {
    if (targets.some((target) => target.id === selectedTargetId)) {
      return;
    }
    setSelectedTargetId("hub");
  }, [selectedTargetId, targets]);

  const selectedTarget = React.useMemo(() => {
    return (
      targets.find((target) => target.id === selectedTargetId) ??
      targets.find((target) => target.id === "hub")
    );
  }, [selectedTargetId, targets]);

  const selectedStatus = React.useMemo(() => {
    if (selectedTarget?.id === "hub" && conat != null) {
      return conat.toJS();
    }
    return selectedTarget?.status;
  }, [conat, selectedTarget]);

  React.useEffect(() => {
    const targetId = selectedTarget?.id;
    const targetState = selectedTarget?.status.state;
    if (!targetId || targetId === "hub") {
      setSelectedTargetPing(undefined);
      return;
    }
    if (targetState !== "connected") {
      setSelectedTargetPing(undefined);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      try {
        const nextPing =
          await webapp_client.conat_client.probeConnectionTarget(targetId);
        if (!cancelled) {
          setSelectedTargetPing(nextPing);
        }
      } catch {
        if (!cancelled) {
          setSelectedTargetPing(undefined);
        }
      }
    };
    void probe();
    const interval = setInterval(() => {
      void probe();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedTarget?.id, selectedTarget?.status.state]);

  const targetSelector = React.useMemo(() => {
    if (targets.length <= 1) {
      return selectedTarget?.label ?? "hub";
    }
    return (
      <Select
        size="small"
        value={selectedTargetId}
        style={{ minWidth: 220 }}
        onChange={setSelectedTargetId}
        options={targets.map((target) => ({
          value: target.id,
          label: target.label,
        }))}
      />
    );
  }, [selectedTarget, selectedTargetId, targets]);

  function close() {
    page_actions.show_connection(false);
  }

  return (
    <Modal
      width={700}
      open
      onCancel={close}
      onOk={close}
      title={
        <div
          style={{ display: "flex", alignItems: "center", marginRight: "30px" }}
        >
          <Icon name="wifi" style={{ marginRight: "1em" }} />{" "}
          {intl.formatMessage(labels.connection)}
          <div style={{ flex: 1 }} />
          <Button
            onClick={() => {
              webapp_client.conat_client.reconnect();
            }}
          >
            <Icon name="repeat" spin={status === "connecting"} />{" "}
            {intl.formatMessage(labels.reconnect)}
          </Button>
        </div>
      }
    >
      <div>
        {selectedTarget != null && selectedStatus != null && (
          <Row>
            <Col sm={12}>
              <ConnectionStatsDisplay
                status={selectedStatus}
                targetLabel={targetSelector}
                address={selectedTarget.address}
              />
            </Col>
          </Row>
        )}
        {(selectedTarget?.id === "hub" ? ping : selectedTargetPing) != null ? (
          <Row style={{ marginTop: "30px" }}>
            <Col sm={3}>
              <h5>
                <FormattedMessage
                  id="connection-info.ping"
                  defaultMessage="Ping Time"
                  description={"Ping how long a server takes to respond"}
                />
              </h5>
            </Col>
            <Col sm={7}>
              <pre>
                {selectedTarget?.id === "hub" ? (
                  <FormattedMessage
                    id="connection-info.ping_info"
                    defaultMessage="{avgping}ms (latest: {ping}ms)"
                    description={
                      "Short string stating the average and the most recent ping in milliseconds."
                    }
                    values={{ avgping, ping }}
                  />
                ) : (
                  <FormattedMessage
                    id="connection-info.project_host_ping_info"
                    defaultMessage="{ping}ms (live probe)"
                    description={
                      "Short string stating the latest measured project-host ping in milliseconds."
                    }
                    values={{ ping: selectedTargetPing }}
                  />
                )}
              </pre>
            </Col>
          </Row>
        ) : undefined}
      </div>
    </Modal>
  );
});
