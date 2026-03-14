import json
import logging
import os
import sys
import time

from pythonjsonlogger import jsonlogger
from redis import Redis

SERVICE_NAME = "processing-worker"
QUEUE_NAME = os.getenv("PROCESSING_QUEUE", "processing:jobs")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
POLL_DELAY_SECONDS = float(os.getenv("WORKER_POLL_DELAY", "2"))


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    formatter = jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


configure_logging()
logger = logging.getLogger(SERVICE_NAME)


def main() -> None:
    redis_client = Redis.from_url(REDIS_URL, decode_responses=True)
    logger.info("worker_started", extra={"queue": QUEUE_NAME})

    while True:
        item = redis_client.brpop(QUEUE_NAME, timeout=3)
        if not item:
            time.sleep(POLL_DELAY_SECONDS)
            continue

        _, payload = item
        try:
            job = json.loads(payload)
        except json.JSONDecodeError:
            logger.warning("invalid_job_payload", extra={"payload": payload})
            continue

        logger.info("job_received", extra={"job": job})
        # Placeholder for FFmpeg pipeline.
        time.sleep(0.5)
        logger.info("job_completed", extra={"job_id": job.get("job_id")})


if __name__ == "__main__":
    main()
