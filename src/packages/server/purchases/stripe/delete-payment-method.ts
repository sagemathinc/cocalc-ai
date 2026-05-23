import getConn from "@cocalc/server/stripe/connection";
import { getStripeCustomerId } from "./util";

export default async function deletePaymentMethod({
  account_id,
  payment_method,
}: {
  account_id: string;
  payment_method: string;
}) {
  const customer = await getStripeCustomerId({ account_id, create: false });
  if (!customer) {
    throw Error("customer does not exist in stripe, so has no payment methods");
  }
  const stripe = await getConn();
  await stripe.customers.retrievePaymentMethod(customer, payment_method);
  await stripe.paymentMethods.detach(payment_method);
}
