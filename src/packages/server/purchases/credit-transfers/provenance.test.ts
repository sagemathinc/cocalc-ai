import { projectCreditLots, selectCreditFragments } from "./provenance";
import type { CreditFragment, ProvenancePurchase } from "./provenance";

const fragment = (id: number, amount = "100"): CreditFragment => ({
  root: {
    root_id: `root-${id}`,
    home_bay_id: "a",
    account_id: "payer",
    purchase_id: id,
    payment_intent_id: `pi_${id}`,
    amount_usd: amount,
  },
  source_purchase_id: id,
  amount_usd: amount,
});
const paid = (id: number, amount = "100"): ProvenancePurchase => ({
  id,
  cost: `-${amount}`,
  credit: [fragment(id, amount)],
});
const amounts = (rows: ProvenancePurchase[]) =>
  projectCreditLots(rows).map(({ amount_usd }) => Number(amount_usd));

it("does not turn promotional credit into paid credit after a purchase", () => {
  expect(
    amounts([paid(1), { id: 2, cost: "80" }, { id: 3, cost: "-100" }]),
  ).toEqual([20]);
});
it("consumes paid lots before older restricted credits", () => {
  expect(
    amounts([{ id: 1, cost: "-100" }, paid(2), { id: 3, cost: "80" }]),
  ).toEqual([20]);
});
it("never turns a service refund into restored payment provenance", () => {
  expect(
    amounts([paid(1), { id: 2, cost: "100" }, { id: 3, cost: "-100" }]),
  ).toEqual([]);
});
it("covers existing postpaid debt before creating eligible lots", () => {
  expect(amounts([{ id: 1, cost: "80" }, paid(2)])).toEqual([20]);
});
it("preserves roots through receipt, retransfer and compensation", () => {
  const first = fragment(1, "60");
  const incoming = { id: 4, cost: "-60", credit: [first] };
  const lots = projectCreditLots([incoming]);
  const selected = selectCreditFragments(
    lots,
    new Set([first.root.root_id]),
    "40",
  );
  expect(selected[0].root).toEqual(first.root);
  expect(selected[0].source_purchase_id).toBe(4);
  expect(
    amounts([
      incoming,
      { id: 5, cost: "40", debit: selected },
      { id: 6, cost: "-40", credit: selected },
    ]),
  ).toEqual([20, 40]);
});
it("does not double-count an explicit outgoing debit", () => {
  expect(
    amounts([
      paid(1),
      { id: 2, cost: "60", debit: [fragment(1, "60")] },
      { id: 3, cost: "30" },
    ]),
  ).toEqual([10]);
});
it("fails closed when an earlier debit makes an already exported lot impossible", () => {
  expect(() =>
    projectCreditLots([
      paid(1),
      { id: 2, cost: "50" },
      { id: 3, cost: "60", debit: [fragment(1, "60")] },
    ]),
  ).toThrow("reconciliation");
});
it("rejects unresolved, invalid and unordered amounts", () => {
  for (const cost of ["NaN", "Infinity", "not money"])
    expect(() => projectCreditLots([{ id: 1, cost }])).toThrow();
  expect(() => projectCreditLots([paid(2), paid(1)])).toThrow("Unordered");
  expect(() => projectCreditLots([{ ...paid(1), cost: "-99" }])).toThrow(
    "match ledger",
  );
});
it("ignores roots that are no longer cleared or have been disputed", () => {
  const lots = projectCreditLots([paid(1), paid(2)]);
  expect(() => selectCreditFragments(lots, new Set(), "1")).toThrow(
    "Insufficient",
  );
  expect(
    selectCreditFragments(lots, new Set(["root-2"]), "90")[0].root.root_id,
  ).toBe("root-2");
});

it("does not let disputed lots shelter cleared credit from ordinary spending", () => {
  const lots = projectCreditLots(
    [paid(1), paid(2), { id: 3, cost: "100" }],
    new Set(["root-2"]),
  );
  expect(() => selectCreditFragments(lots, new Set(["root-2"]), "1")).toThrow(
    "Insufficient",
  );
});
