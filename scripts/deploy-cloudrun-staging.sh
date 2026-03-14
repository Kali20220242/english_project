#!/usr/bin/env bash

set -euo pipefail

PROJECT_ID="${1:-}"
REGION="${2:-us-central1}"
ENVIRONMENT="${3:-staging}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Usage: $0 <PROJECT_ID> [REGION] [ENVIRONMENT]"
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install Google Cloud SDK first."
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-neontalk}"
SECRET_PREFIX="${SECRET_PREFIX:-neontalk-${ENVIRONMENT}}"
API_SERVICE_NAME="${API_SERVICE_NAME:-neontalk-api-${ENVIRONMENT}}"
WORKER_SERVICE_NAME="${WORKER_SERVICE_NAME:-neontalk-worker-${ENVIRONMENT}}"
API_ENV_FILE="${API_ENV_FILE:-${ROOT_DIR}/infra/cloudrun/staging/api.env.yaml}"
WORKER_ENV_FILE="${WORKER_ENV_FILE:-${ROOT_DIR}/infra/cloudrun/staging/worker.env.yaml}"
CLOUD_SQL_INSTANCE_CONNECTION_NAME="${CLOUD_SQL_INSTANCE_CONNECTION_NAME:-}"
VPC_CONNECTOR="${VPC_CONNECTOR:-}"
VPC_EGRESS="${VPC_EGRESS:-private-ranges-only}"

if [[ ! -f "${API_ENV_FILE}" ]]; then
  echo "Missing API env file: ${API_ENV_FILE}"
  exit 1
fi

if [[ ! -f "${WORKER_ENV_FILE}" ]]; then
  echo "Missing worker env file: ${WORKER_ENV_FILE}"
  exit 1
fi

if [[ -z "${CLOUD_SQL_INSTANCE_CONNECTION_NAME}" ]]; then
  echo "Set CLOUD_SQL_INSTANCE_CONNECTION_NAME (PROJECT:REGION:INSTANCE)."
  exit 1
fi

if [[ -z "${VPC_CONNECTOR}" ]]; then
  echo "Set VPC_CONNECTOR (name or full resource path)."
  exit 1
fi

API_DATABASE_URL_SECRET="${API_DATABASE_URL_SECRET:-${SECRET_PREFIX}-api-database-url}"
API_DIRECT_DATABASE_URL_SECRET="${API_DIRECT_DATABASE_URL_SECRET:-${SECRET_PREFIX}-api-direct-database-url}"
WORKER_DATABASE_URL_SECRET="${WORKER_DATABASE_URL_SECRET:-${SECRET_PREFIX}-worker-database-url}"
API_REDIS_URL_SECRET="${API_REDIS_URL_SECRET:-${SECRET_PREFIX}-api-redis-url}"
WORKER_REDIS_URL_SECRET="${WORKER_REDIS_URL_SECRET:-${SECRET_PREFIX}-worker-redis-url}"
API_CSRF_TOKEN_SECRET="${API_CSRF_TOKEN_SECRET:-${SECRET_PREFIX}-api-csrf-token}"
API_FIREBASE_PROJECT_ID_SECRET="${API_FIREBASE_PROJECT_ID_SECRET:-${SECRET_PREFIX}-api-firebase-project-id}"
API_FIREBASE_CLIENT_EMAIL_SECRET="${API_FIREBASE_CLIENT_EMAIL_SECRET:-${SECRET_PREFIX}-api-firebase-client-email}"
API_FIREBASE_PRIVATE_KEY_SECRET="${API_FIREBASE_PRIVATE_KEY_SECRET:-${SECRET_PREFIX}-api-firebase-private-key}"
API_OPENAI_API_KEY_SECRET="${API_OPENAI_API_KEY_SECRET:-${SECRET_PREFIX}-api-openai-api-key}"
WORKER_OPENAI_API_KEY_SECRET="${WORKER_OPENAI_API_KEY_SECRET:-${SECRET_PREFIX}-worker-openai-api-key}"
WORKER_ANTHROPIC_API_KEY_SECRET="${WORKER_ANTHROPIC_API_KEY_SECRET:-${SECRET_PREFIX}-worker-anthropic-api-key}"
API_ERROR_TRACKING_WEBHOOK_URL_SECRET="${API_ERROR_TRACKING_WEBHOOK_URL_SECRET:-${SECRET_PREFIX}-api-error-tracking-webhook-url}"
API_ERROR_TRACKING_API_KEY_SECRET="${API_ERROR_TRACKING_API_KEY_SECRET:-${SECRET_PREFIX}-api-error-tracking-api-key}"
WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET="${WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET:-${SECRET_PREFIX}-worker-error-tracking-webhook-url}"
WORKER_ERROR_TRACKING_API_KEY_SECRET="${WORKER_ERROR_TRACKING_API_KEY_SECRET:-${SECRET_PREFIX}-worker-error-tracking-api-key}"
API_PUBSUB_TOPIC="${API_PUBSUB_TOPIC:-roleplay-turns}"
WORKER_SUBSCRIPTION="${WORKER_SUBSCRIPTION:-roleplay-turns-sub}"

API_SERVICE_ACCOUNT="${API_SERVICE_ACCOUNT:-}"
WORKER_SERVICE_ACCOUNT="${WORKER_SERVICE_ACCOUNT:-}"
DRY_RUN="${DRY_RUN:-0}"

secret_exists() {
  local secret_name="${1}"
  gcloud secrets describe "${secret_name}" \
    --project "${PROJECT_ID}" >/dev/null 2>&1
}

ensure_required_secret() {
  local secret_name="${1}"
  local label="${2}"

  if ! secret_exists "${secret_name}"; then
    echo "Missing required secret (${label}): ${secret_name}"
    echo "Create it first, then retry deploy."
    exit 1
  fi
}

resolve_optional_secret() {
  local secret_name="${1}"
  local label="${2}"

  if [[ -z "${secret_name}" ]]; then
    echo ""
    return 0
  fi

  if secret_exists "${secret_name}"; then
    echo "${secret_name}"
    return 0
  fi

  echo "Optional secret not found (${label}): ${secret_name}. Skipping." >&2
  echo ""
}

ensure_required_secret "${API_DATABASE_URL_SECRET}" "API DATABASE_URL"
ensure_required_secret "${API_DIRECT_DATABASE_URL_SECRET}" "API DIRECT_DATABASE_URL"
ensure_required_secret "${WORKER_DATABASE_URL_SECRET}" "Worker DATABASE_URL"
ensure_required_secret "${API_REDIS_URL_SECRET}" "API REDIS_URL"
ensure_required_secret "${WORKER_REDIS_URL_SECRET}" "Worker REDIS_URL"

API_CSRF_TOKEN_SECRET="$(resolve_optional_secret "${API_CSRF_TOKEN_SECRET}" "API CSRF token")"
API_FIREBASE_PROJECT_ID_SECRET="$(resolve_optional_secret "${API_FIREBASE_PROJECT_ID_SECRET}" "Firebase project id")"
API_FIREBASE_CLIENT_EMAIL_SECRET="$(resolve_optional_secret "${API_FIREBASE_CLIENT_EMAIL_SECRET}" "Firebase client email")"
API_FIREBASE_PRIVATE_KEY_SECRET="$(resolve_optional_secret "${API_FIREBASE_PRIVATE_KEY_SECRET}" "Firebase private key")"
API_OPENAI_API_KEY_SECRET="$(resolve_optional_secret "${API_OPENAI_API_KEY_SECRET}" "API OpenAI key")"
WORKER_OPENAI_API_KEY_SECRET="$(resolve_optional_secret "${WORKER_OPENAI_API_KEY_SECRET}" "Worker OpenAI key")"
WORKER_ANTHROPIC_API_KEY_SECRET="$(resolve_optional_secret "${WORKER_ANTHROPIC_API_KEY_SECRET}" "Worker Anthropic key")"
API_ERROR_TRACKING_WEBHOOK_URL_SECRET="$(resolve_optional_secret "${API_ERROR_TRACKING_WEBHOOK_URL_SECRET}" "API error tracking webhook")"
API_ERROR_TRACKING_API_KEY_SECRET="$(resolve_optional_secret "${API_ERROR_TRACKING_API_KEY_SECRET}" "API error tracking API key")"
WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET="$(resolve_optional_secret "${WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET}" "Worker error tracking webhook")"
WORKER_ERROR_TRACKING_API_KEY_SECRET="$(resolve_optional_secret "${WORKER_ERROR_TRACKING_API_KEY_SECRET}" "Worker error tracking API key")"

if [[ -z "${WORKER_OPENAI_API_KEY_SECRET}" && -n "${API_OPENAI_API_KEY_SECRET}" ]]; then
  WORKER_OPENAI_API_KEY_SECRET="${API_OPENAI_API_KEY_SECRET}"
fi

if [[ -z "${WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET}" && -n "${API_ERROR_TRACKING_WEBHOOK_URL_SECRET}" ]]; then
  WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET="${API_ERROR_TRACKING_WEBHOOK_URL_SECRET}"
fi

if [[ -z "${WORKER_ERROR_TRACKING_API_KEY_SECRET}" && -n "${API_ERROR_TRACKING_API_KEY_SECRET}" ]]; then
  WORKER_ERROR_TRACKING_API_KEY_SECRET="${API_ERROR_TRACKING_API_KEY_SECRET}"
fi

if [[ ! "${VPC_EGRESS}" =~ ^(private-ranges-only|all-traffic)$ ]]; then
  echo "VPC_EGRESS must be one of: private-ranges-only, all-traffic"
  exit 1
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
API_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/api:${ENVIRONMENT}-${TIMESTAMP}"
WORKER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/worker:${ENVIRONMENT}-${TIMESTAMP}"

echo "Project: ${PROJECT_ID}"
echo "Region: ${REGION}"
echo "Environment: ${ENVIRONMENT}"
echo "API service: ${API_SERVICE_NAME}"
echo "Worker service: ${WORKER_SERVICE_NAME}"
echo "Artifact repo: ${ARTIFACT_REPOSITORY}"
echo "Cloud SQL instance: ${CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
echo "VPC connector: ${VPC_CONNECTOR}"
echo "VPC egress: ${VPC_EGRESS}"

if ! gcloud artifacts repositories describe "${ARTIFACT_REPOSITORY}" \
  --project "${PROJECT_ID}" \
  --location "${REGION}" >/dev/null 2>&1; then
  echo "Creating Artifact Registry repository ${ARTIFACT_REPOSITORY}..."
  gcloud artifacts repositories create "${ARTIFACT_REPOSITORY}" \
    --project "${PROJECT_ID}" \
    --location "${REGION}" \
    --repository-format docker \
    --description "Container images for NeonTalk Cloud Run"
fi

echo "Building and pushing API + worker images with Cloud Build..."
gcloud builds submit "${ROOT_DIR}" \
  --project "${PROJECT_ID}" \
  --config "${ROOT_DIR}/infra/cloudbuild/cloudrun-images.yaml" \
  --substitutions "_API_IMAGE=${API_IMAGE},_WORKER_IMAGE=${WORKER_IMAGE}"

API_SECRET_MAPPINGS=(
  "DATABASE_URL=${API_DATABASE_URL_SECRET}:latest"
  "DIRECT_DATABASE_URL=${API_DIRECT_DATABASE_URL_SECRET}:latest"
  "REDIS_URL=${API_REDIS_URL_SECRET}:latest"
)

if [[ -n "${API_CSRF_TOKEN_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("API_CSRF_TOKEN=${API_CSRF_TOKEN_SECRET}:latest")
fi
if [[ -n "${API_FIREBASE_PROJECT_ID_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("FIREBASE_PROJECT_ID=${API_FIREBASE_PROJECT_ID_SECRET}:latest")
fi
if [[ -n "${API_FIREBASE_CLIENT_EMAIL_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("FIREBASE_CLIENT_EMAIL=${API_FIREBASE_CLIENT_EMAIL_SECRET}:latest")
fi
if [[ -n "${API_FIREBASE_PRIVATE_KEY_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("FIREBASE_PRIVATE_KEY=${API_FIREBASE_PRIVATE_KEY_SECRET}:latest")
fi
if [[ -n "${API_OPENAI_API_KEY_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("OPENAI_API_KEY=${API_OPENAI_API_KEY_SECRET}:latest")
fi
if [[ -n "${API_ERROR_TRACKING_WEBHOOK_URL_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("ERROR_TRACKING_WEBHOOK_URL=${API_ERROR_TRACKING_WEBHOOK_URL_SECRET}:latest")
fi
if [[ -n "${API_ERROR_TRACKING_API_KEY_SECRET}" ]]; then
  API_SECRET_MAPPINGS+=("ERROR_TRACKING_API_KEY=${API_ERROR_TRACKING_API_KEY_SECRET}:latest")
fi

WORKER_SECRET_MAPPINGS=(
  "DATABASE_URL=${WORKER_DATABASE_URL_SECRET}:latest"
  "REDIS_URL=${WORKER_REDIS_URL_SECRET}:latest"
)

if [[ -n "${WORKER_OPENAI_API_KEY_SECRET}" ]]; then
  WORKER_SECRET_MAPPINGS+=("OPENAI_API_KEY=${WORKER_OPENAI_API_KEY_SECRET}:latest")
fi
if [[ -n "${WORKER_ANTHROPIC_API_KEY_SECRET}" ]]; then
  WORKER_SECRET_MAPPINGS+=("ANTHROPIC_API_KEY=${WORKER_ANTHROPIC_API_KEY_SECRET}:latest")
fi
if [[ -n "${WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET}" ]]; then
  WORKER_SECRET_MAPPINGS+=("ERROR_TRACKING_WEBHOOK_URL=${WORKER_ERROR_TRACKING_WEBHOOK_URL_SECRET}:latest")
fi
if [[ -n "${WORKER_ERROR_TRACKING_API_KEY_SECRET}" ]]; then
  WORKER_SECRET_MAPPINGS+=("ERROR_TRACKING_API_KEY=${WORKER_ERROR_TRACKING_API_KEY_SECRET}:latest")
fi

API_SECRETS_ARG=""
if (( ${#API_SECRET_MAPPINGS[@]} > 0 )); then
  API_SECRETS_ARG="$(IFS=,; echo "${API_SECRET_MAPPINGS[*]}")"
fi

WORKER_SECRETS_ARG=""
if (( ${#WORKER_SECRET_MAPPINGS[@]} > 0 )); then
  WORKER_SECRETS_ARG="$(IFS=,; echo "${WORKER_SECRET_MAPPINGS[*]}")"
fi

API_DEPLOY_CMD=(
  gcloud run deploy "${API_SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --platform managed
  --image "${API_IMAGE}"
  --port 8080
  --allow-unauthenticated
  --add-cloudsql-instances "${CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
  --vpc-connector "${VPC_CONNECTOR}"
  --vpc-egress "${VPC_EGRESS}"
  --env-vars-file "${API_ENV_FILE}"
  --update-env-vars "PUBSUB_ROLEPLAY_TURNS_TOPIC=${API_PUBSUB_TOPIC}"
  --cpu 1
  --memory 1Gi
  --min-instances 0
  --max-instances 3
)

if [[ -n "${API_SECRETS_ARG}" ]]; then
  API_DEPLOY_CMD+=(--set-secrets "${API_SECRETS_ARG}")
fi

if [[ -n "${API_SERVICE_ACCOUNT}" ]]; then
  API_DEPLOY_CMD+=(--service-account "${API_SERVICE_ACCOUNT}")
fi

WORKER_DEPLOY_CMD=(
  gcloud run deploy "${WORKER_SERVICE_NAME}"
  --project "${PROJECT_ID}"
  --region "${REGION}"
  --platform managed
  --image "${WORKER_IMAGE}"
  --port 8080
  --no-allow-unauthenticated
  --ingress internal
  --add-cloudsql-instances "${CLOUD_SQL_INSTANCE_CONNECTION_NAME}"
  --vpc-connector "${VPC_CONNECTOR}"
  --vpc-egress "${VPC_EGRESS}"
  --env-vars-file "${WORKER_ENV_FILE}"
  --update-env-vars "PUBSUB_ROLEPLAY_TURNS_SUBSCRIPTION=${WORKER_SUBSCRIPTION}"
  --cpu 1
  --memory 1Gi
  --min-instances 1
  --max-instances 1
  --no-cpu-throttling
)

if [[ -n "${WORKER_SECRETS_ARG}" ]]; then
  WORKER_DEPLOY_CMD+=(--set-secrets "${WORKER_SECRETS_ARG}")
fi

if [[ -n "${WORKER_SERVICE_ACCOUNT}" ]]; then
  WORKER_DEPLOY_CMD+=(--service-account "${WORKER_SERVICE_ACCOUNT}")
fi

echo "Deploying API service..."
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "DRY_RUN=1 set. API command:"
  printf '%q ' "${API_DEPLOY_CMD[@]}"
  echo
else
  "${API_DEPLOY_CMD[@]}"
fi

echo "Deploying worker service..."
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "DRY_RUN=1 set. Worker command:"
  printf '%q ' "${WORKER_DEPLOY_CMD[@]}"
  echo
else
  "${WORKER_DEPLOY_CMD[@]}"
fi

echo "Cloud Run staging deploy completed."
echo "API image: ${API_IMAGE}"
echo "Worker image: ${WORKER_IMAGE}"
