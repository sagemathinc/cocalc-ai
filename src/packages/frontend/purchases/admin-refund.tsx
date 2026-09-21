/*
Show a Refund... button.  When clicked, shows modal to enter reason and notes,
and submit the refund.  The backend then has stripe do the refund, and also creates
a service="refund" transaction.

NOTE: we do not implement partial refunds, since it's **really complicated** to even
figure out *what* to refund, due to sales tax, currency conversion rates, etc.  If we ever
need to deal with that, maybe something can be done manually.  It's pretty rare,
and can at least be done via stripe directly in terms of providing money back,
and we could manually create a corresponding refund transaction to match that.
I had implemented this and realized that its super hard to get right given tax, etc.
*/

import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { Icon } from "@cocalc/frontend/components/icon";
import { useState } from "react";
import { Button, Modal, Input, Select, Form, Divider } from "antd";
import { adminCreateRefund } from "./api";
import ShowError from "@cocalc/frontend/components/error";
import { BigSpin } from "./stripe-payment";
import type { Service } from "@cocalc/util/db-schema/purchases";
import { currency } from "@cocalc/util/misc";

const DEFAULT_REASON = "requested_by_customer";

export function isRefundable(
  service: Service,
  cost: number | null | undefined,
) {
  return (
    service !== "refund" &&
    service !== "credit-transfer" &&
    cost != null &&
    Number.isFinite(Number(cost))
  );
}

const labelStyle = { width: "60px" } as const;

export default function AdminRefund({
  purchase_id,
  service,
  cost,
  subscription_id,
  membership_package,
  refresh,
}: {
  purchase_id: number;
  service: Service;
  cost: number;
  subscription_id?: number | string | null;
  membership_package?: boolean;
  refresh?;
}) {
  const [error, setError] = useState<string>("");
  const [refunding, setRefunding] = useState<boolean>(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [form] = Form.useForm(); // Add this line
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  const showModal = () => {
    setError("");
    setIsModalVisible(true);
  };

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      await runFreshAuthAction(async () => {
        setRefunding(true);
        try {
          await adminCreateRefund({
            purchase_id,
            reason: values.reason ?? DEFAULT_REASON,
            notes: values.notes,
          });
          setIsModalVisible(false);
          form.resetFields();
          refresh?.();
        } finally {
          setRefunding(false);
        }
      });
    } catch (err) {
      setError(`${err}`);
    }
  };

  const handleCancel = () => {
    setError("");
    setIsModalVisible(false);
    form.resetFields();
  };

  const amount = Math.abs(cost);
  const personalMembership =
    service == "membership" &&
    Number.isInteger(Number(subscription_id)) &&
    Number(subscription_id) > 0;
  const membershipPackage =
    service == "membership" && membership_package === true;

  return (
    <>
      <Button onClick={showModal}>
        <Icon name="reply" /> Admin Refund
      </Button>
      <Modal
        title=<>
          <Icon name="reply" style={{ marginRight: "8px" }} /> Admin Refund
        </>
        open={isModalVisible}
        onOk={handleOk}
        onCancel={handleCancel}
        okText="Refund"
        okButtonProps={{ loading: refunding }}
      >
        {(service == "credit" || service == "auto-credit") && (
          <>
            The amount {currency(amount, 2)} of this credit will be deducted
            from the account and listed as a new refund transaction "Refund
            Transaction {purchase_id}". Any corresponding Stripe payment will be
            fully refunded.
          </>
        )}
        {personalMembership && (
          <>
            This membership purchase will be reversed. The exact subscription
            will be canceled and expire immediately. Any related credit
            transaction and Stripe payment will not be changed; refund that
            credit transaction separately when appropriate.
          </>
        )}
        {membershipPackage && (
          <>
            This membership package purchase will be reversed. For an original
            package purchase, the package will expire immediately and its active
            seats will be revoked. For a seat expansion, the purchased
            unassigned seats will be removed. Any related credit transaction and
            Stripe payment will not be changed; refund that credit transaction
            separately when appropriate.
          </>
        )}
        {service != "credit" &&
          service != "auto-credit" &&
          !personalMembership &&
          !membershipPackage && (
            <>
              The amount {currency(amount, 2)} will be reversed in the CoCalc
              account. This does not undo resources that have already been
              consumed.
            </>
          )}
        <Divider />
        <Form form={form} initialValues={{ reason: DEFAULT_REASON }}>
          <Form.Item
            name="reason"
            label={<div style={labelStyle}>Reason</div>}
            rules={[{ required: true, message: "Select a refund reason." }]}
          >
            <Select style={{ width: "100%" }} placeholder="Select Reason...">
              <Select.Option value="duplicate">Duplicate</Select.Option>
              <Select.Option value="fraudulent">Fraudulent</Select.Option>
              <Select.Option value="requested_by_customer">
                Requested by Customer
              </Select.Option>
              <Select.Option value="other">Other</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="notes" label={<div style={labelStyle}>Notes</div>}>
            <Input.TextArea rows={3} />
          </Form.Item>
          <div style={{ color: "#666" }}>
            <Divider>What Happens: more details</Divider>
            The above information will be visible to the user. Their CoCalc
            transactions log and statement will include a new "Refund" entry
            immediately, and they will be sent a message.
            {(service == "credit" || service == "auto-credit") && (
              <>
                {" "}
                If a Stripe payment is associated with the credit, the money
                should appear on their card or bank statement in 5-10 days.
                Stripe's fees for the original payment won't be returned, but
                there are no additional fees for the refund. Stripe will use its
                latest exchange rate, which may differ from the original rate.
                Partial refunds are not implemented.
              </>
            )}
          </div>
        </Form>
        {refunding && <BigSpin />}
        <ShowError
          error={error}
          setError={setError}
          style={{ margin: "15px 0" }}
        />
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
