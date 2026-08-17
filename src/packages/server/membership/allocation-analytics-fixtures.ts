/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, {
  getTransactionClient,
  type PoolClient,
} from "@cocalc/database/pool";
import type {
  MembershipAllocationBillingInterval,
  MembershipAllocationChannel,
  MembershipAllocationLifecycle,
  MembershipAllocationTierChange,
} from "@cocalc/conat/hub/api/purchases";
import { allocateWholeCentsByDay } from "./allocation-analytics";

export const MEMBERSHIP_ALLOCATION_FIXTURE_BAY = "dev-fixture";
const FIXTURE_SOURCE_KIND = "external-import";
const CONFIRMATION = "replace-dev-fixture";
const DAY_MS = 24 * 60 * 60 * 1000;
const AVERAGE_MONTH_DAYS = 365.2425 / 12;
const AVERAGE_YEAR_DAYS = 365.2425;
const DEFAULT_FUTURE_DAYS = 365;
const MAX_FUTURE_DAYS = 365;
const INSERT_BATCH_SIZE = 1000;

// Development-only behavioral assumptions for synthetic membership journeys.
const PERSONAL_REVENUE_SHARE = 0.92;
const LAUNCH_SIGNUP_RATE_FACTOR = 0.12;
const FUTURE_ANNUAL_SIGNUP_GROWTH = 1.08;
const TRIAL_SHARE = 0.65;
const TRIAL_CONVERSION_RATE = 0.72;
const MONTHLY_CHURN_RATE = 0.025;
const ANNUAL_CHURN_RATE = 0.14;
const MONTHLY_PLAN_CHANGE_RATE = 0.012;
const ANNUAL_PLAN_CHANGE_RATE = 0.06;
const PLAN_CHANGE_UPGRADE_SHARE = 0.75;

export interface MembershipAllocationFixtureTier {
  id: string;
  label: string;
  priority: number;
  price_monthly: number;
  price_yearly: number;
  trial_days: number;
  course_price: number;
  course_duration_days: number;
}

export interface MembershipAllocationFixtureRow {
  day: string;
  bay_id: typeof MEMBERSHIP_ALLOCATION_FIXTURE_BAY;
  channel: MembershipAllocationChannel;
  source_kind: typeof FIXTURE_SOURCE_KIND;
  membership_class: string;
  billing_interval: MembershipAllocationBillingInterval;
  lifecycle: MembershipAllocationLifecycle;
  previous_membership_class: string;
  previous_billing_interval: string;
  tier_change: MembershipAllocationTierChange;
  active_memberships: number;
  purchased_capacity: number;
  revenue_cents: number;
  fact_count: number;
}

export interface GenerateMembershipAllocationFixtureOptions {
  tiers: MembershipAllocationFixtureTier[];
  asOf?: Date | string;
  months?: number;
  futureDays?: number;
  targetMonthlyRevenueCents?: number;
}

export interface MembershipAllocationFixture {
  start: string;
  asOf: string;
  end: string;
  rows: MembershipAllocationFixtureRow[];
  trailing30RevenueCents: number;
  journeyCount: number;
  factCount: number;
}

interface PersonalTier extends MembershipAllocationFixtureTier {
  intervals: Array<{
    interval: "month" | "year";
    price: number;
  }>;
}

interface CliOptions {
  apply: boolean;
  confirmation?: string;
  asOf?: string;
  months: number;
  futureDays: number;
  targetMonthlyRevenue: number;
}

function utcDay(value: Date | string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`invalid fixture date: ${value}`);
  }
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw Error(`${name} must be positive`);
  }
  return value;
}

function normalizedWeights(weights: number[]): number[] {
  const cleaned = weights.map((weight) => Math.max(0, weight));
  const total = cleaned.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return cleaned.map(() => 1 / cleaned.length);
  return cleaned.map((weight) => weight / total);
}

function baseTierWeights(count: number): number[] {
  if (count === 1) return [1];
  if (count === 2) return [0.58, 0.42];
  if (count === 3) return [0.14, 0.5, 0.36];
  if (count === 4) return [0.1, 0.34, 0.35, 0.21];
  return normalizedWeights(
    Array.from({ length: count }, (_, index) => {
      const position = index / Math.max(1, count - 1);
      return 0.5 + Math.sin(Math.PI * position);
    }),
  );
}

type PersonalInterval = "month" | "year";

interface SyntheticPersonalProduct {
  channel: "personal";
  tier: PersonalTier;
  personalTierIndex: number;
  interval: PersonalInterval;
  signupWeight: number;
}

interface SyntheticStudentProduct {
  channel: "direct-student";
  tier: MembershipAllocationFixtureTier;
  interval: "fixed";
  signupWeight: number;
}

type SyntheticProduct = SyntheticPersonalProduct | SyntheticStudentProduct;

interface SyntheticMembershipFact {
  channel: MembershipAllocationChannel;
  tier: string;
  interval: MembershipAllocationBillingInterval;
  lifecycle: MembershipAllocationLifecycle;
  previousMembershipClass: string;
  previousBillingInterval: string;
  tierChange: MembershipAllocationTierChange;
  allocationStart: Date;
  allocationEnd: Date;
  activeMemberships: number;
  purchasedCapacity: number;
  revenueCents: number;
}

interface SyntheticSimulation {
  facts: SyntheticMembershipFact[];
  journeyCount: number;
}

function deterministicUnit(...values: number[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    hash ^= value | 0;
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 16;
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function deterministicDailySignupCount(
  expected: number,
  dayIndex: number,
): number {
  if (!(expected > 0)) return 0;
  const first = Math.max(Number.EPSILON, deterministicUnit(dayIndex, 0x9271));
  const second = deterministicUnit(dayIndex, 0x1f35);
  const normal =
    Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  const deviation = 2.5 * Math.sqrt(expected);
  return Math.max(
    0,
    Math.min(
      Math.ceil(expected + deviation),
      Math.max(
        Math.floor(expected - deviation),
        Math.round(expected + Math.sqrt(expected) * normal),
      ),
    ),
  );
}

function weightedIndex(weights: number[], value: number): number {
  let cumulative = 0;
  for (let index = 0; index < weights.length; index += 1) {
    cumulative += weights[index];
    if (value < cumulative) return index;
  }
  return weights.length - 1;
}

function deterministicRound(expected: number, ...seed: number[]): number {
  const whole = Math.floor(expected);
  return whole + (deterministicUnit(...seed) < expected - whole ? 1 : 0);
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.valueOf() + days * DAY_MS);
}

function addUtcMonths(value: Date, months: number): Date {
  const monthIndex = value.getUTCMonth() + months;
  const year = value.getUTCFullYear() + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(value.getUTCDate(), lastDay)));
}

function personalPeriodEnd(value: Date, interval: PersonalInterval): Date {
  return addUtcMonths(value, interval === "month" ? 1 : 12);
}

function intervalRevenueWeights(
  tierIndex: number,
  tierCount: number,
  intervals: PersonalTier["intervals"],
): number[] {
  if (intervals.length === 1) return [1];
  const rank = tierIndex / Math.max(1, tierCount - 1);
  const annualShare = Math.min(0.78, 0.5 + 0.22 * rank);
  return intervals.map(({ interval }) =>
    interval === "year" ? annualShare : 1 - annualShare,
  );
}

function buildProducts({
  personalTiers,
  courseTiers,
}: {
  personalTiers: PersonalTier[];
  courseTiers: MembershipAllocationFixtureTier[];
}): SyntheticProduct[] {
  const products: SyntheticProduct[] = [];
  const personalChannelShare =
    personalTiers.length === 0
      ? 0
      : courseTiers.length === 0
        ? 1
        : PERSONAL_REVENUE_SHARE;
  const courseChannelShare =
    courseTiers.length === 0
      ? 0
      : personalTiers.length === 0
        ? 1
        : 1 - PERSONAL_REVENUE_SHARE;
  const personalTierShares = baseTierWeights(personalTiers.length);
  personalTiers.forEach((tier, tierIndex) => {
    const intervalShares = intervalRevenueWeights(
      tierIndex,
      personalTiers.length,
      tier.intervals,
    );
    tier.intervals.forEach(({ interval, price }, intervalIndex) => {
      const monthlyEquivalent = interval === "year" ? price / 12 : price;
      products.push({
        channel: "personal",
        tier,
        personalTierIndex: tierIndex,
        interval,
        signupWeight:
          (personalChannelShare *
            personalTierShares[tierIndex] *
            intervalShares[intervalIndex]) /
          monthlyEquivalent,
      });
    });
  });
  const courseTierShares = baseTierWeights(courseTiers.length);
  courseTiers.forEach((tier, tierIndex) => {
    const monthlyEquivalent =
      (tier.course_price * AVERAGE_MONTH_DAYS) / tier.course_duration_days;
    products.push({
      channel: "direct-student",
      tier,
      interval: "fixed",
      signupWeight:
        (courseChannelShare * courseTierShares[tierIndex]) / monthlyEquivalent,
    });
  });
  const normalized = normalizedWeights(
    products.map(({ signupWeight }) => signupWeight),
  );
  return products.map((product, index) => ({
    ...product,
    signupWeight: normalized[index],
  }));
}

function signupRateFactor(dayIndex: number, asOfIndex: number): number {
  if (dayIndex > asOfIndex) {
    return Math.pow(
      FUTURE_ANNUAL_SIGNUP_GROWTH,
      (dayIndex - asOfIndex) / AVERAGE_YEAR_DAYS,
    );
  }
  const progress = Math.max(0, Math.min(1, dayIndex / asOfIndex));
  const smooth =
    progress * progress * progress * (progress * (progress * 6 - 15) + 10);
  return LAUNCH_SIGNUP_RATE_FACTOR + (1 - LAUNCH_SIGNUP_RATE_FACTOR) * smooth;
}

const WEEKDAY_SIGNUP_FACTORS = [0.72, 1.16, 1.13, 1.1, 1.07, 1.02, 0.8];

function priceCents(tier: PersonalTier, interval: PersonalInterval): number {
  const price = tier.intervals.find(
    (candidate) => candidate.interval === interval,
  )?.price;
  if (!(price && price > 0)) {
    throw Error(`tier ${tier.id} does not support ${interval} billing`);
  }
  return Math.round(price * 100);
}

function simulatePersonalJourney({
  facts,
  start,
  horizonEnd,
  dayIndex,
  ordinal,
  productIndex,
  productOrdinal,
  productCount,
  initialTierIndex,
  initialInterval,
  tiers,
}: {
  facts: SyntheticMembershipFact[];
  start: Date;
  horizonEnd: Date;
  dayIndex: number;
  ordinal: number;
  productIndex: number;
  productOrdinal: number;
  productCount: number;
  initialTierIndex: number;
  initialInterval: PersonalInterval;
  tiers: PersonalTier[];
}): void {
  let tierIndex = initialTierIndex;
  let interval = initialInterval;
  let periodStart = start;
  const initialTier = tiers[tierIndex];
  const trialCount = deterministicRound(
    productCount * TRIAL_SHARE,
    dayIndex,
    productIndex,
    0x7101,
  );
  if (initialTier.trial_days > 0 && productOrdinal < trialCount) {
    const trialEnd = addUtcDays(periodStart, initialTier.trial_days);
    facts.push({
      channel: "personal",
      tier: initialTier.id,
      interval: "trial",
      lifecycle: "trial",
      previousMembershipClass: "",
      previousBillingInterval: "",
      tierChange: "none",
      allocationStart: periodStart,
      allocationEnd: trialEnd,
      activeMemberships: 1,
      purchasedCapacity: 0,
      revenueCents: 0,
    });
    const convertedCount = deterministicRound(
      trialCount * TRIAL_CONVERSION_RATE,
      dayIndex,
      productIndex,
      0x7102,
    );
    if (productOrdinal >= convertedCount) return;
    periodStart = trialEnd;
  }

  let lifecycle: MembershipAllocationLifecycle = "first_paid";
  let previousMembershipClass = "";
  let previousBillingInterval = "";
  let tierChange: MembershipAllocationTierChange = "none";
  let periodNumber = 0;
  while (periodStart < horizonEnd) {
    const tier = tiers[tierIndex];
    const periodEnd = personalPeriodEnd(periodStart, interval);
    facts.push({
      channel: "personal",
      tier: tier.id,
      interval,
      lifecycle,
      previousMembershipClass,
      previousBillingInterval,
      tierChange,
      allocationStart: periodStart,
      allocationEnd: periodEnd,
      activeMemberships: 1,
      purchasedCapacity: 0,
      revenueCents: priceCents(tier, interval),
    });
    if (periodEnd >= horizonEnd) return;

    const churnProbability =
      interval === "month" ? MONTHLY_CHURN_RATE : ANNUAL_CHURN_RATE;
    if (
      deterministicUnit(dayIndex, ordinal, periodNumber, 0xc101) <
      churnProbability
    ) {
      return;
    }

    const oldTierIndex = tierIndex;
    const oldInterval = interval;
    const changeProbability =
      interval === "month" ? MONTHLY_PLAN_CHANGE_RATE : ANNUAL_PLAN_CHANGE_RATE;
    if (
      tiers.length > 1 &&
      deterministicUnit(dayIndex, ordinal, periodNumber, 0xc102) <
        changeProbability
    ) {
      const canUpgrade = tierIndex + 1 < tiers.length;
      const canDowngrade = tierIndex > 0;
      const upgrade =
        canUpgrade &&
        (!canDowngrade ||
          deterministicUnit(dayIndex, ordinal, periodNumber, 0xc103) <
            PLAN_CHANGE_UPGRADE_SHARE);
      tierIndex += upgrade ? 1 : -1;
      const nextTier = tiers[tierIndex];
      if (
        !nextTier.intervals.some((candidate) => candidate.interval === interval)
      ) {
        interval = nextTier.intervals[0].interval;
      }
      lifecycle = "plan_change";
      previousMembershipClass = tiers[oldTierIndex].id;
      previousBillingInterval = oldInterval;
      tierChange = upgrade ? "upgrade" : "downgrade";
    } else {
      lifecycle = "renewal";
      previousMembershipClass = "";
      previousBillingInterval = "";
      tierChange = "none";
    }
    periodStart = periodEnd;
    periodNumber += 1;
  }
}

function simulateMembershipJourneys({
  startDay,
  endDay,
  asOfIndex,
  asOfSignupRate,
  products,
  personalTiers,
}: {
  startDay: Date;
  endDay: Date;
  asOfIndex: number;
  asOfSignupRate: number;
  products: SyntheticProduct[];
  personalTiers: PersonalTier[];
}): SyntheticSimulation {
  const facts: SyntheticMembershipFact[] = [];
  const horizonEnd = addUtcDays(endDay, 1);
  const productWeights = products.map(({ signupWeight }) => signupWeight);
  const dayCount = Math.round((endDay.valueOf() - startDay.valueOf()) / DAY_MS);
  let journeyCount = 0;
  for (let dayIndex = 0; dayIndex <= dayCount; dayIndex += 1) {
    const start = addUtcDays(startDay, dayIndex);
    const expectedSignups =
      asOfSignupRate *
      signupRateFactor(dayIndex, asOfIndex) *
      WEEKDAY_SIGNUP_FACTORS[start.getUTCDay()];
    const signups = deterministicDailySignupCount(expectedSignups, dayIndex);
    const productOffset = deterministicUnit(dayIndex, 0x3107);
    const productIndices = Array.from({ length: signups }, (_, ordinal) =>
      weightedIndex(productWeights, (ordinal + productOffset) / signups),
    );
    const productCounts = new Map<number, number>();
    for (const productIndex of productIndices) {
      productCounts.set(
        productIndex,
        (productCounts.get(productIndex) ?? 0) + 1,
      );
    }
    const productOrdinals = new Map<number, number>();
    for (let ordinal = 0; ordinal < signups; ordinal += 1) {
      journeyCount += 1;
      const productIndex = productIndices[ordinal];
      const product = products[productIndex];
      const productOrdinal = productOrdinals.get(productIndex) ?? 0;
      const productCount = productCounts.get(productIndex);
      if (productCount == null) {
        throw Error("synthetic product count was not initialized");
      }
      productOrdinals.set(productIndex, productOrdinal + 1);
      if (product.channel === "direct-student") {
        facts.push({
          channel: "direct-student",
          tier: product.tier.id,
          interval: "fixed",
          lifecycle: "first_paid",
          previousMembershipClass: "",
          previousBillingInterval: "",
          tierChange: "none",
          allocationStart: start,
          allocationEnd: addUtcDays(start, product.tier.course_duration_days),
          activeMemberships: 1,
          purchasedCapacity: 1,
          revenueCents: Math.round(product.tier.course_price * 100),
        });
      } else {
        simulatePersonalJourney({
          facts,
          start,
          horizonEnd,
          dayIndex,
          ordinal,
          productIndex,
          productOrdinal,
          productCount,
          initialTierIndex: product.personalTierIndex,
          initialInterval: product.interval,
          tiers: personalTiers,
        });
      }
    }
  }
  return { facts, journeyCount };
}

function aggregateMembershipFacts({
  facts,
  startDay,
  endDay,
}: {
  facts: SyntheticMembershipFact[];
  startDay: Date;
  endDay: Date;
}): MembershipAllocationFixtureRow[] {
  const firstDay = dateKey(startDay);
  const lastDay = dateKey(endDay);
  const rows = new Map<string, MembershipAllocationFixtureRow>();
  for (const fact of facts) {
    const allocations = allocateWholeCentsByDay({
      allocation_start: fact.allocationStart,
      allocation_end: fact.allocationEnd,
      revenue_cents: fact.revenueCents,
    });
    for (const allocation of allocations) {
      if (allocation.day < firstDay || allocation.day > lastDay) continue;
      const key = [
        allocation.day,
        fact.channel,
        fact.tier,
        fact.interval,
        fact.lifecycle,
        fact.previousMembershipClass,
        fact.previousBillingInterval,
        fact.tierChange,
      ].join("\0");
      const row = rows.get(key);
      if (row) {
        row.active_memberships += fact.activeMemberships;
        row.purchased_capacity += fact.purchasedCapacity;
        row.revenue_cents += allocation.revenue_cents;
        row.fact_count += 1;
      } else {
        rows.set(key, {
          day: allocation.day,
          bay_id: MEMBERSHIP_ALLOCATION_FIXTURE_BAY,
          channel: fact.channel,
          source_kind: FIXTURE_SOURCE_KIND,
          membership_class: fact.tier,
          billing_interval: fact.interval,
          lifecycle: fact.lifecycle,
          previous_membership_class: fact.previousMembershipClass,
          previous_billing_interval: fact.previousBillingInterval,
          tier_change: fact.tierChange,
          active_memberships: fact.activeMemberships,
          purchased_capacity: fact.purchasedCapacity,
          revenue_cents: allocation.revenue_cents,
          fact_count: 1,
        });
      }
    }
  }
  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

function allocatedRevenueBetween({
  fact,
  startDay,
  endDay,
}: {
  fact: SyntheticMembershipFact;
  startDay: Date;
  endDay: Date;
}): number {
  const factStart = Math.round(fact.allocationStart.valueOf() / DAY_MS);
  const factEnd = Math.round(fact.allocationEnd.valueOf() / DAY_MS);
  const rangeStart = Math.round(startDay.valueOf() / DAY_MS);
  const rangeEnd = Math.round(endDay.valueOf() / DAY_MS);
  const overlapStart = Math.max(factStart, rangeStart);
  const overlapEnd = Math.min(factEnd, rangeEnd);
  if (overlapStart >= overlapEnd) return 0;
  const duration = factEnd - factStart;
  const sign = fact.revenueCents < 0 ? -1 : 1;
  const revenue = Math.abs(fact.revenueCents);
  const base = Math.floor(revenue / duration);
  const remainder = revenue % duration;
  const firstOffset = overlapStart - factStart;
  const lastOffset = overlapEnd - factStart;
  const extraDays = Math.max(0, Math.min(lastOffset, remainder) - firstOffset);
  return sign * (base * (overlapEnd - overlapStart) + extraDays);
}

function trailingRevenueCents({
  facts,
  asOfDay,
}: {
  facts: SyntheticMembershipFact[];
  asOfDay: Date;
}): number {
  const firstDay = addUtcDays(asOfDay, -29);
  const endDay = addUtcDays(asOfDay, 1);
  return facts.reduce(
    (sum, fact) =>
      sum + allocatedRevenueBetween({ fact, startDay: firstDay, endDay }),
    0,
  );
}

export function generateMembershipAllocationFixture({
  tiers,
  asOf = new Date(),
  months = 30,
  futureDays = DEFAULT_FUTURE_DAYS,
  targetMonthlyRevenueCents = 10_000_000,
}: GenerateMembershipAllocationFixtureOptions): MembershipAllocationFixture {
  positiveInteger(months, "months");
  positiveInteger(futureDays, "futureDays");
  if (futureDays > MAX_FUTURE_DAYS) {
    throw Error(`futureDays must not exceed ${MAX_FUTURE_DAYS}`);
  }
  positiveInteger(targetMonthlyRevenueCents, "targetMonthlyRevenueCents");
  const asOfDay = utcDay(asOf);
  const startDay = new Date(
    Date.UTC(asOfDay.getUTCFullYear(), asOfDay.getUTCMonth() - (months - 1), 1),
  );
  const historicalDayCount =
    Math.floor((asOfDay.valueOf() - startDay.valueOf()) / DAY_MS) + 1;
  if (historicalDayCount < 30) {
    throw Error("membership fixture must include at least 30 days");
  }
  const asOfIndex = historicalDayCount - 1;
  const endDay = addUtcDays(asOfDay, futureDays);

  const courseTiers = tiers
    .filter(
      ({ course_price, course_duration_days }) =>
        course_price > 0 && course_duration_days > 0,
    )
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const courseIds = new Set(courseTiers.map(({ id }) => id));
  const personalTiers: PersonalTier[] = tiers
    .filter(({ id }) => !courseIds.has(id))
    .map((tier) => ({
      ...tier,
      intervals: [
        ...(tier.price_monthly > 0
          ? [{ interval: "month" as const, price: tier.price_monthly }]
          : []),
        ...(tier.price_yearly > 0
          ? [{ interval: "year" as const, price: tier.price_yearly }]
          : []),
      ],
    }))
    .filter(({ intervals }) => intervals.length > 0)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (personalTiers.length === 0 && courseTiers.length === 0) {
    throw Error("no enabled paid membership tiers are configured");
  }
  const products = buildProducts({ personalTiers, courseTiers });

  // Calibrate only the signup rate. Membership continuity, churn, renewals,
  // plan changes, and recognized revenue all remain consequences of the same
  // deterministic synthetic journeys.
  let asOfSignupRate = Math.max(0.1, targetMonthlyRevenueCents / 2_000_000);
  let best:
    | {
        asOfSignupRate: number;
        trailing30RevenueCents: number;
        error: number;
      }
    | undefined;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const simulation = simulateMembershipJourneys({
      startDay,
      endDay: asOfDay,
      asOfIndex,
      asOfSignupRate,
      products,
      personalTiers,
    });
    const trailing30 = trailingRevenueCents({
      facts: simulation.facts,
      asOfDay,
    });
    const error = Math.abs(trailing30 - targetMonthlyRevenueCents);
    if (best == null || error < best.error) {
      best = {
        asOfSignupRate,
        trailing30RevenueCents: trailing30,
        error,
      };
    }
    if (error / targetMonthlyRevenueCents <= 0.02) break;
    asOfSignupRate *=
      trailing30 <= 0
        ? 2
        : Math.max(0.5, Math.min(2, targetMonthlyRevenueCents / trailing30));
  }
  if (best == null) throw Error("membership fixture simulation failed");
  const simulation = simulateMembershipJourneys({
    startDay,
    endDay,
    asOfIndex,
    asOfSignupRate: best.asOfSignupRate,
    products,
    personalTiers,
  });
  const rows = aggregateMembershipFacts({
    facts: simulation.facts,
    startDay,
    endDay,
  });

  return {
    start: dateKey(startDay),
    asOf: dateKey(asOfDay),
    end: dateKey(endDay),
    rows,
    trailing30RevenueCents: best.trailing30RevenueCents,
    journeyCount: simulation.journeyCount,
    factCount: simulation.facts.length,
  };
}

export async function replaceMembershipAllocationFixture({
  rows,
  client,
}: {
  rows: MembershipAllocationFixtureRow[];
  client: Pick<PoolClient, "query">;
}): Promise<void> {
  await client.query(
    `DELETE FROM membership_daily_allocations WHERE bay_id=$1`,
    [MEMBERSHIP_ALLOCATION_FIXTURE_BAY],
  );
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    await client.query(
      `INSERT INTO membership_daily_allocations
         (day, bay_id, channel, source_kind, membership_class,
          billing_interval, lifecycle, previous_membership_class,
          previous_billing_interval, tier_change, active_memberships,
          purchased_capacity, revenue_cents, fact_count)
       SELECT day, $2, channel, $3, membership_class, billing_interval,
              lifecycle, previous_membership_class,
              previous_billing_interval, tier_change, active_memberships,
              purchased_capacity, revenue_cents, fact_count
         FROM UNNEST(
           $1::date[], $4::text[], $5::text[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::text[], $11::integer[],
           $12::integer[], $13::bigint[], $14::integer[]
         ) AS fixture_rows(
           day, channel, membership_class, billing_interval, lifecycle,
           previous_membership_class, previous_billing_interval, tier_change,
           active_memberships, purchased_capacity, revenue_cents, fact_count
         )`,
      [
        batch.map(({ day }) => day),
        MEMBERSHIP_ALLOCATION_FIXTURE_BAY,
        FIXTURE_SOURCE_KIND,
        batch.map(({ channel }) => channel),
        batch.map(({ membership_class }) => membership_class),
        batch.map(({ billing_interval }) => billing_interval),
        batch.map(({ lifecycle }) => lifecycle),
        batch.map(({ previous_membership_class }) => previous_membership_class),
        batch.map(({ previous_billing_interval }) => previous_billing_interval),
        batch.map(({ tier_change }) => tier_change),
        batch.map(({ active_memberships }) => active_memberships),
        batch.map(({ purchased_capacity }) => purchased_capacity),
        batch.map(({ revenue_cents }) => revenue_cents),
        batch.map(({ fact_count }) => fact_count),
      ],
    );
  }
}

async function configuredTiers(
  client: Pick<PoolClient, "query">,
): Promise<MembershipAllocationFixtureTier[]> {
  const { rows } = await client.query<{
    id: string;
    label: string | null;
    priority: number | string | null;
    price_monthly: number | string | null;
    price_yearly: number | string | null;
    trial_days: number | string | null;
    course_price: number | string | null;
    course_duration_days: number | string | null;
  }>(
    `SELECT id, label, priority, price_monthly, price_yearly, trial_days,
            course_price, course_duration_days
       FROM membership_tiers
      WHERE NOT COALESCE(disabled, FALSE)
      ORDER BY priority, id`,
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label || row.id,
    priority: Number(row.priority ?? 0),
    price_monthly: Number(row.price_monthly ?? 0),
    price_yearly: Number(row.price_yearly ?? 0),
    trial_days: Number(row.trial_days ?? 0),
    course_price: Number(row.course_price ?? 0),
    course_duration_days: Number(row.course_duration_days ?? 0),
  }));
}

function usage(): never {
  process.stdout.write(`Usage:
  node packages/server/dist/membership/allocation-analytics-fixtures.js [options]

Options:
  --apply                         Replace dev-fixture daily allocation rows.
  --confirm ${CONFIRMATION}   Required with --apply.
  --months <count>                Historical calendar months. Default: 30.
  --as-of <YYYY-MM-DD>            Current/reference day. Default: today.
  --future-days <count>           Days after as-of to generate. Default: 365.
  --target-monthly-revenue <amount>
                                  As-of trailing-30-day revenue. Default: $100,000.
  --help                          Show this help.

Without --apply, the script reads configured tiers and prints a dry-run summary.
`);
  process.exit(0);
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    months: 30,
    futureDays: DEFAULT_FUTURE_DAYS,
    targetMonthlyRevenue: 100_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    const value = argv[++index];
    if (value == null || value.startsWith("--")) {
      throw Error(`missing value for ${arg}`);
    }
    if (arg === "--confirm") {
      options.confirmation = value;
    } else if (arg === "--months") {
      options.months = positiveInteger(Number(value), arg);
    } else if (arg === "--as-of") {
      options.asOf = dateKey(utcDay(value));
    } else if (arg === "--future-days") {
      options.futureDays = positiveInteger(Number(value), arg);
    } else if (arg === "--target-monthly-revenue") {
      options.targetMonthlyRevenue = positiveNumber(Number(value), arg);
    } else {
      throw Error(`unknown argument ${arg}`);
    }
  }
  if (options.apply && options.confirmation !== CONFIRMATION) {
    throw Error(`--apply requires --confirm ${CONFIRMATION}`);
  }
  if (options.apply && process.env.NODE_ENV === "production") {
    throw Error("membership analytics fixtures cannot run in production");
  }
  return options;
}

async function assertLocalDatabase(client: Pick<PoolClient, "query">) {
  const { rows } = await client.query<{
    database_name: string;
    server_address: string | null;
  }>(
    `SELECT current_database() AS database_name,
            inet_server_addr()::text AS server_address`,
  );
  const { database_name, server_address } = rows[0];
  if (
    server_address != null &&
    server_address !== "127.0.0.1" &&
    server_address !== "::1"
  ) {
    throw Error(
      `refusing to replace fixtures on non-local database ${database_name} at ${server_address}`,
    );
  }
}

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const client = await getTransactionClient();
  try {
    await assertLocalDatabase(client);
    const tiers = await configuredTiers(client);
    const fixture = generateMembershipAllocationFixture({
      tiers,
      asOf: options.asOf,
      months: options.months,
      futureDays: options.futureDays,
      targetMonthlyRevenueCents: Math.round(options.targetMonthlyRevenue * 100),
    });
    const usedTierIds = [
      ...new Set(fixture.rows.map(({ membership_class }) => membership_class)),
    ];
    process.stdout.write(
      `${options.apply ? "Replacing" : "Would replace"} ${fixture.rows.length.toLocaleString()} daily allocation rows\n` +
        `Range: ${fixture.start} through ${fixture.end}\n` +
        `As of: ${fixture.asOf}\n` +
        `Tiers: ${usedTierIds.join(", ")}\n` +
        `Synthetic journeys: ${fixture.journeyCount.toLocaleString()} (${fixture.factCount.toLocaleString()} period facts)\n` +
        `As-of trailing-30-day revenue: ${dollars(fixture.trailing30RevenueCents)}\n`,
    );
    if (options.apply) {
      await replaceMembershipAllocationFixture({ rows: fixture.rows, client });
      await client.query("COMMIT");
      process.stdout.write(
        "Development membership analytics fixture replaced.\n",
      );
    } else {
      await client.query("ROLLBACK");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPool().end();
    });
}
