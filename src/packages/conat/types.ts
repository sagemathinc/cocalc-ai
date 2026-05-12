export type State = "disconnected" | "connected" | "closed";

export interface Location {
  project_id?: string;

  account_id?: string;
  browser_id?: string;

  path?: string;
}

type EventType = "total" | "add" | "delete" | "deny";
type ValueType = "count" | "limit";
type MetricKey =
  | `${EventType}:${ValueType}`
  | "inbound-deny:count"
  | "inbound-event-window:limit"
  | "inbound-event-window:ms";
export type Metrics = { [K in MetricKey]?: number };
