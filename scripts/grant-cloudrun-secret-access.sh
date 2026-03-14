#!/usr/bin/env bash

set -euo pipefail

PROJECT_ID="${1:-}"
SERVICE_ACCOUNT_EMAIL="${2:-}"
SECRET_PREFIX="${3:-neontalk-staging}"

if [[ -z "${PROJECT_ID}" || -z "${SERVICE_ACCOUNT_EMAIL}" ]]; then
  echo "Usage: $0 <PROJECT_ID> <SERVICE_ACCOUNT_EMAIL> [SECRET_PREFIX]"
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install Google Cloud SDK first."
  exit 1
fi

SECRETS=(
  "${SECRET_PREFIX}-api-database-url"
  "${SECRET_PREFIX}-api-direct-database-url"
  "${SECRET_PREFIX}-worker-database-url"
  "${SECRET_PREFIX}-api-redis-url"
  "${SECRET_PREFIX}-worker-redis-url"
  "${SECRET_PREFIX}-api-csrf-token"
  "${SECRET_PREFIX}-api-firebase-project-id"
  "${SECRET_PREFIX}-api-firebase-client-email"
  "${SECRET_PREFIX}-api-firebase-private-key"
  "${SECRET_PREFIX}-api-openai-api-key"
  "${SECRET_PREFIX}-worker-openai-api-key"
  "${SECRET_PREFIX}-api-error-tracking-webhook-url"
  "${SECRET_PREFIX}-api-error-tracking-api-key"
  "${SECRET_PREFIX}-worker-error-tracking-webhook-url"
  "${SECRET_PREFIX}-worker-error-tracking-api-key"
)

echo "Granting Secret Manager access..."
echo "Project: ${PROJECT_ID}"
echo "Service account: ${SERVICE_ACCOUNT_EMAIL}"
echo "Prefix: ${SECRET_PREFIX}"

for SECRET_NAME in "${SECRETS[@]}"; do
  if gcloud secrets describe "${SECRET_NAME}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    echo "-> ${SECRET_NAME}"
    gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
      --project "${PROJECT_ID}" \
      --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
      --role "roles/secretmanager.secretAccessor" >/dev/null
  else
    echo "-> ${SECRET_NAME} (not found, skipped)"
  fi
done

echo "Done."
