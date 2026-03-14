import logging
import sys
from collections import defaultdict

from fastapi import FastAPI
from pydantic import BaseModel
from pythonjsonlogger import jsonlogger

SERVICE_NAME = "social-service"


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

app = FastAPI(title="Social Service", version="0.1.0")
_likes: defaultdict[str, set[str]] = defaultdict(set)


class LikePayload(BaseModel):
    user_id: str
    track_id: str


@app.get("/healthz")
def healthz() -> dict[str, str]:
    logger.info("healthcheck", extra={"service": SERVICE_NAME})
    return {"status": "ok", "service": SERVICE_NAME}


@app.post("/likes")
def like_track(payload: LikePayload) -> dict[str, int]:
    _likes[payload.track_id].add(payload.user_id)
    return {"track_likes": len(_likes[payload.track_id])}
