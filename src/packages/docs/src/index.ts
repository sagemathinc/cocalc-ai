/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type DocsAudience =
  | "agents"
  | "instructors"
  | "researchers"
  | "students"
  | "teams";

export type DocsEntryStatus = "draft" | "ready";

export type DocsActionId = "settings.environment.secrets";

export interface DocsAction {
  description: string;
  id: DocsActionId;
  label: string;
}

export interface DocsEntry {
  actions?: DocsAction[];
  audiences: DocsAudience[];
  body: string;
  category: string;
  id: string;
  lastReviewed: string;
  slug: string;
  status: DocsEntryStatus;
  summary: string;
  title: string;
}

export interface DocsSearchResult extends DocsEntry {
  score: number;
}

const PROJECT_SECRETS_BODY = String.raw`
## What project secrets are for

Project secrets are named values that are available to code running in a
project without committing private tokens into notebooks, scripts, terminals,
or TimeTravel history.

Use them for API keys, access tokens, deployment credentials, and other values
that code needs at runtime but collaborators should not casually paste into a
file.

## Add a secret from the UI

1. Open the project.
2. Open **Settings**.
3. Go to **Environment**.
4. Choose **Secrets**.
5. Add a name and value, then save it.

The exact UI action is identified as \`settings.environment.secrets\`. The docs
system will use these action ids so Codex and other agents can open the right
panel in the current browser session instead of merely describing where to
click.

## Use the secret

Secrets are exposed as environment variables to project processes that opt into
the project environment. In a terminal, notebook, or script, read the value using
the standard environment-variable mechanism for your language.

~~~python
import os

token = os.environ["MY_API_TOKEN"]
~~~

Use clear uppercase names such as \`OPENAI_API_KEY\`, \`HF_TOKEN\`, or
\`DATABASE_URL\`. Avoid putting secrets in source files, notebook outputs, chat
messages, or command history.

## Why this matters in CoCalc

CoCalc projects are collaborative, durable, and agent-friendly. That is exactly
why secrets should have a first-class home: humans and agents can run code,
restart terminals, execute notebooks, and automate tasks without turning private
credentials into shared document content.
`;

export const DOCS_ENTRIES: DocsEntry[] = [
  {
    actions: [
      {
        description:
          "Open the project Settings -> Environment -> Secrets panel.",
        id: "settings.environment.secrets",
        label: "Open project secrets",
      },
    ],
    audiences: ["agents", "researchers", "students", "teams"],
    body: PROJECT_SECRETS_BODY.trim(),
    category: "Projects",
    id: "projects.project-secrets",
    lastReviewed: "2026-05-24",
    slug: "projects/project-secrets",
    status: "ready",
    summary:
      "Store API keys and credentials in the project environment instead of notebooks, scripts, or chat.",
    title: "Project secrets",
  },
];

const DOCS_ACTION_IDS = new Set<DocsActionId>(
  DOCS_ENTRIES.flatMap(
    (entry) => entry.actions?.map((action) => action.id) ?? [],
  ),
);

export function docsPath(slug?: string): string {
  return slug ? `/docs/${slug.replace(/^\/+/, "")}` : "/docs";
}

export function listDocsEntries(): DocsEntry[] {
  return [...DOCS_ENTRIES];
}

export function getDocsEntry(slugOrId: string): DocsEntry | undefined {
  const normalized = slugOrId
    .replace(/^\/+/, "")
    .replace(/^docs\//, "")
    .replace(/\/+$/, "");
  return DOCS_ENTRIES.find(
    (entry) => entry.id === slugOrId || entry.slug === normalized,
  );
}

export function isDocsActionId(value: unknown): value is DocsActionId {
  return DOCS_ACTION_IDS.has(value as DocsActionId);
}

export function getDocsAction(actionId: string): DocsAction | undefined {
  for (const entry of DOCS_ENTRIES) {
    const action = entry.actions?.find(
      (candidate) => candidate.id === actionId,
    );
    if (action) return action;
  }
  return undefined;
}

export function searchDocsEntries(
  query: string,
  limit = 8,
): DocsSearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (terms.length === 0) {
    return DOCS_ENTRIES.slice(0, limit).map((entry) => ({
      ...entry,
      score: 0,
    }));
  }

  return DOCS_ENTRIES.map((entry) => {
    const haystack = [
      entry.title,
      entry.summary,
      entry.category,
      entry.audiences.join(" "),
      entry.actions
        ?.map((action) => `${action.id} ${action.label} ${action.description}`)
        .join(" "),
      entry.body,
    ]
      .join("\n")
      .toLowerCase();
    const score = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    return { ...entry, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
