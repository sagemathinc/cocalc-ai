import { Button, Divider, Modal, Space } from "antd";
import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components/icon";
import {
  Elements,
  AddressElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import {
  getCustomerSession,
  getStripeCustomer,
  setStripeCustomer,
} from "./api";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import ShowError from "@cocalc/frontend/components/error";
import { loadStripe } from "@cocalc/frontend/billing/stripe";
import type { CustomerSessionSecret } from "@cocalc/util/stripe/types";
import { BigSpin, ConfirmButton } from "./stripe-payment";

function Title() {
  return (
    <>
      <Icon name="address-card" /> Name and Address
    </>
  );
}

export function AddressButton(props?) {
  const [open, setOpen] = useState<boolean>(false);
  return (
    <>
      <Button {...props} onClick={() => setOpen(!open)}>
        <Title />
      </Button>
      {open && (
        <AddressModal
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function AddressModal({ onClose }) {
  return (
    <Modal open onCancel={onClose} onOk={onClose} title={<Title />} footer={[]}>
      <StripeAddressElement onFinished={() => onClose()} />
    </Modal>
  );
}

export function StripeAddressElement({
  style,
  onFinished,
  showCancel = true,
}: {
  style?;
  onFinished?;
  showCancel?: boolean;
}) {
  const [error, setError] = useState<string>("");
  const [customerSession, setCustomerSession] =
    useState<CustomerSessionSecret | null>(null);
  const [customer, setCustomer] = useState<any | null>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  useEffect(() => {
    (async () => {
      try {
        await runFreshAuthAction(async () => {
          setCustomerSession(await getCustomerSession());
          setCustomer(await getStripeCustomer());
        });
      } catch (err) {
        setError(`${err}`);
      }
    })();
  }, [runFreshAuthAction]);

  if (error) {
    return (
      <>
        <ShowError style={style} error={error} setError={setError} />
        <FreshAuthModal {...freshAuthModalProps} />
      </>
    );
  }

  if (customerSession == null || customer == null) {
    return <BigSpin style={style} />;
  }

  return (
    <Elements
      options={{
        ...customerSession,
        appearance: {
          theme: "stripe",
        },
        loader: "never",
      }}
      stripe={loadStripe()}
    >
      <AddressForm
        style={style}
        onFinished={onFinished}
        showCancel={showCancel}
        customer={customer}
        runFreshAuthAction={runFreshAuthAction}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </Elements>
  );
}

function AddressForm({
  style,
  onFinished,
  showCancel,
  customer,
  runFreshAuthAction,
}) {
  const [error, setError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState<boolean>(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!stripe || !elements) {
      // Stripe.js hasn't yet loaded.
      // Make sure to disable form submission until Stripe.js has loaded.
      return;
    }

    try {
      setError("");
      setIsSubmitting(true);
      const addressElement = elements.getElement("address");
      if (addressElement == null) {
        throw Error("BUG -- can't find address element");
      }
      const { complete, value } = await addressElement.getValue();
      if (complete) {
        await runFreshAuthAction(async () => {
          await setStripeCustomer(value);
          setSuccess(true);
          onFinished?.();
        });
        return;
      }
      setError("Complete billing name and address before continuing.");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={style}>
      Name and address for receipts, invoices and tax.
      <Divider />
      {!ready && <BigSpin />}
      <AddressElement
        onReady={() => {
          setReady(true);
        }}
        options={{ mode: "billing", defaultValues: customer }}
      />
      <div style={{ textAlign: "center", marginTop: "15px" }}>
        <Space>
          {ready && (
            <ConfirmButton
              label={<>Save Address</>}
              disabled={
                success || isSubmitting || !stripe || !elements || !ready
              }
              onClick={handleSubmit}
              success={success}
              isSubmitting={isSubmitting}
              onCancel={showCancel ? () => onFinished?.() : undefined}
            />
          )}
        </Space>
      </div>
      <ShowError
        error={error}
        style={{ marginTop: "15px" }}
        setError={setError}
      />
    </div>
  );
}
