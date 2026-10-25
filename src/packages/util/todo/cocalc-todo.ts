/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A CoCalc todo list (`*.todo.json`): an agent's own list of what it is doing,
written and kept current by the agent and shown to a person as a file
artifact (a card). Not a tool for people to manage tasks in: the agent edits
the file, the card shows it. Pure and browser-safe, so the card and any agent
share one reading of the format.

  {
    "format": "cocalc-todo", "version": 1,
    "id"?: "agents-polish",
    "title": "...", "description"?: "..." (Markdown),
    "updated"?: "2026-10-25T06:40:00Z",
    "categories"?: {"review": {"label": "In review", "color": "#1677ff"}},
    "sections"?: [{"id": "ready", "title": "Ready to merge",
                   "description"?: "..."}],
    "items": [{
      "id": "pr-1377", "title": "Questions panel",
      "status": "todo" | "doing" | "waiting" | "done" | "cancelled",
      "section"?: "ready", "category"?: "review",
      "priority"?: "high" | "normal" | "low",
      "details"? (Markdown), "waiting_for"?: "William's merge go",
      "links"?: [{"label", "url"}], "due"?: "2026-10-26"
    }]
  }

Items keep the file's order within their section; sections keep theirs, and
items without a section (or with an unknown one) come last.
*/

export const TODO_FORMAT = "cocalc-todo";
export const TODO_VERSION = 1;
/** Bounds, so a card never chokes on a file. */
export const TODO_LIMITS = {
  maxItems: 1_000,
  maxSections: 100,
  maxTextBytes: 1_000_000,
  maxTitle: 500,
  maxDetails: 20_000,
  maxLinks: 20,
} as const;

export const TODO_STATUSES = [
  "todo",
  "doing",
  "waiting",
  "done",
  "cancelled",
] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = "high" | "normal" | "low";

export interface TodoLink {
  label: string;
  url: string;
}

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  section?: string;
  category?: string;
  priority?: TodoPriority;
  details?: string;
  waiting_for?: string;
  links?: TodoLink[];
  due?: string;
}

export interface TodoSection {
  id: string;
  title: string;
  description?: string;
}

export interface TodoCategory {
  label: string;
  color?: string;
}

export interface CocalcTodo {
  format: typeof TODO_FORMAT;
  version: typeof TODO_VERSION;
  id?: string;
  title: string;
  description?: string;
  updated?: string;
  categories?: Record<string, TodoCategory>;
  sections?: TodoSection[];
  items: TodoItem[];
}

export interface TodoProblem {
  path: string;
  message: string;
}

/** Only web and mail links open from a card. */
export function todoLinkAllowed(url: unknown): boolean {
  if (typeof url !== "string" || url.length > 2_000) return false;
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Ids are strings, so 1 and "1" can't both name an item. */
function isId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function nonEmpty(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

/**
 * The list, or why not. Like the calendar, an item that cannot be read is
 * named among the problems and left out; the rest is still shown.
 */
export function parseTodo(text: string): {
  ok: boolean;
  todo?: CocalcTodo;
  problems: TodoProblem[];
} {
  const problems: TodoProblem[] = [];
  const problem = (path: string, message: string) =>
    problems.push({ path, message });
  if (text.length > TODO_LIMITS.maxTextBytes)
    return {
      ok: false,
      problems: [
        {
          path: "",
          message: `the file is larger than ${TODO_LIMITS.maxTextBytes} bytes`,
        },
      ],
    };
  let value: any;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      problems: [{ path: "", message: `not JSON: ${(err as Error).message}` }],
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {
      ok: false,
      problems: [{ path: "", message: "not a JSON object" }],
    };
  if (value.format !== TODO_FORMAT)
    problem("format", `must be "${TODO_FORMAT}"`);
  if (value.version !== TODO_VERSION)
    problem("version", `must be ${TODO_VERSION}`);
  if (!nonEmpty(value.title, TODO_LIMITS.maxTitle))
    problem("title", "must be a non-empty string");
  const optionalText = (path: string, v: unknown, max: number) => {
    if (v == null) return undefined;
    if (typeof v !== "string" || v.length > max) {
      problem(path, `must be a string of at most ${max} characters`);
      return undefined;
    }
    return v;
  };
  const description = optionalText(
    "description",
    value.description,
    TODO_LIMITS.maxDetails,
  );
  const updated = optionalText("updated", value.updated, 100);
  if (value.id != null && !isId(value.id))
    problem("id", "must be letters, digits, '.', '_', ':' or '-'");

  const categories: Record<string, TodoCategory> = {};
  if (value.categories != null) {
    if (typeof value.categories !== "object" || Array.isArray(value.categories))
      problem("categories", "must be an object");
    else
      for (const [key, raw] of Object.entries<any>(value.categories)) {
        const path = `categories.${key}`;
        if (!ID.test(key) || !raw || typeof raw !== "object") {
          problem(path, "must be {label, color?}");
          continue;
        }
        if (!nonEmpty(raw.label, 100)) {
          problem(`${path}.label`, "must be a non-empty string");
          continue;
        }
        const colorOk = typeof raw.color === "string" && COLOR.test(raw.color);
        if (raw.color != null && !colorOk)
          problem(`${path}.color`, "must be #rrggbb");
        categories[key] = {
          label: raw.label,
          ...(colorOk ? { color: raw.color } : {}),
        };
      }
  }

  const sections: TodoSection[] = [];
  if (value.sections != null) {
    if (!Array.isArray(value.sections)) problem("sections", "must be a list");
    else {
      if (value.sections.length > TODO_LIMITS.maxSections)
        problem(
          "sections",
          `only the first ${TODO_LIMITS.maxSections} are shown`,
        );
      value.sections
        .slice(0, TODO_LIMITS.maxSections)
        .forEach((raw: any, i: number) => {
          const path = `sections[${i}]`;
          if (!raw || typeof raw !== "object" || !isId(raw.id)) {
            problem(`${path}.id`, "must be an id");
            return;
          }
          if (sections.some((s) => s.id === raw.id)) {
            problem(`${path}.id`, `"${raw.id}" is used twice`);
            return;
          }
          if (!nonEmpty(raw.title, TODO_LIMITS.maxTitle)) {
            problem(`${path}.title`, "must be a non-empty string");
            return;
          }
          const sectionDescription = optionalText(
            `${path}.description`,
            raw.description,
            TODO_LIMITS.maxDetails,
          );
          sections.push({
            id: raw.id,
            title: raw.title,
            ...(sectionDescription ? { description: sectionDescription } : {}),
          });
        });
    }
  }

  const items: TodoItem[] = [];
  if (!Array.isArray(value.items)) problem("items", "must be a list");
  else {
    if (value.items.length > TODO_LIMITS.maxItems)
      problem("items", `only the first ${TODO_LIMITS.maxItems} are shown`);
    const seen = new Set<string>();
    value.items
      .slice(0, TODO_LIMITS.maxItems)
      .forEach((raw: any, i: number) => {
        const path = `items[${i}]`;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          problem(path, "must be an object");
          return;
        }
        if (!isId(raw.id)) {
          problem(`${path}.id`, "must be an id");
          return;
        }
        if (seen.has(raw.id)) {
          problem(`${path}.id`, `"${raw.id}" is used twice`);
          return;
        }
        if (!nonEmpty(raw.title, TODO_LIMITS.maxTitle)) {
          problem(`${path}.title`, "must be a non-empty string");
          return;
        }
        if (!TODO_STATUSES.includes(raw.status)) {
          problem(
            `${path}.status`,
            `must be one of ${TODO_STATUSES.join(", ")}`,
          );
          return;
        }
        seen.add(raw.id);
        const item: TodoItem = {
          id: raw.id,
          title: raw.title,
          status: raw.status,
        };
        if (raw.section != null) {
          if (typeof raw.section === "string") item.section = raw.section;
          else problem(`${path}.section`, "must be a section id");
        }
        if (raw.category != null) {
          if (
            typeof raw.category === "string" &&
            Object.prototype.hasOwnProperty.call(categories, raw.category)
          )
            item.category = raw.category;
          else problem(`${path}.category`, "must be one of the categories");
        }
        if (raw.priority != null) {
          if (["high", "normal", "low"].includes(raw.priority))
            item.priority = raw.priority;
          else problem(`${path}.priority`, "must be high, normal or low");
        }
        const details = optionalText(
          `${path}.details`,
          raw.details,
          TODO_LIMITS.maxDetails,
        );
        if (details) item.details = details;
        const waiting = optionalText(
          `${path}.waiting_for`,
          raw.waiting_for,
          TODO_LIMITS.maxTitle,
        );
        if (waiting) item.waiting_for = waiting;
        const due = optionalText(`${path}.due`, raw.due, 100);
        if (due) item.due = due;
        if (raw.links != null) {
          if (!Array.isArray(raw.links))
            problem(`${path}.links`, "must be a list");
          else {
            const links: TodoLink[] = [];
            raw.links
              .slice(0, TODO_LIMITS.maxLinks)
              .forEach((link: any, j: number) => {
                if (
                  link &&
                  nonEmpty(link.label, 200) &&
                  todoLinkAllowed(link.url)
                )
                  links.push({ label: link.label, url: link.url });
                else
                  problem(
                    `${path}.links[${j}]`,
                    "must be {label, url} with an http(s) or mailto url",
                  );
              });
            if (links.length) item.links = links;
          }
        }
        items.push(item);
      });
  }

  // Shown at all only when it is this format with a title and a list.
  const readable =
    value.format === TODO_FORMAT &&
    value.version === TODO_VERSION &&
    nonEmpty(value.title, TODO_LIMITS.maxTitle) &&
    Array.isArray(value.items);
  return {
    ok: problems.length === 0,
    ...(readable
      ? {
          todo: {
            format: TODO_FORMAT,
            version: TODO_VERSION,
            ...(isId(value.id) ? { id: value.id } : {}),
            title: value.title,
            ...(description ? { description } : {}),
            ...(updated ? { updated } : {}),
            ...(Object.keys(categories).length ? { categories } : {}),
            ...(sections.length ? { sections } : {}),
            items,
          },
        }
      : {}),
    problems,
  };
}

export interface TodoGroup {
  section?: TodoSection;
  items: TodoItem[];
}

/**
 * The items by section, in the file's order: each listed section with its
 * items, then the items without a (known) section. Empty sections are left
 * out.
 */
export function todoGroups(todo: CocalcTodo): TodoGroup[] {
  const known = new Set((todo.sections ?? []).map((s) => s.id));
  const groups: TodoGroup[] = (todo.sections ?? []).map((section) => ({
    section,
    items: todo.items.filter((item) => item.section === section.id),
  }));
  const rest = todo.items.filter(
    (item) => item.section == null || !known.has(item.section),
  );
  if (rest.length) groups.push({ items: rest });
  return groups.filter((group) => group.items.length > 0);
}

/** How far along a list is: done out of all that count (not cancelled). */
export function todoProgress(items: TodoItem[]): {
  done: number;
  total: number;
} {
  const counted = items.filter((item) => item.status !== "cancelled");
  return {
    done: counted.filter((item) => item.status === "done").length,
    total: counted.length,
  };
}
