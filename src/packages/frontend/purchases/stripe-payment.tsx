/*
- Define what you want to buy and how.
- See an itemized invoice.
- Commit to making that purchase (or delete it)
- Invoice is then finalized and payments attempted if you have a default payment method.
- If you do not have a payment method, get shown a StripeElements UI to enter or select one
- Once payment succeeds, process the invoice, which means getting the thing and also adding/removing credit from user's account.
- In case of pay-as-you-go and subscriptions, if payment doesn't succeed long enough, take action.
*/

import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import type {
  CheckoutSessionSecret,
  LineItem,
  CustomerSessionSecret,
} from "@cocalc/util/stripe/types";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  createPaymentIntent,
  createSetupIntent,
  getCheckoutSession,
  getCustomerSession,
  getPaymentMethods,
  processPaymentIntents,
} from "./api";
import { Alert, Button, Card, Modal, Space, Spin } from "antd";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { loadStripe } from "@cocalc/frontend/billing/stripe";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import ShowError from "@cocalc/frontend/components/error";
import { delay } from "awaiting";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { debounce } from "lodash";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { join } from "path";
import { moneyToStripe, stripeToMoney } from "@cocalc/util/money";
import { Icon } from "@cocalc/frontend/components/icon";
import {
  useEmailVerificationRequired,
  VerifyEmailRequiredPanel,
} from "@cocalc/frontend/app/verify-email-banner";
import { LineItemsTable, moneyToString } from "./line-items";
import { AddressButton, StripeAddressElement } from "./address";
import CancelPaymentIntent from "./cancel-payment-intent";

const PAYMENT_UPDATE_DEBOUNCE = 2000;

interface StripePaymentProps {
  description?: string;
  lineItems?: LineItem[];
  purpose: string;
  metadata?: { [key: string]: string };
  // onFinished gets called with the total (before taxes) once purchase is confirmed by user
  //   - this means the paymentIntent was created when total > 0
  //   - if total = 0, this means user confirmed "I want to make this purchase using credit"; the
  //     caller then needs to actually allocate the thing they want to purchase.
  onFinished?: (total: number) => void | Promise<void>;
  onSubmittingChange?: (submitting: boolean) => void;
  summaryMode?: "full" | "total-only";
  style?;
  title?: ReactNode | null;
  disabled?: boolean;
}

export default function StripePayment(props: StripePaymentProps) {
  const emailVerificationRequired = useEmailVerificationRequired();
  const safeLineItems = props.lineItems ?? [];
  if (safeLineItems.length == 0) {
    // no payment needed.
    return null;
  }
  if (emailVerificationRequired) {
    return (
      <VerifyEmailRequiredPanel
        compact
        title="Verify your email before purchasing"
        description="Please verify your email address before making purchases, adding account credit, or changing paid services."
      />
    );
  }
  return <StripePaymentInner {...props} />;
}

function StripePaymentInner({
  description = "",
  lineItems = [],
  purpose = "add-credit",
  metadata,
  onFinished,
  onSubmittingChange,
  summaryMode = "full",
  style,
  title = description,
  disabled,
}: StripePaymentProps) {
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [requiresPayment, setRequiresPayment] = useState<boolean>(false);
  const [hasPaymentMethods, setHasPaymentMethods] = useState<boolean | null>(
    null,
  );
  const stripeEnabled = !!useTypedRedux("customize", "stripe_enabled");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const safeLineItems = lineItems ?? [];

  useEffect(() => {
    if (!stripeEnabled) {
      setHasPaymentMethods(false);
      return;
    }
    (async () => {
      try {
        const x = await getPaymentMethods({ limit: 1 });
        setHasPaymentMethods(x.data.length > 0);
      } catch (_err) {}
    })();
  }, [stripeEnabled]);

  useEffect(() => {
    setRequiresPayment(false);
  }, [JSON.stringify(safeLineItems)]);

  let totalStripe = 0;
  for (const lineItem of safeLineItems) {
    totalStripe += moneyToStripe(lineItem.amount);
  }

  const showOneClick =
    stripeEnabled &&
    (hasPaymentMethods === true || hasPaymentMethods == null) &&
    !requiresPayment &&
    totalStripe > 0;

  const amountDue = stripeToMoney(totalStripe).toNumber();
  const amountDueLineItem: LineItem = {
    description: "Amount due (excluding tax)",
    amount: amountDue,
    extra: true,
    bold: true,
  };
  const displayedLineItems = safeLineItems.concat(amountDueLineItem);

  return (
    <Card style={{ textAlign: "left" }}>
      {title != null && title !== "" && (
        <div style={{ margin: "0 0 5px 15px" }}>
          <b>{title}</b>
        </div>
      )}
      {summaryMode === "total-only" ? (
        <div
          style={{
            fontSize: "12pt",
            fontWeight: "bold",
            marginBottom: "12px",
            textAlign: "center",
          }}
        >
          Amount due (excluding tax) {moneyToString(amountDue)}
        </div>
      ) : (
        <LineItemsTable lineItems={displayedLineItems} />
      )}
      <div>
        <div style={{ textAlign: "center" }}>
          <Space>
            {hasPaymentMethods == null && <BigSpin style={{ width: "100%" }} />}
            {showOneClick && hasPaymentMethods != null && (
              <Tooltip title="Attempt to finish this purchase (including computing and adding tax) using any payment methods you have on file.">
                <ConfirmButton
                  isSubmitting={loading}
                  label={
                    "Buy Now With 1-Click" /* amazon's patent expired in 2017 */
                  }
                  showAddress
                  onClick={async () => {
                    try {
                      setLoading(true);
                      onSubmittingChange?.(true);
                      await runFreshAuthAction(async () => {
                        await createPaymentIntent({
                          description,
                          lineItems: safeLineItems,
                          purpose,
                          metadata,
                        });
                        await onFinished?.(
                          stripeToMoney(totalStripe).toNumber(),
                        );
                      });
                    } catch (err) {
                      setError(`${err}`);
                    } finally {
                      onSubmittingChange?.(false);
                      setLoading(false);
                    }
                  }}
                />
              </Tooltip>
            )}
            {!requiresPayment && hasPaymentMethods != null && (
              <ConfirmButton
                notPrimary={showOneClick}
                disabled={loading || (!stripeEnabled && totalStripe > 0)}
                showAddress={stripeEnabled && !showOneClick && totalStripe > 0}
                label={
                  totalStripe > 0
                    ? stripeEnabled
                      ? "Choose Payment Method"
                      : "Stripe payments unavailable"
                    : "Purchase With 1-Click Using Account Credit"
                }
                onClick={async () => {
                  if (totalStripe <= 0) {
                    // no need to do stripe part at all -- just do next step of whatever purchase is happening.
                    onFinished?.(0);
                    setRequiresPayment(true);
                    return;
                  }
                  if (!stripeEnabled) {
                    setError(
                      "Stripe payments are not configured on this site. This purchase can only be completed if account credit covers the full amount.",
                    );
                    return;
                  }
                  try {
                    setLoading(true);
                    await runFreshAuthAction(async () => {
                      setRequiresPayment(true);
                    });
                  } catch (err) {
                    setError(`${err}`);
                  } finally {
                    setLoading(false);
                  }
                }}
              />
            )}
          </Space>
          {!stripeEnabled && totalStripe > 0 && (
            <Alert
              showIcon
              style={{ margin: "15px auto", maxWidth: "600px" }}
              type="warning"
              message="Stripe payments are not configured on this site."
              description="This purchase can only be completed here if account credit covers the full amount."
            />
          )}
        </div>
        <ShowError
          style={{ margin: "15px 0" }}
          error={error}
          setError={setError}
        />
      </div>
      {requiresPayment && !disabled && (
        <div style={{ textAlign: "center" }}>
          <StripeCheckout
            {...{
              lineItems,
              description,
              purpose,
              metadata,
              onFinished,
              style,
              totalStripe,
              hasPaymentMethods,
            }}
          />
          <Button
            onClick={() => setRequiresPayment(false)}
            style={{ marginTop: "15px" }}
          >
            Cancel
          </Button>
        </div>
      )}
      <FreshAuthModal {...freshAuthModalProps} />
    </Card>
  );
}

function StripeCheckout({
  lineItems,
  description,
  purpose,
  metadata,
  onFinished,
  style,
  totalStripe,
  hasPaymentMethods,
}) {
  const [secret, setSecret] = useState<CheckoutSessionSecret | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  const updateSecret = useCallback(
    debounce(
      reuseInFlight(async ({ lineItems, description, purpose }) => {
        try {
          setError("");
          setLoading(true);
          let secret;
          let attempts = 3;
          for (let i = 0; i < attempts; i++) {
            try {
              secret = await getCheckoutSession({
                lineItems,
                description,
                purpose,
                metadata,
              });
              break;
            } catch (err) {
              console.warn("issue getting stripe checkout session", err);
              if (i >= attempts - 1) {
                throw err;
              } else {
                await delay(PAYMENT_UPDATE_DEBOUNCE);
              }
            }
          }
          setSecret(secret);
          // give stripe iframe extra time to load:
          setTimeout(() => {
            setLoading(false);
          }, 3000);
        } catch (err) {
          setError(`${err}`);
          setLoading(false);
        }
      }),
      PAYMENT_UPDATE_DEBOUNCE,
      { leading: true, trailing: true },
    ),
    [],
  );

  useEffect(() => {
    updateSecret({ lineItems, description, purpose });
  }, [lineItems, description, purpose]);

  if (error) {
    return <ShowError style={style} error={error} setError={setError} />;
  }

  if (secret == null) {
    return <BigSpin style={style} />;
  }

  return (
    <div>
      {loading && <BigSpin />}
      {!hasPaymentMethods && (
        <div>
          {/* This is a workaround for a possible bug in our code or
          any conflicts between the user's browser, extensions, etc.
          and stripe checkout.  Purchasing with a payment method and
          1-click doesn't use stripe checkout at all and is thus
          much more reliable... but involves more steps and doesn't
          show local pricing, etc. */}
          <Alert
            showIcon
            style={{ width: "90%", margin: "15px auto", fontSize: "12pt" }}
            type="warning"
            title={
              <b>
                If you have a problem paying below, add a{" "}
                <a
                  href={join(
                    appBasePath,
                    "settings/payment-methods#page=unread",
                  )}
                  target="_blank"
                >
                  payment method
                </a>
                , then refresh this page and click "Buy Now With 1-Click".
              </b>
            }
          />
        </div>
      )}
      <EmbeddedCheckoutProvider
        options={{
          fetchClientSecret: async () => secret.clientSecret,
          onComplete: async () => {
            try {
              setError("");
              setLoading(true);
              await processPaymentIntents({
                checkout_session_id: secret.sessionId,
                strict: true,
              });
              onFinished?.(stripeToMoney(totalStripe).toNumber());
            } catch (err) {
              setError(`${err}`);
            } finally {
              setLoading(false);
            }
          },
        }}
        stripe={loadStripe()}
      >
        <EmbeddedCheckout className="cc-stripe-embedded-checkout" />
      </EmbeddedCheckoutProvider>
    </div>
  );
}

export function FinishStripePayment(props: {
  paymentIntent;
  style?;
  onFinished?;
}) {
  const emailVerificationRequired = useEmailVerificationRequired();
  if (emailVerificationRequired) {
    return (
      <VerifyEmailRequiredPanel
        compact
        title="Verify your email before completing payment"
        description="Please verify your email address before completing purchases."
        style={props.style}
      />
    );
  }
  return <FinishStripePaymentInner {...props} />;
}

function FinishStripePaymentInner({
  paymentIntent,
  style,
  onFinished,
}: {
  paymentIntent;
  style?;
  onFinished?;
}) {
  const [error, setError] = useState<string>("");
  const [customerSession, setCustomerSession] =
    useState<CustomerSessionSecret | null>(null);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  useEffect(() => {
    (async () => {
      try {
        await runFreshAuthAction(async () => {
          setCustomerSession(await getCustomerSession());
        });
      } catch (err) {
        setError(`${err}`);
      }
    })();
  }, [paymentIntent, runFreshAuthAction]);

  if (error) {
    return (
      <>
        <ShowError style={style} error={error} setError={setError} />
        <FreshAuthModal {...freshAuthModalProps} />
      </>
    );
  }

  if (customerSession == null) {
    return <BigSpin style={style} />;
  }

  return (
    <Elements
      options={{
        ...customerSession,
        clientSecret: paymentIntent.client_secret,
        appearance: {
          theme: "stripe",
        },
        loader: "never",
      }}
      stripe={loadStripe()}
    >
      <PaymentForm
        style={style}
        onFinished={onFinished}
        paymentIntent={paymentIntent}
      />
      <FreshAuthModal {...freshAuthModalProps} />
    </Elements>
  );
}

function PaymentForm({ style, onFinished, paymentIntent }) {
  const finalized =
    paymentIntent.status == "succeeded" || paymentIntent.status == "canceled";
  const [message, setMessage] = useState<string | undefined>(undefined);
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
      setIsSubmitting(true);

      const { error } = await stripe.confirmPayment({
        elements,
        redirect: "if_required",
        confirmParams: {
          // because we use strict auth cookies, this can't be a page that requires
          // sign in.
          return_url: `${window.location.origin}${appBasePath}`,
        },
      });

      try {
        await processPaymentIntents({
          payment_intent_id: paymentIntent.id,
          strict: true,
        });
      } catch (err) {
        console.warn("issue processing payment", err);
        // would usually be due to throttling, but could be network went down or
        // cocalc went down at exactly the wrong time.
        console.log("try again in 15s...");
        await delay(15000);
        try {
          await processPaymentIntents({
            payment_intent_id: paymentIntent.id,
            strict: true,
          });
        } catch (err) {
          console.warn("still failing to process payment", err);
          setMessage(
            `Your payment appears to have gone through, but CoCalc has not yet recorded it. Please close this dialog and check the payment status panel. ${err}`,
          );
          return;
          // still failing -- a backend maintenance task does
          // handle any missed payments within a few minutes.
          // And also there is the "payment status" panel.
        }
      }
      if (!error) {
        setSuccess(true);
        onFinished?.();
        return;
      }
      if (error.type === "card_error" || error.type === "validation_error") {
        setMessage(error.message);
      } else {
        setMessage("An unexpected error occurred.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={style}>
      {!ready && <BigSpin />}
      <PaymentElement
        onReady={() => {
          setReady(true);
        }}
        options={{
          layout: "tabs",
        }}
      />
      {ready && (
        <ConfirmButton
          label={<>Use this Payment Method</>}
          showAddress
          disabled={
            success ||
            finalized ||
            isSubmitting ||
            !stripe ||
            !elements ||
            !ready
          }
          onClick={handleSubmit}
          success={success}
          isSubmitting={isSubmitting}
          cancellablePaymentIntentId={!finalized ? paymentIntent.id : undefined}
          cancelText="Close"
          onCancel={() => {
            onFinished?.();
          }}
        />
      )}
      {/* Show error message */}
      <ShowError
        error={message}
        style={{ marginTop: "10px" }}
        setError={setMessage}
      />
    </div>
  );
}

export function ConfirmButton({
  disabled,
  onClick,
  success,
  isSubmitting,
  label,
  notPrimary,
  onCancel,
  showAddress,
  cancellablePaymentIntentId,
  cancelText,
}: {
  disabled?: boolean;
  onClick;
  success?: boolean;
  isSubmitting?: boolean;
  label;
  notPrimary?: boolean;
  onCancel?: Function;
  showAddress?: boolean;
  cancelText?: string;
  // if given, also include button to cancel the given payment intent
  cancellablePaymentIntentId?: string;
}) {
  return (
    <div style={{ marginTop: "15px", display: "flex" }}>
      <div style={{ margin: "auto" }}>
        <Space wrap>
          {onCancel != null && (
            <Button
              size="large"
              onClick={() => onCancel()}
              style={{ height: "44px" }}
            >
              {cancelText ?? "Cancel"}
            </Button>
          )}
          <Button
            size="large"
            style={
              {
                minWidth: "150px",
                height: "44px",
                maxWidth: "100%",
              } /* button sized to match stripe's */
            }
            type={notPrimary ? undefined : "primary"}
            disabled={disabled || isSubmitting}
            onClick={onClick}
          >
            {!success && (
              <>
                {label}
                {isSubmitting && <Spin style={{ marginLeft: "15px" }} />}
              </>
            )}
            {success && <>Purchase Successfully Completed!</>}
          </Button>
          {showAddress && (
            <AddressButton
              disabled={disabled || isSubmitting}
              size="large"
              style={{ height: "44px" }}
            />
          )}
          {!!cancellablePaymentIntentId && (
            <CancelPaymentIntent
              paymentIntentId={cancellablePaymentIntentId}
              disabled={disabled || isSubmitting}
              size="large"
              style={{ height: "44px" }}
              onCancel={onCancel}
            />
          )}
        </Space>
      </div>
    </div>
  );
}

export function BigSpin({ style, tip = "Loading" }: { style?; tip?: string }) {
  return (
    <div style={{ ...style, textAlign: "center" }}>
      <Spin tip={tip} size="large">
        <div
          style={{
            padding: 50,
            background: "rgba(0, 0, 0, 0.05)",
            borderRadius: 4,
          }}
        />
      </Spin>
    </div>
  );
}

export function AddPaymentMethodButton({
  style,
  onFinished,
}: {
  style?;
  onFinished?;
}) {
  const [show, setShow] = useState<boolean>(false);
  const button = (
    <Button onClick={() => setShow(!show)}>
      <Icon name="plus-circle" /> Add Payment Method
    </Button>
  );
  if (!show) {
    return button;
  }
  return (
    <div
      style={{
        display: "inline-block",
        maxWidth: "450px",
        width: "100%",
        ...style,
      }}
    >
      {button}
      {show && (
        <AddPaymentMethodModal
          onCancel={() => setShow(false)}
          onFinished={() => {
            setShow(false);
            onFinished?.();
          }}
        />
      )}
    </div>
  );
}

export function AddPaymentMethodModal({
  onCancel,
  onFinished,
}: {
  onCancel: () => void;
  onFinished?: () => void;
}) {
  return (
    <BillingSetupModal
      onCancel={onCancel}
      onFinished={onFinished}
      requirePaymentMethod
      title="Add Payment Method"
    />
  );
}

export function BillingSetupModal({
  onCancel,
  onFinished,
  requirePaymentMethod,
  title = requirePaymentMethod ? "Add Payment Method" : "Billing Details",
}: {
  onCancel: () => void;
  onFinished?: () => void;
  requirePaymentMethod: boolean;
  title?: ReactNode;
}) {
  const [addressSaved, setAddressSaved] = useState<boolean>(false);
  const finishAddress = () => {
    if (requirePaymentMethod) {
      setAddressSaved(true);
    } else {
      onFinished?.();
    }
  };
  return (
    <Modal open title={title} onCancel={onCancel} onOk={onCancel} footer={[]}>
      {!addressSaved ? (
        <Space vertical size="middle" style={{ width: "100%" }}>
          <Alert
            showIcon
            type="info"
            message="Enter your billing name and address first."
            description="CoCalc uses this for receipts, invoices, and tax calculation."
          />
          <StripeAddressElement onFinished={finishAddress} showCancel={false} />
        </Space>
      ) : (
        <CollectPaymentMethod onFinished={onFinished} />
      )}
    </Modal>
  );
}

function CollectPaymentMethod(props: { style?; onFinished? }) {
  const emailVerificationRequired = useEmailVerificationRequired();
  if (emailVerificationRequired) {
    return (
      <VerifyEmailRequiredPanel
        compact
        title="Verify your email before adding a payment method"
        description="Please verify your email address before adding payment methods or starting membership trials."
        style={props.style}
      />
    );
  }
  return <CollectPaymentMethodInner {...props} />;
}

function CollectPaymentMethodInner({
  style,
  onFinished,
}: {
  style?;
  onFinished?;
}) {
  const [error, setError] = useState<string>("");
  const [secret, setSecret] = useState<any>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const load = async () => {
    try {
      setLoading(true);
      setError("");
      const intent = await createSetupIntent({
        description: "Add a new payment method.",
      });
      setSecret(intent);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return <BigSpin style={style} tip="Loading payment form..." />;
  }

  if (error) {
    return (
      <ShowError
        style={style}
        error={error}
        setError={(error) => {
          setError(error);
          load();
        }}
      />
    );
  }

  if (secret == null) {
    return <BigSpin style={style} tip="Loading payment form..." />;
  }

  return (
    <>
      <Elements
        options={{
          ...secret,
          appearance: {
            theme: "stripe",
          },
          loader: "never",
        }}
        stripe={loadStripe()}
      >
        <FinishCollectingPaymentMethod
          style={style}
          onFinished={onFinished}
          setError={setError}
        />
      </Elements>
    </>
  );
}

function FinishCollectingPaymentMethod({ style, onFinished, setError }) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    setTimeout(() => setLoading(false), 3000);
  }, []);

  if (!stripe || !elements) {
    return <BigSpin style={style} tip="Loading payment form..." />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) {
      // Stripe.js hasn't yet loaded.
      // Make sure to disable form submission until Stripe.js has loaded.
      return;
    }
    try {
      setIsSubmitting(true);
      const { error } = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
        confirmParams: {
          return_url: `${window.location.origin}${appBasePath}`,
        },
      });
      if (!error) {
        onFinished?.();
      } else {
        setError(error.message ?? "");
      }
    } catch (err) {
      setError(`${err}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div style={style}>
      {loading && <BigSpin tip="Loading payment form..." />}
      <PaymentElement />
      <ConfirmButton
        disabled={loading}
        isSubmitting={isSubmitting}
        onClick={handleSubmit}
        label={"Save Payment Method"}
      />
    </div>
  );
}
