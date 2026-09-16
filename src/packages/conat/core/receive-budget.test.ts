import { AggregateReceiveBudget, ReceiveBudget } from "./receive-budget";

const limits = {
  maxMessageBytes: 10,
  maxInflightBytes: 15,
  maxInflightMessages: 2,
};

test("per-message rejection releases partial bytes, without evicting other messages", () => {
  const b = new ReceiveBudget(limits);
  expect(b.add("a", 5)).toBe(true);
  expect(b.add("b", 5)).toBe(true);
  expect(b.add("a", 6)).toBe(false);
  expect(b.add("c", 10)).toBe(true);
  expect(b.add("b", 1)).toBe(false);
  b.remove("c");
  b.remove("c");
  expect(b.add("d", 10)).toBe(true);
});

test("aggregate bytes and zero-length message counts are bounded", () => {
  const b = new ReceiveBudget(limits);
  expect(b.add("a", 10)).toBe(true);
  expect(b.add("b", 6)).toBe(false);
  expect(b.add("b", 0)).toBe(true);
  expect(b.add("c", 0)).toBe(false);
  b.remove("a");
  expect(b.add("c", 10)).toBe(true);
});

test("zero-byte fragments cannot accumulate unbounded metadata", () => {
  const b = new ReceiveBudget({ ...limits, maxFragmentsPerMessage: 2 });
  expect(b.add("a", 0)).toBe(true);
  expect(b.add("a", 0)).toBe(true);
  expect(b.add("a", 0)).toBe(false);
  expect(b.add("b", 10)).toBe(true);
});

test("missing bounds are rejected and caller mutation cannot change them", () => {
  expect(() => new ReceiveBudget({} as any)).toThrow();
  const config = { ...limits };
  const b = new ReceiveBudget(config);
  config.maxMessageBytes = 1000;
  expect(b.add("a", 11)).toBe(false);
});

test.each([NaN, Infinity, -1, 0.5])(
  "invalid fragment size fails closed: %s",
  (bytes) => {
    const b = new ReceiveBudget(limits);
    expect(b.add("a", bytes)).toBe(false);
    expect(b.add("a", 10)).toBe(true);
  },
);

test.each([NaN, Infinity, -1, 0, 0.5])(
  "invalid configured bound fails closed: %s",
  (maxMessageBytes) => {
    expect(() => new ReceiveBudget({ ...limits, maxMessageBytes })).toThrow();
  },
);

test("separate subscriptions share one aggregate raw-fragment budget", () => {
  const aggregate = new AggregateReceiveBudget(15);
  const first = new ReceiveBudget(limits, aggregate);
  const second = new ReceiveBudget(limits, aggregate);
  expect(first.add("a", 10)).toBe(true);
  expect(second.add("b", 6)).toBe(false);
  expect(second.add("b", 5)).toBe(true);
  first.clear();
  expect(second.add("c", 10)).toBe(true);
});

test("closing a receive budget releases its aggregate allowance", () => {
  const aggregate = new AggregateReceiveBudget(10);
  const first = new ReceiveBudget(limits, aggregate);
  const second = new ReceiveBudget(limits, aggregate);
  expect(first.add("a", 10)).toBe(true);
  expect(second.add("b", 1)).toBe(false);
  first.clear();
  expect(second.add("b", 10)).toBe(true);
});
