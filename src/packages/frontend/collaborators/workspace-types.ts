/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { ReactNode } from "react";
import type { CollaborationResourceKind } from "@cocalc/util/collaborators";

export type CollaboratorsView = "conversations" | "people" | "projects";

export interface CollaboratorsRoute {
  view: CollaboratorsView;
  projectId?: string;
  personId?: string;
  resourceKind?: CollaborationResourceKind;
  resourceId?: string;
}

export interface CollaboratorsPageProps extends Partial<CollaboratorsRoute> {
  accountId: string;
  active: boolean;
  navigation?: ReactNode;
  routeError?: string;
  onNavigate: (route: CollaboratorsRoute) => void;
}
