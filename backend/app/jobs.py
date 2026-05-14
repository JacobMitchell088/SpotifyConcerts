import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any


JOB_TTL_SECONDS = 3600  # purge finished jobs older than 1 hour


@dataclass
class Job:
    id: str
    total: int = 0
    completed: int = 0
    status: str = "pending"  # pending | running | done | error
    results: list[dict] = field(default_factory=list)
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        elapsed = (self.finished_at or time.time()) - self.started_at
        if (
            self.status == "running"
            and self.completed > 0
            and self.completed < self.total
        ):
            per_unit = elapsed / self.completed
            eta = max(0.0, per_unit * (self.total - self.completed))
        elif self.status in ("done", "error"):
            eta = 0.0
        else:
            eta = None
        return {
            "job_id": self.id,
            "status": self.status,
            "completed": self.completed,
            "total": self.total,
            "elapsed_seconds": round(elapsed, 2),
            "eta_seconds": round(eta, 2) if eta is not None else None,
            "results": self.results if self.status == "done" else [],
            "error": self.error,
        }


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = asyncio.Lock()

    async def create(self, total: int) -> Job:
        async with self._lock:
            self._purge_locked()
            job = Job(id=uuid.uuid4().hex, total=total, status="pending")
            self._jobs[job.id] = job
            return job

    async def get(self, job_id: str) -> Job | None:
        async with self._lock:
            return self._jobs.get(job_id)

    async def update_progress(self, job_id: str, completed: int, total: int) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.completed = completed
                job.total = total
                if job.status == "pending":
                    job.status = "running"

    async def mark_running(self, job_id: str) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = "running"

    async def mark_done(self, job_id: str, results: list[dict]) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = "done"
                job.results = results
                job.completed = job.total
                job.finished_at = time.time()

    async def mark_error(self, job_id: str, error: str) -> None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = "error"
                job.error = error
                job.finished_at = time.time()

    def _purge_locked(self) -> None:
        now = time.time()
        stale = [
            jid
            for jid, j in self._jobs.items()
            if j.finished_at and (now - j.finished_at) > JOB_TTL_SECONDS
        ]
        for jid in stale:
            del self._jobs[jid]


store = JobStore()
