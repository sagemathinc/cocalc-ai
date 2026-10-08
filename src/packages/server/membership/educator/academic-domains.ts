/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { AcademicDomainStatus } from "@cocalc/util/accounts/educator-email-policy";

interface AcademicDomainSets {
  tlds: Set<string>;
  stoplist: Set<string>;
  abused: Set<string>;
  domains: Set<string>;
}

let sets: AcademicDomainSets | undefined;

function toSet(list: string): Set<string> {
  return new Set(list.split("\n").filter(Boolean));
}

// The data module is large (~0.5 MB), so only load it when first needed.
async function loadSets(): Promise<AcademicDomainSets> {
  if (sets == null) {
    const data = await import("./academic-domains-data");
    sets = {
      tlds: toSet(data.ACADEMIC_TLDS),
      stoplist: toSet(data.ACADEMIC_STOPLIST),
      abused: toSet(data.ACADEMIC_ABUSED),
      domains: toSet(data.ACADEMIC_DOMAINS),
    };
  }
  return sets;
}

// "mail.math.ucla.edu" -> ["edu", "ucla.edu", "math.ucla.edu", ...]
function suffixes(domain: string): string[] {
  const labels = domain.split(".").filter(Boolean);
  const result: string[] = [];
  for (let i = labels.length - 1; i >= 0; i--) {
    result.push(labels.slice(i).join("."));
  }
  return result;
}

function hasSuffixIn(domain: string, set: Set<string>): boolean {
  return suffixes(domain).some((suffix) => set.has(suffix));
}

/** Same rules as JetBrains swot, plus its abused-domain list. */
export function academicDomainStatusFromSets(
  domain: string,
  data: AcademicDomainSets,
): AcademicDomainStatus {
  const normalized = `${domain ?? ""}`.trim().toLowerCase().replace(/\.+$/, "");
  if (!normalized || hasSuffixIn(normalized, data.stoplist)) {
    return "not_academic";
  }
  if (
    !hasSuffixIn(normalized, data.tlds) &&
    !hasSuffixIn(normalized, data.domains)
  ) {
    return "not_academic";
  }
  // Academic, but known to be handed out to non-staff (students, alumni,
  // ...): these need manual approval.
  if (hasSuffixIn(normalized, data.abused)) {
    return "abused";
  }
  return "academic";
}

export async function getAcademicDomainStatusFn(): Promise<
  (domain: string) => AcademicDomainStatus
> {
  const data = await loadSets();
  return (domain) => academicDomainStatusFromSets(domain, data);
}
