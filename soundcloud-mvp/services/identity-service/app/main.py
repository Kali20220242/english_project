import logging
import sys

from fastapi import FastAPI
from pydantic import BaseModel
from pythonjsonlogger import jsonlogger

SERVICE_NAME = "identity-service"


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

app = FastAPI(title="Identity Service", version="0.1.0")


class TokenPayload(BaseModel):
    id_token: str


@app.get("/healthz")
def healthz() -> dict[str, str]:
    logger.info("healthcheck", extra={"service": SERVICE_NAME})
    return {"status": "ok", "service": SERVICE_NAME}


@app.post("/auth/verify")
def verify_token(payload: TokenPayload) -> dict[str, str]:
    # Placeholder until Firebase Admin verification is wired in.
    return {"status": "accepted", "token_preview": payload.id_token[:12]}
