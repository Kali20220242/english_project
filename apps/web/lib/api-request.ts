const publicCsrfToken = (process.env.NEXT_PUBLIC_CSRF_TOKEN ?? "").trim();

type BuildApiHeadersInput = {
  token?: string | null;
  json?: boolean;
};

export function buildApiHeaders(input: BuildApiHeadersInput = {}) {
  const headers: Record<string, string> = {};

  if (input.json) {
    headers["Content-Type"] = "application/json";
  }

  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }

  if (publicCsrfToken) {
    headers["X-CSRF-Token"] = publicCsrfToken;
  }

  return headers;
}
