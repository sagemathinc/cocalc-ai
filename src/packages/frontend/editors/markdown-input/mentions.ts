/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { isValidUUID, original_path } from "@cocalc/util/misc";

interface Mention {
  account_id: string;
  description: string;
  fragment_id?: string;
}

const seenFragmentIds = new Set<string>();

export async function submit_mentions(
  project_id: string,
  path: string,
  mentions: Mention[],
): Promise<void> {
  const source = redux.getStore("account")?.get("account_id");
  if (source == null) {
    return;
  }
  const source_path = original_path(path);
  for (const { account_id, description, fragment_id } of mentions) {
    if (!isValidUUID(account_id)) {
      // Ignore all language model mentions, they are processed by the chat actions in the frontend
      continue;
    }
    if (fragment_id) {
      if (seenFragmentIds.has(fragment_id)) {
        continue;
      }
      seenFragmentIds.add(fragment_id);
    }
    try {
      const results = await Promise.allSettled([
        webapp_client.query_client.query({
          query: {
            mentions: {
              project_id,
              path: source_path,
              fragment_id,
              target: account_id,
              priority: 2,
              description,
              source,
            },
          },
        }),
        webapp_client.conat_client?.hub?.notifications?.createMention({
          source_project_id: project_id,
          source_path,
          source_fragment_id: fragment_id,
          target_account_ids: [account_id],
          description,
          stable_source_id: fragment_id,
        }) ?? Promise.resolve(undefined),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          console.warn("Failed to submit mention ", result.reason);
        }
      }
    } catch (err) {
      // TODO: this is just naively assuming that no errors happen.
      // What if there is a network blip?
      // Then we would just loose the mention, which is no good. Do better.
      console.warn("Failed to submit mention ", err);
    }
  }
}
