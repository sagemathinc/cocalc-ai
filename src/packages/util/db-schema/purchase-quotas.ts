import type { Service } from "./purchases";

export type { Service };

const SERVICE_CATEGORIES = ["money", "license", "metered"];
type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface Spec {
  display: string; // what to show user to describe this service
  noSet?: boolean; // if true, then no spend limits are set for this.
  color: string;
  category: ServiceCategory;
  // tooltip more detailed description
  description?: string;
}

export type QuotaSpec = Record<Service, Spec>;

// for each category of service, this says whether or not it is a pay as you go service,
// which can impact how spend options are determined.
const IS_PAYG: { [name: ServiceCategory]: boolean } = {
  money: false,
  license: false,
  metered: true,
} as const;

export function isPaygService(service: Service): boolean {
  const category = QUOTA_SPEC[service]?.category;
  return IS_PAYG[category ?? ""] ?? false;
}

export const QUOTA_SPEC: QuotaSpec = {
  credit: {
    display: "Credit",
    noSet: true,
    color: "green",
    category: "money",
    description:
      "Credit that was added to your account as a result of a manual or subscription payment (e.g., from a credit card)",
  },
  "auto-credit": {
    display: "Automatic Credit",
    noSet: true,
    color: "green",
    category: "money",
    description:
      "Credited that was automatically added to your account as a result of a payment because of your balance became low.",
  },
  refund: {
    display: "Refund",
    noSet: true,
    color: "red",
    category: "money",
    description:
      "Money that was refunded to your account as a result of a support request.",
  },
  membership: {
    display: "Membership",
    color: "cyan",
    noSet: true,
    category: "license",
    description: "Charge for a membership subscription.",
  },
  "dedicated-host": {
    display: "Dedicated Host",
    color: "volcano",
    noSet: true,
    category: "metered",
    description: "Metered charge for dedicated-host compute usage.",
  },
  "student-pay": {
    display: "Course Fee",
    color: "cyan",
    noSet: true,
    category: "money",
    description: "Charge for a course fee paid by a student.",
  },
} as const;

export function serviceToDisplay(service: Service): string {
  return QUOTA_SPEC[service]?.display ?? service;
}
