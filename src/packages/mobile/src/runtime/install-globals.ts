/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import "fast-text-encoding";
import "react-native-get-random-values";
import "setimmediate";

import { Buffer } from "buffer";

type RuntimeGlobals = typeof globalThis & {
  Buffer?: typeof Buffer;
};

const runtime = globalThis as RuntimeGlobals;

if (runtime.Buffer == null) {
  runtime.Buffer = Buffer;
}
