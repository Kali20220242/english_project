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
