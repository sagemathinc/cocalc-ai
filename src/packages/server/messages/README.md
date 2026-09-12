# Messaging

See `util/db-schema/messages.ts` for the database schema.

This package is server-internal. The old frontend message center and public
send/get APIs were removed; browser clients should use notifications, course
tooling, or project chat instead of creating messages directly.

## Server functionality

`send.ts` accepts recipient account IDs in `to_ids`, a plain-text `subject`,
and a Markdown `body`. It validates the accounts and creates an internal
message. When `from_id` is omitted, it resolves the support account and treats
the message as a system notice. System messages are also mirrored to account
notifications. Mirroring is best-effort unless
`requireAccountNoticeDelivery` is set; that option waits for creation of the
durable notification event, not for email delivery.

Sending an internal message does not itself send an immediate email.
`maintenance.ts` periodically sends summaries for eligible unread messages
when site email is enabled, subject to verification settings and the account's
email preference. It also deletes messages when all recipients and the sender
have marked them expired (or an unsent draft's author has expired it).

`admin-alert.ts` sends a system message to admins, or an explicit recipient
list. With no targets it does nothing; failures are logged unless
`errorOnFail` requests an exception. These helpers do not guarantee external
email delivery.
