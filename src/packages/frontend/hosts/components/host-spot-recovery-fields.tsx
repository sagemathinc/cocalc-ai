/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Col, Form, InputNumber, Switch } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type {
  HostInterruptionRestorePolicy,
  HostPricingModel,
} from "@cocalc/conat/hub/api/hosts";
import {
  DEFAULT_SPOT_RECOVERY_POLICY,
  isSpotRecoveryPolicyActive,
} from "../utils/spot-recovery-policy";

type HostSpotRecoveryFieldsProps = {
  visible: boolean;
};

export const HostSpotRecoveryFields: React.FC<HostSpotRecoveryFieldsProps> = ({
  visible,
}) => {
  const form = Form.useFormInstance();
  const pricingModel = Form.useWatch("pricing_model", form) as
    | HostPricingModel
    | undefined;
  const interruptionRestorePolicy = Form.useWatch(
    "interruption_restore_policy",
    form,
  ) as HostInterruptionRestorePolicy | undefined;
  const standardFallbackEnabled = Form.useWatch(
    ["spot_recovery_policy", "standard_fallback_enabled"],
    form,
  ) as boolean | undefined;
  const policyActive = isSpotRecoveryPolicyActive({
    pricingModel,
    interruptionRestorePolicy,
  });

  React.useEffect(() => {
    if (!visible || !policyActive) return;
    if (form.getFieldValue("spot_recovery_policy") != null) return;
    form.setFieldsValue({
      spot_recovery_policy: { ...DEFAULT_SPOT_RECOVERY_POLICY },
    });
  }, [form, policyActive, visible]);

  if (!visible || pricingModel !== "spot") {
    return null;
  }

  return (
    <>
      <Col span={24}>
        <Alert
          showIcon
          type="info"
          message="Spot recovery strategy"
          description="After a spot interruption, CoCalc first retries the original spot VM, can temporarily fall back to a standard VM, then probes and switches back to spot to control cost."
        />
      </Col>
      {!policyActive ? (
        <Col span={24}>
          <Alert
            showIcon
            type="warning"
            message="Recovery strategy inactive"
            description="These settings only apply while interruption restore is set to Restore immediately."
          />
        </Col>
      ) : (
        <>
          <Col span={12}>
            <Form.Item
              name={[
                "spot_recovery_policy",
                "spot_restore_retry_window_minutes",
              ]}
              label="Spot retry window (minutes)"
              tooltip="How long to keep retrying the interrupted spot VM before falling back to standard."
              initialValue={
                DEFAULT_SPOT_RECOVERY_POLICY.spot_restore_retry_window_minutes
              }
            >
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name={["spot_recovery_policy", "spot_restore_backoff_seconds"]}
              label="Retry backoff (seconds)"
              tooltip="Base delay between spot restore attempts. The worker adds exponential backoff up to a cap."
              initialValue={
                DEFAULT_SPOT_RECOVERY_POLICY.spot_restore_backoff_seconds
              }
            >
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              name={[
                "spot_recovery_policy",
                "max_restore_attempts_before_fallback",
              ]}
              label="Max restore attempts before fallback"
              tooltip="Set this to 0 to rely only on the retry window."
              extra="0 means retry until the spot retry window expires."
              initialValue={
                DEFAULT_SPOT_RECOVERY_POLICY.max_restore_attempts_before_fallback
              }
            >
              <InputNumber min={0} style={{ width: "100%" }} />
            </Form.Item>
          </Col>
          <Col span={24}>
            <Form.Item
              name={["spot_recovery_policy", "standard_fallback_enabled"]}
              label="Allow standard fallback"
              tooltip="If spot retries fail, temporarily switch this host to a standard VM to restore service."
              initialValue={
                DEFAULT_SPOT_RECOVERY_POLICY.standard_fallback_enabled
              }
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </Col>
          {standardFallbackEnabled !== false && (
            <>
              <Col span={12}>
                <Form.Item
                  name={[
                    "spot_recovery_policy",
                    "standard_fallback_min_minutes",
                  ]}
                  label="Minimum standard runtime (minutes)"
                  tooltip="After falling back to standard, wait at least this long before probing to return to spot."
                  initialValue={
                    DEFAULT_SPOT_RECOVERY_POLICY.standard_fallback_min_minutes
                  }
                >
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name={["spot_recovery_policy", "spot_probe_interval_minutes"]}
                  label="Spot probe interval (minutes)"
                  tooltip="How often to probe the same zone and machine type for spot availability while the host is on standard."
                  initialValue={
                    DEFAULT_SPOT_RECOVERY_POLICY.spot_probe_interval_minutes
                  }
                >
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item
                  name={["spot_recovery_policy", "spot_return_requires_probe"]}
                  label="Require successful probe before returning to spot"
                  tooltip="If enabled, CoCalc only switches a standard fallback host back to spot after a matching probe VM starts successfully."
                  initialValue={
                    DEFAULT_SPOT_RECOVERY_POLICY.spot_return_requires_probe
                  }
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
              </Col>
            </>
          )}
        </>
      )}
    </>
  );
};
