import json
import logging
import os
import sys
from uuid import uuid4

from fastapi import FastAPI
from pydantic import BaseModel
from pythonjsonlogger import jsonlogger
from redis import Redis

SERVICE_NAME = "upload-service"
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
QUEUE_NAME = os.getenv("PROCESSING_QUEUE", "processing:jobs")
MINIO_BUCKET = os.getenv("MINIO_BUCKET", "tracks")
MINIO_ENDPOINT = os.getenv("MINIO_ENDPOINT", "http://minio:9000")


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

app = FastAPI(title="Upload Service", version="0.1.0")


class UploadRequest(BaseModel):
    filename: str
    content_type: str


@app.get("/healthz")
def healthz() -> dict[str, str]:
    logger.info("healthcheck", extra={"service": SERVICE_NAME})
    return {"status": "ok", "service": SERVICE_NAME}


@app.post("/uploads/presign")
def create_presigned_upload(payload: UploadRequest) -> dict[str, str]:
    object_key = f"raw/{uuid4()}-{payload.filename}"
    upload_url = f"{MINIO_ENDPOINT}/{MINIO_BUCKET}/{object_key}"

    redis_client = Redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.lpush(
        QUEUE_NAME,
        json.dumps({"job_id": str(uuid4()), "object_key": object_key, "content_type": payload.content_type}),
    )

    return {
        "upload_url": upload_url,
        "object_key": object_key,
        "bucket": MINIO_BUCKET,
        "status": "queued",
    }
