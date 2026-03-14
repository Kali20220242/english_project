import logging
import sys
from typing import List

from fastapi import FastAPI
from pydantic import BaseModel
from pythonjsonlogger import jsonlogger

SERVICE_NAME = "tracks-service"


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

app = FastAPI(title="Tracks Service", version="0.1.0")


class TrackIn(BaseModel):
    title: str
    artist: str


class TrackOut(TrackIn):
    id: str


_TRACKS: list[TrackOut] = []


@app.get("/healthz")
def healthz() -> dict[str, str]:
    logger.info("healthcheck", extra={"service": SERVICE_NAME})
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/tracks", response_model=List[TrackOut])
def list_tracks() -> list[TrackOut]:
    return _TRACKS


@app.post("/tracks", response_model=TrackOut)
def create_track(payload: TrackIn) -> TrackOut:
    track = TrackOut(id=str(len(_TRACKS) + 1), **payload.model_dump())
    _TRACKS.append(track)
    return track
