/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";

export default function useCounter(id: string | undefined) {
  // call API to increment the counter
  useEffect(() => {
    if (id != null) {
      fetch(`/api/share/public_paths/counter/${id}`);
    }
  }, [id]);
}
