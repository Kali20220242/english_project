#!/usr/bin/env bash

set -euo pipefail

PROJECT_ID="${1:-}"
CLOUD_SQL_INSTANCE_CONNECTION_NAME="${2:-}"
DB_NAME="${3:-neontalk}"
DB_USER="${4:-postgres}"
DB_PASSWORD="${5:-}"
REDIS_HOST="${6:-}"
REDIS_PORT="${7:-6379}"
SECRET_PREFIX="${8:-neontalk-staging}"

if [[ -z "${PROJECT_ID}" || -z "${CLOUD_SQL_INSTANCE_CONNECTION_NAME}" || -z "${DB_PASSWORD}" || -z "${REDIS_HOST}" ]]; then
  echo "Usage: $0 <PROJECT_ID> <CLOUD_SQL_INSTANCE_CONNECTION_NAME> <DB_NAME> <DB_USER> <DB_PASSWORD> <REDIS_HOST> [REDIS_PORT] [SECRET_PREFIX]"
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install Google Cloud SDK first."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required for URL-safe secret generation."
  exit 1
fi

urlencode() {
  node -e 'console.log(encodeURIComponent(process.argv[1]))' "${1}"
}

upsert_secret() {
  local secret_name="${1}"
  local secret_value="${2}"

  if gcloud secrets describe "${secret_name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    printf '%s' "${secret_value}" | gcloud secrets versions add "${secret_name}" \
      --project "${PROJECT_ID}" \
      --data-file=-
  else
    printf '%s' "${secret_value}" | gcloud secrets create "${secret_name}" \
      --project "${PROJECT_ID}" \
      --replication-policy=automatic \
      --data-file=-
  fi
}

encoded_user="$(urlencode "${DB_USER}")"
encoded_password="$(urlencode "${DB_PASSWORD}")"
encoded_db="$(urlencode "${DB_NAME}")"
encoded_socket_host="$(urlencode "/cloudsql/${CLOUD_SQL_INSTANCE_CONNECTION_NAME}")"

database_url="postgresql://${encoded_user}:${encoded_password}@localhost:5432/${encoded_db}?host=${encoded_socket_host}"
redis_url="redis://${REDIS_HOST}:${REDIS_PORT}"

api_database_secret="${SECRET_PREFIX}-api-database-url"
api_direct_database_secret="${SECRET_PREFIX}-api-direct-database-url"
worker_database_secret="${SECRET_PREFIX}-worker-database-url"
api_redis_secret="${SECRET_PREFIX}-api-redis-url"
worker_redis_secret="${SECRET_PREFIX}-worker-redis-url"

echo "Writing Cloud SQL and Redis secrets to Secret Manager..."
echo "Project: ${PROJECT_ID}"
echo "Prefix: ${SECRET_PREFIX}"
echo "Cloud SQL: ${CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
echo "Redis: ${REDIS_HOST}:${REDIS_PORT}"

upsert_secret "${api_database_secret}" "${database_url}"
upsert_secret "${api_direct_database_secret}" "${database_url}"
upsert_secret "${worker_database_secret}" "${database_url}"
upsert_secret "${api_redis_secret}" "${redis_url}"
upsert_secret "${worker_redis_secret}" "${redis_url}"

if ! gcloud secrets describe "${SECRET_PREFIX}-api-csrf-token" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  csrf_token="$(node -e 'const { randomBytes } = require("node:crypto"); process.stdout.write(randomBytes(32).toString("hex"));')"
  upsert_secret "${SECRET_PREFIX}-api-csrf-token" "${csrf_token}"
fi

echo "Done."
echo
echo "Recommended export values for deploy script:"
echo "export CLOUD_SQL_INSTANCE_CONNECTION_NAME=${CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
echo "export API_DATABASE_URL_SECRET=${api_database_secret}"
echo "export API_DIRECT_DATABASE_URL_SECRET=${api_direct_database_secret}"
echo "export WORKER_DATABASE_URL_SECRET=${worker_database_secret}"
echo "export API_REDIS_URL_SECRET=${api_redis_secret}"
echo "export WORKER_REDIS_URL_SECRET=${worker_redis_secret}"
