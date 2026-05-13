/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_SECRETS_MOUNT_PATH = "/run/secrets/cocalc";
export const PROJECT_SECRETS_ENV = "COCALC_SECRETS";
export const PROJECT_SECRETS_PURPOSE = "project-secrets:v1";
export const PROJECT_SECRETS_KEY_ID = "site-master-key-v1";
export const PROJECT_SECRETS_MAX_COUNT = 20;
export const PROJECT_SECRET_NAME_MAX_LENGTH = 128;
export const PROJECT_SECRET_VALUE_MAX_BYTES = 64 * 1024;

export const PROJECT_ENV_MAX_COUNT = 50;
export const PROJECT_ENV_KEY_MAX_LENGTH = 128;
export const PROJECT_ENV_VALUE_MAX_BYTES = 16 * 1024;
export const PROJECT_ENV_TOTAL_MAX_BYTES = 128 * 1024;
