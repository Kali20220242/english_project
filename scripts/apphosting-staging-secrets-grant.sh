#!/usr/bin/env bash

set -euo pipefail

PROJECT_ID="${1:-}"
BACKEND_ID="${2:-}"
LOCATION="${3:-us-central1}"

if [[ -z "$PROJECT_ID" || -z "$BACKEND_ID" ]]; then
  echo "Usage: $0 <PROJECT_ID> <BACKEND_ID> [LOCATION]"
  exit 1
fi

SECRETS=(
  "neontalk-staging-next-public-api-base-url"
  "neontalk-staging-next-public-firebase-api-key"
  "neontalk-staging-next-public-firebase-auth-domain"
  "neontalk-staging-next-public-firebase-project-id"
  "neontalk-staging-next-public-firebase-app-id"
  "neontalk-staging-next-public-csrf-token"
)

echo "Granting App Hosting backend access to staging secrets..."
echo "Project: ${PROJECT_ID}"
echo "Backend: ${BACKEND_ID}"
echo "Location: ${LOCATION}"

for SECRET_KEY in "${SECRETS[@]}"; do
  echo "-> ${SECRET_KEY}"
  firebase apphosting:secrets:grantaccess "${SECRET_KEY}" "${BACKEND_ID}" \
    --project "${PROJECT_ID}" \
    --location "${LOCATION}"
done

echo "Done."
