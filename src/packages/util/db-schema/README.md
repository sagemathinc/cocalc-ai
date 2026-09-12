# Database Schema

The files here define permissions and tables for our database.

Some foundational tables are:

- accounts: id's and information about all registered users
- projects: id's and information (e.g., who can use) all projects
- public_project_paths: publication metadata for project paths
- server_settings: how the server is configured

This list is not a backup or recovery specification. Other tables retain
independent state, including subscriptions, membership grants, external
credentials, and commercial orders; recreating their schemas does not
recreate their records. Project files and external service state are also
outside these four tables. A site recovery procedure must account for its
actual database, storage, credentials, and deployment configuration and be
validated separately.
