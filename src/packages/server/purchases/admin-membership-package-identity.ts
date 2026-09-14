/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";

import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { MAX_COST } from "@cocalc/util/db-schema/purchases";
import { isValidUUID } from "@cocalc/util/misc";
import { moneyRound2Up, moneyToCurrency, toDecimal } from "@cocalc/util/money";
import { canonicalizeBillingValue } from "./canonical-json";

export type AdminMembershipPackageSource = "card" | "credit" | "free";

export interface AdminMembershipPackageBusinessIdentity {
  version: 2;
  admin_account_id: string;
  user_account_id: string;
  product: MembershipPackageProduct;
  custom_price: number;
  source: AdminMembershipPackageSource;
  reason: string;
  idempotency_key: string;
  pricing_note: string | null;
}

function normalizeRequiredText(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw Error(`${name} is required`);
  }
  if (normalized.length > maxLength) {
    throw Error(`${name} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeDate(value: Date | string, name: string): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw Error(`${name} must be a valid date`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw Error(`${name} must be a valid date`);
  }
  return date.toISOString();
}

function canonicalizeLegacyPackageValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeLegacyPackageValue);
  if (value != null && typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return canonicalizeLegacyPackageValue(toJSON.call(value));
    }
    // This reproduces PR #2's persisted v1 encoding. It is read compatibility
    // only; new identities use the locale-independent canonicalizer above.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalizeLegacyPackageValue(item)]),
    );
  }
  return value;
}

function normalizeLegacyPackageProduct(
  product: MembershipPackageProduct,
): MembershipPackageProduct {
  const suppliedProjectId = `${product.course_project_id ?? ""}`.trim();
  if (!suppliedProjectId) {
    if (product.kind === "course") {
      throw Error("course_project_id must be a valid UUID");
    }
    return product.course_project_id == null
      ? product
      : { ...product, course_project_id: undefined };
  }
  const course_project_id = normalizeAdminMembershipPackageUuid(
    suppliedProjectId,
    "course_project_id",
  );
  return course_project_id === product.course_project_id
    ? product
    : { ...product, course_project_id };
}

export function legacyAdminMembershipPackageRequestHash({
  admin_account_id,
  user_account_id,
  product,
  custom_price,
  source,
  reason,
  pricing_note,
}: {
  admin_account_id: string;
  user_account_id: string;
  product: MembershipPackageProduct;
  custom_price: number;
  source: AdminMembershipPackageSource;
  reason: string;
  pricing_note?: string | null;
}): string {
  const legacyProduct = normalizeLegacyPackageProduct(product);
  const productWithCanonicalDates = {
    ...legacyProduct,
    ...(legacyProduct.starts_at == null
      ? {}
      : {
          starts_at: normalizeDate(legacyProduct.starts_at, "starts_at"),
        }),
    ...(legacyProduct.expires_at == null
      ? {}
      : {
          expires_at: normalizeDate(legacyProduct.expires_at, "expires_at"),
        }),
  };
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalizeLegacyPackageValue({
          version: 1,
          admin_account_id,
          user_account_id,
          product: productWithCanonicalDates,
          custom_price,
          source,
          reason,
          pricing_note: pricing_note || null,
        }),
      ),
    )
    .digest("hex");
}

export function normalizeAdminMembershipPackageUuid(
  value: unknown,
  field: string,
): string {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalized)) {
    throw Error(`${field} must be a valid UUID`);
  }
  return normalized;
}

export function normalizeAdminMembershipPackageProduct(
  product: MembershipPackageProduct,
): MembershipPackageProduct {
  if (
    product == null ||
    typeof product !== "object" ||
    Array.isArray(product)
  ) {
    throw Error("product must be an object");
  }
  const membership_class = `${product.membership_class ?? ""}`.trim();
  const suppliedProjectId = `${product.course_project_id ?? ""}`.trim();
  if (!suppliedProjectId) {
    if (product.kind === "course") {
      throw Error("course_project_id must be a valid UUID");
    }
    return {
      ...product,
      membership_class,
      ...(product.course_project_id == null
        ? {}
        : { course_project_id: undefined }),
    };
  }
  const course_project_id = normalizeAdminMembershipPackageUuid(
    suppliedProjectId,
    "course_project_id",
  );
  return {
    ...product,
    membership_class,
    course_project_id,
  };
}

export function normalizeAdminMembershipPackageBusinessIdentity({
  admin_account_id,
  user_account_id,
  product,
  price,
  source,
  reason,
  idempotency_key,
  pricing_note,
}: {
  admin_account_id: unknown;
  user_account_id: unknown;
  product: MembershipPackageProduct;
  price: unknown;
  source: unknown;
  reason: unknown;
  idempotency_key: unknown;
  pricing_note?: unknown;
}): AdminMembershipPackageBusinessIdentity {
  const normalizedAdminAccountId = normalizeAdminMembershipPackageUuid(
    admin_account_id,
    "admin_account_id",
  );
  const normalizedUserAccountId = normalizeAdminMembershipPackageUuid(
    user_account_id,
    "user_account_id",
  );
  const normalizedProduct = normalizeAdminMembershipPackageProduct(product);
  if (source !== "card" && source !== "credit" && source !== "free") {
    throw Error("source must be card, credit, or free");
  }
  const normalizedReason = normalizeRequiredText(reason, "reason", 4000);
  const normalizedIdempotencyKey = normalizeRequiredText(
    idempotency_key,
    "idempotency_key",
    120,
  );
  if (typeof price !== "number" && typeof price !== "string") {
    throw Error("price must be a number");
  }
  let customPrice: ReturnType<typeof moneyRound2Up>;
  try {
    customPrice = moneyRound2Up(toDecimal(price));
  } catch {
    throw Error("price must be a finite nonnegative number");
  }
  if (!Number.isFinite(customPrice.toNumber()) || customPrice.lt(0)) {
    throw Error("price must be a finite nonnegative number");
  }
  if (customPrice.gt(MAX_COST)) {
    throw Error(
      `price exceeds the maximum allowed cost of ${moneyToCurrency(MAX_COST)}`,
    );
  }
  if (pricing_note != null && typeof pricing_note !== "string") {
    throw Error("pricing_note must be a string");
  }
  const productWithCanonicalDates: MembershipPackageProduct = {
    ...normalizedProduct,
    ...(normalizedProduct.starts_at == null
      ? {}
      : {
          starts_at: normalizeDate(normalizedProduct.starts_at, "starts_at"),
        }),
    ...(normalizedProduct.expires_at == null
      ? {}
      : {
          expires_at: normalizeDate(normalizedProduct.expires_at, "expires_at"),
        }),
  };
  return {
    version: 2,
    admin_account_id: normalizedAdminAccountId,
    user_account_id: normalizedUserAccountId,
    product: productWithCanonicalDates,
    custom_price: customPrice.toNumber(),
    source,
    reason: normalizedReason,
    idempotency_key: normalizedIdempotencyKey,
    pricing_note: pricing_note?.trim() || null,
  };
}

export function adminMembershipPackageBusinessIdentityHash(
  identity: AdminMembershipPackageBusinessIdentity,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeBillingValue(identity)))
    .digest("hex");
}

export function adminMembershipPackageInvoiceId(
  adminAccountId: string,
  idempotencyKey: string,
): string {
  const adminId = normalizeAdminMembershipPackageUuid(
    adminAccountId,
    "admin_account_id",
  );
  return `admin-membership-package:${adminId}:${idempotencyKey}`;
}
