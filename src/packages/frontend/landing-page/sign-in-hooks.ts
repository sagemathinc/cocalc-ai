/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { webapp_client } from "../webapp-client";

// Launch actions step 1: store any launch action information
import * as launch_actions from "../launch/actions";
launch_actions.store();

webapp_client.on("signed_in", () => {
  // console.log("sign-in-hooks::signed_in mesg=", mesg);
  // launch actions step 2: launch based on local storage
  launch_actions.launch();
});
