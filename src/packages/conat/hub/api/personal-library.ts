/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { authFirstRequireAccount } from "./util";
import type {
  PersonalLibraryAlias,
  PersonalLibraryTarget,
} from "@cocalc/util/personal-library";

export type {
  PersonalLibraryAlias,
  PersonalLibraryTarget,
} from "@cocalc/util/personal-library";

export interface PersonalLibrarySnapshot {
  aliases: PersonalLibraryAlias[];
  /** Ordered personal pin locators. These do not confer catalog access. */
  pins: string[];
}

export interface PersonalLibraryRequest {
  account_id?: string;
}

export interface PersonalLibraryNameRequest
  extends PersonalLibraryRequest, PersonalLibraryTarget {
  name: string;
}

export interface PersonalLibraryPinRequest extends PersonalLibraryRequest {
  pin_key: string;
  pinned: boolean;
}

export interface PersonalLibraryMoveRequest extends PersonalLibraryRequest {
  visible: string[];
  pin_key: string;
  index: number;
}

export interface PersonalLibraryImportRequest extends PersonalLibraryRequest {
  aliases: PersonalLibraryAlias[];
  pins: string[];
}

export interface PersonalLibraryApi {
  list(opts: PersonalLibraryRequest): Promise<PersonalLibrarySnapshot>;
  resolve(
    opts: PersonalLibraryRequest & { name: string },
  ): Promise<PersonalLibraryAlias | null>;
  name(opts: PersonalLibraryNameRequest): Promise<PersonalLibrarySnapshot>;
  setPinned(opts: PersonalLibraryPinRequest): Promise<PersonalLibrarySnapshot>;
  movePinned(
    opts: PersonalLibraryMoveRequest,
  ): Promise<PersonalLibrarySnapshot>;
  importLegacy(
    opts: PersonalLibraryImportRequest,
  ): Promise<PersonalLibrarySnapshot>;
}

export const personalLibrary = {
  list: authFirstRequireAccount,
  resolve: authFirstRequireAccount,
  name: authFirstRequireAccount,
  setPinned: authFirstRequireAccount,
  movePinned: authFirstRequireAccount,
  importLegacy: authFirstRequireAccount,
};
