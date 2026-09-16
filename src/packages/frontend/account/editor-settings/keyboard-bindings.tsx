/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useIntl } from "react-intl";

import { LabeledRow, SelectorInput } from "@cocalc/frontend/components";
import { EDITOR_BINDINGS } from "@cocalc/util/db-schema/accounts";

import { KEYBOARD_BINDINGS_LABEL } from "./labels";

interface Props {
  bindings: string;
  on_change: (selected: string) => void;
}

export function EditorSettingsKeyboardBindings(
  props: Props,
): React.JSX.Element {
  const intl = useIntl();

  const label = intl.formatMessage(KEYBOARD_BINDINGS_LABEL);

  return (
    <LabeledRow label={label}>
      <SelectorInput
        ariaLabel={label}
        options={EDITOR_BINDINGS}
        selected={props.bindings}
        on_change={props.on_change}
      />
    </LabeledRow>
  );
}
