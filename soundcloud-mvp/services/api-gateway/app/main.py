import logging
import os
import sys
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pythonjsonlogger import jsonlogger
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

SERVICE_NAME = "api-gateway"


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    formatter = jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)


configure_logging()
logger = logging.getLogger(SERVICE_NAME)

rate_limit = os.getenv("RATE_LIMIT", "100/minute")
limiter = Limiter(key_func=get_remote_address, default_limits=[rate_limit])

app = FastAPI(title="API Gateway", version="0.1.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, lambda request, exc: JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"}))
app.add_middleware(SlowAPIMiddleware)

cors_allow_origins = [origin.strip() for origin in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_allow_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def csrf_guard(request: Request, call_next):  # type: ignore[no-untyped-def]
    csrf_protect = os.getenv("CSRF_PROTECT", "0") == "1"
    if csrf_protect and request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        if not request.headers.get("x-csrf-token"):
            return JSONResponse(status_code=403, content={"detail": "Missing CSRF token"})

    return await call_next(request)


@app.get("/healthz")
@limiter.limit("30/second")
async def healthz(request: Request) -> dict[str, str]:
    logger.info("healthcheck", extra={"service": SERVICE_NAME})
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/services/health")
@limiter.limit("10/second")
async def services_health(request: Request) -> dict[str, Any]:
    services = {
        "identity": os.getenv("IDENTITY_SERVICE_URL", "http://identity-service:8000"),
        "tracks": os.getenv("TRACKS_SERVICE_URL", "http://tracks-service:8000"),
        "upload": os.getenv("UPLOAD_SERVICE_URL", "http://upload-service:8000"),
        "social": os.getenv("SOCIAL_SERVICE_URL", "http://social-service:8000"),
    }

    results: dict[str, Any] = {}
    async with httpx.AsyncClient(timeout=3.0) as client:
        for service, base_url in services.items():
            try:
                response = await client.get(f"{base_url}/healthz")
                results[service] = {
                    "status": "ok" if response.status_code == 200 else "degraded",
                    "code": response.status_code,
                }
            except Exception as exc:  # pragma: no cover
                results[service] = {"status": "down", "error": str(exc)}

    return {"gateway": "ok", "services": results}
