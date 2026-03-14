# NeonTalk

Monorepo for an AI English roleplay platform with a Firebase-hosted web app, a dedicated API, and an async worker.

## Workspace layout

- `apps/web` - Next.js frontend targeted for Firebase App Hosting
- `services/api` - Fastify API for auth-adjacent and session flows
- `services/ai-worker` - async worker for AI turns and progress jobs
- `packages/contracts` - shared DTOs and validation schemas
- `packages/db` - Prisma schema and database client wrapper

## Local prerequisites

- Node.js 22 LTS recommended
- Docker Desktop or compatible Docker runtime
- npm 11+

## Quick start

1. Copy env templates:
   - `cp .env.example .env`
   - `cp apps/web/.env.local.example apps/web/.env.local`
   - `cp services/api/.env.example services/api/.env`
   - `cp services/ai-worker/.env.example services/ai-worker/.env`
2. Start infrastructure: `docker compose up -d`
3. Install dependencies: `npm install`
4. Generate the Prisma client: `npm run db:generate`
5. Start the app surfaces:
   - `npm run dev:web`
   - `npm run dev:api`
   - `npm run dev:worker`
6. Run unit tests:
   - `npm run test:unit`
7. Run API integration tests (sessions/messages):
   - `npm run test:integration:api`
8. Run API e2e happy-path test:
   - `npm run test:e2e:api`

## Docker full stack

Run web + api + worker + postgres + redis in one command:

1. Ensure `.env` contains Firebase values and public web keys.
2. Build and start everything:
   - `docker compose up --build -d`
3. Check status:
   - `docker compose ps`
   - `docker compose logs -f api`
4. Open:
   - Web: `http://localhost:3000`
   - API health: `http://localhost:4000/health`

Notes:
- API container applies DB migrations and seeds scenarios at startup.
- If `PUBSUB_ROLEPLAY_TURNS_SUBSCRIPTION` is empty, worker runs in idle mode.
- `docker-compose` now loads root `.env` into `web`, `api`, and `ai-worker` via `env_file`.
- Web build reads public keys from `apps/web/.env.local` (Next.js build-time env).
- For CSRF protection, set the same random value in `API_CSRF_TOKEN` (API env) and `NEXT_PUBLIC_CSRF_TOKEN` (`apps/web/.env.local`).
- Worker supports both OpenAI and Anthropic models. If `aiModel` starts with `claude-`, worker uses Anthropic (`ANTHROPIC_API_KEY`); otherwise it uses OpenAI (`OPENAI_API_KEY`).

## Security baseline

- Web now sends CSP + secure browser headers.
- API now sends secure headers on every response.
- API blocks state-changing requests from non-allowed origins and validates `x-csrf-token` when `API_CSRF_TOKEN` is configured.
- Firebase ID tokens are also checked for session age (`FIREBASE_MAX_SESSION_AGE_SEC`).

## Observability baseline

- API runs Fastify with structured JSON logs (`LOG_LEVEL`) and sensitive-field redaction.
- API emits `x-request-id` on responses for request correlation.
- API and worker both support webhook-based error tracking via:
  - `ERROR_TRACKING_WEBHOOK_URL`
  - `ERROR_TRACKING_API_KEY`
  - `ERROR_TRACKING_TIMEOUT_MS`
- Worker logs are normalized as structured JSON events.

## GitHub connection

The repository is initialized locally. To bind it to GitHub:

1. Create an empty GitHub repository.
2. Add the remote:
   - `git remote add origin <your-github-repo-url>`
3. Push the default branch:
   - `git push -u origin main`

## Firebase notes

- Point Firebase App Hosting at the `apps/web` directory.
- Keep backend services (`services/api`, `services/ai-worker`) on Cloud Run in the same GCP project.
- Configure secrets via Secret Manager and surface public values through `apps/web/apphosting.yaml`.

## Staging: App Hosting (Step 37)

1. In App Hosting, set backend environment to `staging`.
2. Keep shared defaults in:
   - `apps/web/apphosting.yaml`
3. Apply staging overrides from:
   - `apps/web/apphosting.staging.yaml`
4. Create/update staging secrets (one value per secret key):
   - `neontalk-staging-next-public-api-base-url`
   - `neontalk-staging-next-public-firebase-api-key`
   - `neontalk-staging-next-public-firebase-auth-domain`
   - `neontalk-staging-next-public-firebase-project-id`
   - `neontalk-staging-next-public-firebase-app-id`
   - `neontalk-staging-next-public-csrf-token`
5. Grant backend access to the secrets:
   - `./scripts/apphosting-staging-secrets-grant.sh <PROJECT_ID> <BACKEND_ID> [LOCATION]`
6. Trigger a staging rollout:
   - `firebase apphosting:rollouts:create <BACKEND_ID> --project <PROJECT_ID>`

## Staging: Cloud Run API + Worker (Step 38)

Added deployment assets:

- Cloud Run runtime Dockerfiles:
  - `services/api/Dockerfile.cloudrun`
  - `services/ai-worker/Dockerfile.cloudrun`
- Cloud Build config for both images:
  - `infra/cloudbuild/cloudrun-images.yaml`
- Staging runtime env files:
  - `infra/cloudrun/staging/api.env.yaml`
  - `infra/cloudrun/staging/worker.env.yaml`
- One-shot deploy script:
  - `scripts/deploy-cloudrun-staging.sh`

Deploy command:

- `./scripts/deploy-cloudrun-staging.sh <PROJECT_ID> [REGION] [ENVIRONMENT]`

Required secret input (before deploy):

- `API_DATABASE_URL_SECRET` (Secret Manager key with API `DATABASE_URL`)
- `WORKER_DATABASE_URL_SECRET` (optional; defaults to API DB secret)

Optional secret/env overrides:

- `API_REDIS_URL_SECRET`, `WORKER_REDIS_URL_SECRET`
- `API_FIREBASE_PROJECT_ID_SECRET`, `API_FIREBASE_CLIENT_EMAIL_SECRET`, `API_FIREBASE_PRIVATE_KEY_SECRET`
- `API_CSRF_TOKEN_SECRET`
- `API_OPENAI_API_KEY_SECRET`, `WORKER_OPENAI_API_KEY_SECRET`
- `WORKER_ANTHROPIC_API_KEY_SECRET`
- `API_ERROR_TRACKING_WEBHOOK_URL_SECRET`, `API_ERROR_TRACKING_API_KEY_SECRET`
- `WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET`, `WORKER_ERROR_TRACKING_API_KEY_SECRET`
- `API_PUBSUB_TOPIC` (default: `roleplay-turns`)
- `WORKER_SUBSCRIPTION` (default: `roleplay-turns-sub`)
- `API_SERVICE_ACCOUNT`, `WORKER_SERVICE_ACCOUNT`

## Staging: Cloud SQL + Redis + Secret Manager (Step 39)

1. Prepare/update data connectivity secrets from Cloud SQL + Redis:
   - `./scripts/configure-staging-data-secrets.sh <PROJECT_ID> <CLOUD_SQL_INSTANCE_CONNECTION_NAME> <DB_NAME> <DB_USER> <DB_PASSWORD> <REDIS_HOST> [REDIS_PORT] [SECRET_PREFIX]`
2. Grant Secret Manager access to Cloud Run runtime service account(s):
   - `./scripts/grant-cloudrun-secret-access.sh <PROJECT_ID> <SERVICE_ACCOUNT_EMAIL> [SECRET_PREFIX]`
3. Copy deploy secret wiring template and export values:
   - `cp infra/cloudrun/staging/secrets.env.example infra/cloudrun/staging/secrets.env`
   - `source infra/cloudrun/staging/secrets.env`
4. Run deploy with explicit Cloud SQL and VPC connector wiring:
   - `./scripts/deploy-cloudrun-staging.sh <PROJECT_ID> [REGION] [ENVIRONMENT]`

Notes:

- `scripts/deploy-cloudrun-staging.sh` now requires:
  - `CLOUD_SQL_INSTANCE_CONNECTION_NAME`
  - `VPC_CONNECTOR`
  - required data secrets (`DATABASE_URL`/`REDIS_URL` for API and worker)
- Use `DRY_RUN=1` to print final deploy commands without executing:
  - `DRY_RUN=1 ./scripts/deploy-cloudrun-staging.sh <PROJECT_ID>`
