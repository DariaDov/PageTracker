# PageTracker

PageTracker is a Ukrainian-language reading tracker with a PostgreSQL-backed REST API and browser UI.

## Run locally

Requirements: Node.js 20 or newer and PostgreSQL.

1. Install dependencies with `npm install`.
2. Set `DATABASE_URL` to a PostgreSQL connection string, for example
   `postgres://postgres:postgres@127.0.0.1:5432/pagetracker`.
3. Start the server with `npm start`.
4. Open `http://127.0.0.1:4179`.

The server creates the required tables and indexes on startup. Set `PORT` or `HOST` to override the local defaults. For production, terminate HTTPS at a trusted reverse proxy; the session cookie is `Secure` and must only be sent over HTTPS (browsers also treat loopback HTTP as a secure context for local development).

The browser app supports registration and sign-in, a reading-entry home page, paginated library and book details, statistics, and weekly/monthly reading goals. All data changes are sent to the same-origin API and persisted in PostgreSQL.

## API reference

See the [REST API guide](./docs/api-reference.md) for authentication and endpoint overview. The complete contract is available as [OpenAPI YAML](./spec/openapi.yaml) and [OpenAPI JSON](./spec/openapi.json).

## User guide

See the [україномовний посібник користувача](./docs/user-guide.md) for account, library, reading-record, statistics, and goal workflows.

## Verify

Run the automated suite with `npm test` and check JavaScript style with `npm run lint`. PostgreSQL acceptance tests run only when `TEST_DATABASE_URL` points to a dedicated test database; without it those tests are reported as skipped, not passed.

See the [coding convention](./docs/coding-convention.md) for project style and implementation rules.
