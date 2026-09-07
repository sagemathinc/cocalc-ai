/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { MoonOutlined, SunOutlined } from "@ant-design/icons";
import { useIntl } from "react-intl";
import { Button } from "antd";
import { useRedux } from "@cocalc/frontend/app-framework";
import { editor } from "@cocalc/frontend/i18n";

export function PDFInvertColorsButton({
  actions,
  id,
  disabled = false,
}: {
  actions: { name: string; toggle_pdf_dark_mode: (id: string) => void };
  id: string;
  disabled?: boolean;
}) {
  const intl = useIntl();
  const values = useRedux(actions.name, "pdf_invert_colors");
  const inverted = values?.get?.(id) ?? false;
  return (
    <Button
      size="small"
      type={inverted ? "primary" : "default"}
      disabled={disabled}
      aria-label={intl.formatMessage(editor.toggle_pdf_dark_mode_label)}
      aria-pressed={inverted}
      onClick={() => actions.toggle_pdf_dark_mode(id)}
      title={intl.formatMessage(editor.toggle_pdf_dark_mode_title)}
    >
      {inverted ? <MoonOutlined aria-hidden /> : <SunOutlined aria-hidden />}
    </Button>
  );
}
