/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ReactNode } from "react";
import type { PrivateAliasKind } from "@cocalc/util/private-alias";
import type {
  CollaborationResourceKind,
  CollaborationProjectQuery,
} from "@cocalc/util/collaborators";

export type CollaboratorsView =
  | "conversations"
  | "people"
  | "projects"
  | "invites";
export type ProjectView = NonNullable<CollaborationProjectQuery["view"]>;

export interface CollaboratorsRoute {
  view: CollaboratorsView;
  projectId?: string;
  projectIds?: string[];
  personId?: string;
  /** Account-owned contact identity, never an account/person ID. */
  contactId?: string;
  /** Selected invitation in the Invites view; not an account/contact identity. */
  invitationId?: string;
  resourceKind?: CollaborationResourceKind;
  resourceId?: string;
  /** URL label only. Selections and authorization always use stable IDs. */
  alias?: string;
  aliasKind?: PrivateAliasKind;
  /** Namespace owner, not the resource's owner or the current viewer. */
  aliasOwner?: string;
}

export interface CollaboratorsPageProps extends Partial<CollaboratorsRoute> {
  accountId: string;
  active: boolean;
  navigation?: ReactNode;
  headerActions?: ReactNode;
  routeError?: string;
  onNavigate: (route: CollaboratorsRoute) => void;
}
