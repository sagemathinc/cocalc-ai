# Legacy organization wrapper

The client still contains `hub.org` methods, including user creation and
temporary login tokens. The current HTTP hub bridge does not allow `org.*`
RPCs. Granting a key more capabilities does not enable those methods.

This legacy wrapper is not the current membership, team-seat, or course
administration interface. Use the site's supported account and course
workflows and contact support for deployment-specific organization needs.
See the [Python compatibility guide](../index.md) for accepted calls.
