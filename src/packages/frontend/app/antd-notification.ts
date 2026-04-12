/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { notification } from "antd";
import type { NotificationInstance } from "antd/es/notification/interface";

let antdNotificationInstance: NotificationInstance | undefined;

export function setAntdNotificationInstance(
  next: NotificationInstance | undefined,
): void {
  antdNotificationInstance = next;
}

export function getAntdNotificationInstance(): NotificationInstance {
  return antdNotificationInstance ?? notification;
}
