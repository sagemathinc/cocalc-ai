/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export const ACP_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const ACP_MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACP_MAX_IMAGES = 8;
export const ACP_MAX_PROMPT_BYTES = 512 * 1024;

// 10 MiB of images expands to ~13.34 MiB in base64. Prompt text can expand
// sixfold under JSON escaping; leave room for the session and RPC envelope too.
export const ACP_MAX_OUTBOUND_FRAME_BYTES = 18 * 1024 * 1024;
