# SoundCloud MVP Microservices Environment

Initial bootstrap for a production-oriented microservices setup:

- `web` (React + Vite + TypeScript)
- `api-gateway` (FastAPI)
- `identity-service` (FastAPI)
- `tracks-service` (FastAPI)
- `upload-service` (FastAPI)
- `social-service` (FastAPI)
- `processing-worker` (Redis consumer stub)
- Infra: `postgres`, `redis`, `minio`, `nginx`

## Quick start

```bash
cp .env.example .env
make up
```

Main endpoints:

- Nginx gateway: `http://localhost:8088`
- API gateway docs: `http://localhost:8088/api/docs`
- MinIO console: `http://localhost:9001`

## Monorepo structure

```text
soundcloud-mvp/
  web/
  services/
    api-gateway/
    identity-service/
    tracks-service/
    upload-service/
    social-service/
    processing-worker/
  infra/nginx/
  docker-compose.yml
  Makefile
```

## Notes

- Audio binaries must be stored in MinIO/S3; PostgreSQL stores only metadata.
- This is an MVP scaffold with health endpoints, logging baseline, and migration placeholders.
- Next step is to implement auth verification, upload presigned URL flow, queue jobs, and processing pipeline.
