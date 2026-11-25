import { isIsoTime, isoTimeSql } from "./claude-usage-sql";

// The truth: what toISOString writes back for what Date.parse reads.
const roundTrips = (s: string) => {
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s;
};

test("isIsoTime is exactly toISOString's round trip for every day", () => {
  const pad = (n: number, w = 2) => `${n}`.padStart(w, "0");
  let checked = 0;
  for (const year of [0, 1900, 1999, 2000, 2024, 2025, 2026, 2100, 2400, 9999])
    for (let month = 0; month <= 13; month++)
      for (let day = 0; day <= 32; day++) {
        const s = `${pad(year, 4)}-${pad(month)}-${pad(day)}T12:34:56.789Z`;
        expect([s, isIsoTime(s)]).toEqual([s, roundTrips(s)]);
        checked += 1;
      }
  expect(checked).toBeGreaterThan(4000);
});

test("times: only toISOString's form counts", () => {
  for (const s of [
    "2026-11-19T00:00:00.000Z",
    "2026-11-19T23:59:59.999Z",
    "2024-02-29T10:00:00.000Z",
  ]) {
    expect(isIsoTime(s)).toBe(true);
    expect(roundTrips(s)).toBe(true);
  }
  for (const s of [
    "2026-11-19T24:00:00.000Z",
    "2026-11-19T23:60:00.000Z",
    "2026-11-19T23:59:60.000Z",
    "2026-11-19T20:00:00Z",
    "2026-11-19T20:00:00.1Z",
    "2026-11-19T20:00:00.1234Z",
    "2026-11-19T20:00:00.000+00:00",
    "2026-02-30T00:00:00.000Z",
    "2026-02-29T00:00:00.000Z",
    "9999-99-99T99:99:99.000Z",
    " 2026-11-19T20:00:00.000Z",
    "zzzz",
  ]) {
    expect([s, isIsoTime(s)]).toEqual([s, false]);
    expect([s, roundTrips(s)]).toEqual([s, false]);
  }
  // toISOString writes years past 9999 with a sign; they are not times here
  // (in code or in SQL).
  expect(isIsoTime("+010000-01-01T00:00:00.000Z")).toBe(false);
  for (const value of [undefined, null, 5, {}, ["2026-11-19T20:00:00.000Z"]])
    expect(isIsoTime(value)).toBe(false);
});

test("the SQL form uses the same pattern", () => {
  expect(isoTimeSql("(x)")).toMatch(
    /^\(CASE WHEN \(x\) ~ '\^.*\$' THEN \(x\) ELSE '' END\)$/,
  );
});
