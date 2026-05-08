import { moneyRound2Up, toDecimal, type MoneyValue } from "@cocalc/util/money";

export default function getChargeAmount({
  cost,
  balance,
  minBalance: _minBalance,
  minPayment,
}: {
  cost: MoneyValue;
  balance: MoneyValue;
  minBalance: MoneyValue;
  minPayment: MoneyValue;
}): {
  amountDue: number;
  chargeAmount: number;
  cureAmount: number;
  minimumPaymentCharge: number;
} {
  const costValue = toDecimal(cost);
  const balanceValue = toDecimal(balance);
  const minPaymentValue = toDecimal(minPayment);
  const max = (a, b) => (a.gt(b) ? a : b);

  // Legacy negative min_balance credit is deprecated. Existing purchases may
  // cure a negative balance back to zero, but new purchases never intentionally
  // drive the balance below zero.
  const spendableBalance = max(balanceValue, toDecimal(0));
  const cureAmount = max(toDecimal(0).sub(balanceValue), toDecimal(0));
  let amountDue = max(costValue.sub(spendableBalance), toDecimal(0)).add(
    cureAmount,
  );

  const minimumPaymentCharge = amountDue.gt(0)
    ? max(amountDue, minPaymentValue).sub(amountDue)
    : toDecimal(0);

  // amount due can never be negative.
  // We always round up though -- if the user owes us 1.053 cents and we charge 1.05, then
  // they still owe 0.003 and the purchase fails!
  amountDue = moneyRound2Up(max(amountDue, toDecimal(0)));

  // amount you actually have to pay, due to our min payment requirement
  const chargeAmount = amountDue.eq(0)
    ? toDecimal(0)
    : max(amountDue, minPaymentValue);

  return {
    amountDue: amountDue.toNumber(),
    chargeAmount: chargeAmount.toNumber(),
    cureAmount: cureAmount.toNumber(),
    minimumPaymentCharge: minimumPaymentCharge.toNumber(),
  };
}
