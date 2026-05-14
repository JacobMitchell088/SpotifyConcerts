"""Shared fixtures. Sets env vars *before* importing the app so that
pydantic-settings sees fake values and the import doesn't crash."""
import os

os.environ.setdefault("SPOTIFY_CLIENT_ID", "test-client-id")
os.environ.setdefault("SPOTIFY_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault(
    "SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8000/api/auth/callback"
)
os.environ.setdefault("TICKETMASTER_API_KEY", "test-tm-key")
os.environ.setdefault("SESSION_SECRET", "test-session-secret-please-do-not-use")
os.environ.setdefault("FRONTEND_URL", "http://127.0.0.1:5173")

import pytest
from fastapi.testclient import TestClient

from app import jobs, main


@pytest.fixture
def client():
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def _fresh_jobstore():
    """Reset the in-memory job store between tests."""
    jobs.store = jobs.JobStore()
    main.jobs.store = jobs.store
    yield
