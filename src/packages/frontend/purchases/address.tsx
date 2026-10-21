import {
  Alert,
  Button,
  Divider,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { Icon } from "@cocalc/frontend/components/icon";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import {
  Elements,
  AddressElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { getStripeCustomer, setStripeCustomer } from "./api";
import ShowError from "@cocalc/frontend/components/error";
import { loadStripe } from "@cocalc/frontend/billing/stripe";
import { BigSpin, ConfirmButton } from "./stripe-payment";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  BUSINESS_TAX_ID_REQUIRED_MESSAGE,
  requiresBusinessTaxId,
} from "@cocalc/util/stripe/business-tax-id";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";

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
  const { resolved } = useAppearance();
  const [error, setError] = useState<string>("");
  const [customer, setCustomer] = useState<any | null>(null);
  const stripeEnabled = !!useTypedRedux("customize", "stripe_enabled");

  useEffect(() => {
    if (!stripeEnabled) return;
    (async () => {
      try {
        setCustomer(await getStripeCustomer());
      } catch (err) {
        setError(`${err}`);
      }
    })();
  }, [stripeEnabled]);

  if (!stripeEnabled) {
    return (
      <Alert
        showIcon
        style={style}
        type="warning"
        title="Card billing is not configured on this site."
        description="Billing details and payment methods can only be managed after an administrator configures Stripe billing."
      />
    );
  }

  if (error) {
    return <ShowError style={style} error={error} setError={setError} />;
  }

  if (customer == null) {
    return <BigSpin style={style} tip="Loading billing details..." />;
  }

  return (
    <Elements
      options={{
        appearance: {
          theme: resolved === "dark" ? "night" : "stripe",
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
      />
    </Elements>
  );
}

function AddressForm({ style, onFinished, showCancel, customer }) {
  const [error, setError] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState<boolean>(false);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const [country, setCountry] = useState<string>(
    `${customer?.address?.country ?? ""}`,
  );
  const [vatId, setVatId] = useState<string>(`${customer?.vat_id?.value ?? ""}`);
  const vatRequired = requiresBusinessTaxId(country);

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
        const vatCountry = requiresBusinessTaxId(value?.address?.country);
        const completed = await runFreshAuthAction(async () => {
          await setStripeCustomer({
            ...value,
            // Only EU and UK addresses carry a VAT number; leave any other
            // tax ID alone.
            ...(vatCountry ? { vat_id: vatId.trim() } : {}),
          });
        });
        if (!completed) {
          return;
        }
        setSuccess(true);
        onFinished?.(value);
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
      {!ready && <BigSpin tip="Loading billing details..." />}
      <AddressElement
        onReady={() => {
          setReady(true);
        }}
        onChange={(event) =>
          setCountry(`${event?.value?.address?.country ?? ""}`)
        }
        options={{
          mode: "billing",
          defaultValues: {
            name: customer?.name,
            address: customer?.address,
            phone: customer?.phone,
          },
        }}
      />
      {ready && vatRequired && (
        <div style={{ marginTop: "15px" }}>
          <div style={{ marginBottom: "5px" }}>
            <b>VAT number</b>{" "}
            {customer?.vat_id?.value &&
              customer.vat_id.value === vatId.replace(/\s+/g, "").toUpperCase() &&
              customer.vat_id.status && (
                <Tag
                  color={
                    customer.vat_id.status === "verified"
                      ? "green"
                      : customer.vat_id.status === "unverified"
                        ? "red"
                        : "gold"
                  }
                >
                  {customer.vat_id.status}
                </Tag>
              )}
          </div>
          <Input
            placeholder="e.g. DE123456789"
            value={vatId}
            onChange={(e) => setVatId(e.target.value)}
            maxLength={40}
          />
          <Typography.Text
            type="secondary"
            style={{ display: "block", marginTop: "5px" }}
          >
            {BUSINESS_TAX_ID_REQUIRED_MESSAGE}
          </Typography.Text>
        </div>
      )}
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
      <FreshAuthModal {...freshAuthModalProps} />
    </div>
  );
}
