import { SearchAdmission } from "../search-admission";

test("one account cannot monopolize host slots, and rejected admission does not leak slots", () => {
  const gate = new SearchAdmission();
  const a = gate.acquire("a");
  for (let i = 0; i < 200; i++)
    expect(() => gate.acquire("a")).toThrow("Account search is busy");
  const b = gate.acquire("b");
  const c = gate.acquire("c");
  expect(() => gate.acquire("d")).toThrow("host search capacity");
  a();
  a(); // release is idempotent
  const d = gate.acquire("d");
  expect(() => gate.acquire("e")).toThrow("host search capacity");
  b();
  c();
  d();
});

test("account rate limits persist after completion and expire independently", () => {
  let now = 0;
  const gate = new SearchAdmission(() => now);
  for (let i = 0; i < 150; i++) gate.acquire("a")();
  expect(() => gate.acquire("a")).toThrow("rate limit");
  gate.acquire("b")();
  now = 60_000;
  gate.acquire("a")();
});

test("accounting is bounded without evicting unexpired rate limits", () => {
  let now = 0;
  const gate = new SearchAdmission(() => now);
  for (let i = 0; i < 10_000; i++) gate.acquire(`${i}`)();
  expect(() => gate.acquire("new")).toThrow("accounting is busy");
  now = 60_000;
  gate.acquire("new")();
});

test("missing or oversized principal fails closed", () => {
  const gate = new SearchAdmission();
  for (const account of [undefined, "", " ", "a".repeat(201)])
    expect(() => gate.acquire(account as string)).toThrow(
      "authenticated principal",
    );
});

test("slow repeated searches exhaust an account execution budget, not another account's", () => {
  let now = 0;
  const gate = new SearchAdmission(() => now);
  for (let i = 0; i < 2; i++) {
    const release = gate.acquire("slow");
    now += 6000;
    release();
  }
  expect(() => gate.acquire("slow")).toThrow("rate limit");
  gate.acquire("other")();
  now = 60_000;
  gate.acquire("slow")();
});
