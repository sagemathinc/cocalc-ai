/*
 *  Membership tiers configuration.
 */

import {
  Table,
  MembershipTierGetFields,
  MembershipTierSetFields,
} from "./types";

async function instead_of_query(db, opts: any, cb: Function): Promise<void> {
  const { options, query } = opts;
  try {
    cb(undefined, await db.membershipTiers(options, query));
  } catch (err) {
    cb(err);
  }
}

Table({
  name: "membership_tiers",
  rules: {
    primary_key: "id",
    anonymous: false,
    user_query: {
      set: {
        admin: true,
        instead_of_query,
        delete: true,
        fields: {
          id: null,
          label: null,
          store_visible: null,
          store_description: null,
          store_highlights: null,
          site_license_pool_description: null,
          team_visible: null,
          course_store_visible: null,
          course_allowed_domains: null,
          priority: null,
          price_monthly: null,
          price_yearly: null,
          trial_days: null,
          course_price: null,
          course_duration_days: null,
          course_grace_days: null,
          project_defaults: null,
          ai_limits: null,
          features: null,
          usage_limits: null,
          pricing_model: null,
          disabled: null,
          notes: null,
        } as { [key in MembershipTierSetFields]: null },
      },
      get: {
        admin: true,
        instead_of_query,
        pg_where: [],
        fields: {
          id: null,
          label: null,
          store_visible: null,
          store_description: null,
          store_highlights: null,
          site_license_pool_description: null,
          team_visible: null,
          course_store_visible: null,
          course_allowed_domains: null,
          priority: null,
          price_monthly: null,
          price_yearly: null,
          trial_days: null,
          course_price: null,
          course_duration_days: null,
          course_grace_days: null,
          project_defaults: null,
          ai_limits: null,
          features: null,
          usage_limits: null,
          pricing_model: null,
          disabled: null,
          notes: null,
          history: null,
          subscription_count: null,
          subscribed_account_count: null,
          team_seat_count: null,
          team_account_count: null,
          course_account_count: null,
          site_account_count: null,
          admin_assigned_count: null,
          site_license_count: null,
          total_account_count: null,
          has_usage_history: null,
          created: null,
          updated: null,
        } as { [key in MembershipTierGetFields]: null },
      },
    },
  },
  fields: {
    id: {
      type: "string",
      desc: "Unique membership tier id (slug).",
    },
    label: {
      type: "string",
      desc: "Display name for this tier.",
    },
    store_visible: {
      type: "boolean",
      desc: "Whether to show this tier in public pricing and purchase UI.",
    },
    store_description: {
      type: "string",
      desc: "Short public description shown on pricing and purchase cards.",
    },
    store_highlights: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "Public pricing and purchase bullet points, one short string per item.",
    },
    site_license_pool_description: {
      type: "string",
      desc: "Default description copied into site-license pools using this tier.",
    },
    team_visible: {
      type: "boolean",
      desc: "Whether this tier can be selected for team licenses.",
    },
    course_store_visible: {
      type: "boolean",
      desc: "Whether this tier can be selected as a course student membership.",
    },
    course_allowed_domains: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "Optional verified instructor email domains allowed to select this course student membership tier. Empty means any verified or unverified instructor can select it.",
    },
    priority: {
      type: "number",
      desc: "Priority for resolving multiple eligible tiers (higher wins).",
    },
    price_monthly: {
      type: "number",
      desc: "Monthly price in USD.",
      pg_type: "numeric(20,10)",
    },
    price_yearly: {
      type: "number",
      desc: "Yearly price in USD.",
      pg_type: "numeric(20,10)",
    },
    trial_days: {
      type: "number",
      desc: "Number of free-trial days for new self-serve subscription purchases of this tier. Zero or null means no trial.",
    },
    course_price: {
      type: "number",
      desc: "One-time course student membership price in USD.",
      pg_type: "numeric(20,10)",
    },
    course_duration_days: {
      type: "number",
      desc: "Duration in days for one-time course student memberships.",
    },
    course_grace_days: {
      type: "number",
      desc: "Default full-access grace period in days before course student membership payment is required.",
    },
    project_defaults: {
      type: "map",
      desc: "Default project quota settings applied by membership.",
    },
    ai_limits: {
      type: "map",
      desc: "AI usage limits for this tier.",
    },
    features: {
      type: "map",
      desc: "Feature flags for this tier.",
    },
    usage_limits: {
      type: "map",
      desc: "Shared-host usage-limit policy for this tier.",
    },
    pricing_model: {
      type: "map",
      desc: "Admin pricing and risk assumptions for this tier.",
    },
    disabled: {
      type: "boolean",
      desc: "If true, this tier is not eligible for resolution.",
    },
    notes: {
      type: "string",
      desc: "Optional admin notes.",
    },
    history: {
      type: "map",
      desc: "JSON array of previous versions of this tier.",
    },
    subscription_count: {
      type: "number",
      desc: "Number of active paid subscriptions using this tier.",
    },
    subscribed_account_count: {
      type: "number",
      desc: "Number of accounts with active paid subscriptions using this tier.",
    },
    team_seat_count: {
      type: "number",
      desc: "Number of active purchased team-license seats using this tier.",
    },
    team_account_count: {
      type: "number",
      desc: "Number of distinct accounts assigned active team-license seats using this tier.",
    },
    course_account_count: {
      type: "number",
      desc: "Number of distinct accounts assigned active course membership seats using this tier.",
    },
    site_account_count: {
      type: "number",
      desc: "Number of distinct accounts with active claimed site-license seats using this tier.",
    },
    admin_assigned_count: {
      type: "number",
      desc: "Number of active admin-assigned memberships using this tier.",
    },
    site_license_count: {
      type: "number",
      desc: "Number of active site licenses with pools using this tier.",
    },
    total_account_count: {
      type: "number",
      desc: "Number of distinct accounts using this tier through subscriptions, packages, or admin assignment.",
    },
    has_usage_history: {
      type: "boolean",
      desc: "Whether any durable membership, package, grant, trial, or site-license record has referenced this tier id.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});
