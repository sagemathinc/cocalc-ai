/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";

// Every active CRM contact suppression that applies to mail sent to this
// address, with the same scopes outreach honors: the email, its domain, its
// CRM email relations, and every CRM person it belongs to and their
// organizations. People come from the address (any email row) and from the
// given accounts (verified person-account links), since an account's current
// email need not be a CRM email row. A read failure is an error, never "no
// suppressions".
export async function activeSuppressionReasons({
  email,
  account_ids = [],
}: {
  email: string;
  account_ids?: string[];
}): Promise<string[]> {
  const domain = email.split("@")[1] ?? "";
  const { rows } = await getPool().query(
    `WITH emails AS (
       SELECT id, person_id FROM crm_person_emails WHERE normalized_email=$1
     ), people AS (
       SELECT person_id FROM emails
       UNION
       SELECT person_id FROM crm_person_accounts
        WHERE state='verified' AND account_id = ANY($3::uuid[])
     ), orgs AS (
       SELECT organization_id FROM crm_organization_people
        WHERE person_id IN (SELECT person_id FROM people)
     )
     SELECT DISTINCT reason FROM crm_contact_suppressions
      WHERE active AND (
        (scope='email' AND normalized_scope_value=$1)
        OR (scope='domain' AND normalized_scope_value=$2)
        OR (scope='person' AND person_id IN (SELECT person_id FROM people))
        OR (scope='organization'
            AND organization_id IN (SELECT organization_id FROM orgs))
        OR person_email_id IN (SELECT id FROM emails))
      ORDER BY reason`,
    [email, domain, account_ids],
  );
  return rows.map((row) => `${row.reason}`);
}
