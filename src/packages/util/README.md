CoCalc code shared between the frontend and the backend.

This package contains shared TypeScript/JavaScript utilities. Check each module's
dependencies before importing it in a browser: some modules use Node-only APIs
such as filesystem access or cryptography.

This code is part of https://github.com/sagemathinc/cocalc-ai and is not designed
as a standalone library. Earlier plans to extract smaller npm modules are
design history, not a guarantee that a particular utility is separately published.
