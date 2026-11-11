"""Shared pytest setup.

The API tests call the real app (api.main) directly, without signing in.
The sign-in gate fails closed when it is not configured, so tests switch it
off here unless the environment already says otherwise. tests/test_site_auth.py
does not depend on this: it injects its own environment.
"""

import os

import pytest

os.environ.setdefault("V4W_AUTH_DISABLED", "1")


@pytest.fixture
def signed_in_admin():
    """An Auth0 admin with read access, for tests about what an admin route
    does rather than who may call it. Only token verification is replaced;
    the permission check still runs. Sign-in itself is tested in
    tests/test_auth.py and tests/test_admin_gate.py."""
    from api.auth import verify_token
    from api.main import app

    app.dependency_overrides[verify_token] = lambda: {"sub": "auth0|test-admin", "permissions": ["read:admin"]}
    try:
        yield
    finally:
        app.dependency_overrides.pop(verify_token, None)


@pytest.fixture(autouse=True)
def ledger_database_is_never_the_shared_one(monkeypatch):
    """db.pipeline.connect() opens V4W_DATABASE_URL: the shared database. The
    admin routes call it, so a test that forgot to supply its own database
    would read or write the real one. Here that becomes a loud failure.
    Tests that need a ledger database replace connect() themselves
    (admin_db in test_admin_api.py); `refused.real` is the original, for the
    one test about connect() itself."""
    from db import pipeline

    def refused():
        raise AssertionError("a test reached db.pipeline.connect() without supplying a test database")

    refused.real = pipeline.connect
    monkeypatch.setattr(pipeline, "connect", refused)
