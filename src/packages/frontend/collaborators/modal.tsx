/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Modal } from "antd";
import type { ModalProps } from "antd";
import "./modal.css";

export function CollaboratorsModal({ rootClassName, ...props }: ModalProps) {
  return (
    <Modal
      {...props}
      rootClassName={["collaborators-modal", rootClassName]
        .filter(Boolean)
        .join(" ")}
    />
  );
}
