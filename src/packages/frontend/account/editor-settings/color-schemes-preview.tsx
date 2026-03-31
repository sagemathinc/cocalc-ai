/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AccountState } from "@cocalc/frontend/account/types";
import { cm_options } from "@cocalc/frontend/frame-editors/codemirror/cm-options";
import { CodeMirrorStatic } from "@cocalc/frontend/jupyter/codemirror-static";
import "@cocalc/frontend/codemirror/init";

const VALUE = `\
def is_prime_lucas_lehmer(p):
    """Test primality of Mersenne number 2**p - 1.
    >>> is_prime_lucas_lehmer(107)
    True
    """
    k = 2**p - 1; s = 4
    for i in range(3, p+1):
        s = (s*s - 2) % k
    return s == 0\
`;

export default function CodeMirrorPreview({
  editor_settings,
  font_size,
}: {
  editor_settings: AccountState["editor_settings"];
  font_size?: number;
}) {
  const options = cm_options("a.py", editor_settings);
  options.lineNumbers = false;
  return (
    <CodeMirrorStatic options={options} value={VALUE} font_size={font_size} />
  );
}
