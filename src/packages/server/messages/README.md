# Messaging

See util/db-schema/messages.ts for the database schema.

This package is now server-internal. The old frontend message center and
public send/get APIs were removed; browser clients should use notifications,
course tooling, or project chat instead of creating messages directly.

## Maintenance

- periodically delete messages that are marked for deletion

- if user has an email on file, send out an email about their new unread messages.

## Server functionality

A function that takes as input:

- account_id
- subject
- body (formatted as markdown)

then does the following:

- if the user has email configured, sends an email to the user with the markdown converted to html
- creates a message to the user from "cocalc".

## Admin/monitoring functionality

A function to make it easy to notify the admins if something should be investigated. It sends a message to all admins...
