"""The shared-password gate and Auth0 side by side, on the real app.

Staffing pages and their API need the shared-password session. The admin
page and /api/admin/* do not: they are guarded by Auth0 access tokens
instead. No database and no Auth0 network call is made here: every request
either carries no token or stops before a token would be verified.

Run from the repo root:  python -m pytest tests/test_admin_gate.py -v
"""

import asyncio
import hashlib
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.main import app  # noqa: E402
from api.site_auth import hash_password, needs_session  # noqa: E402

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
AUTH0_SCRIPT = "/vendor/auth0-spa-js.production.js"
TENANT = "tenant.example.auth0.com"
AUDIENCE = "https://api.example.test"
CLIENT_ID = "client-id-for-tests"
SIGN_IN_REQUIRED = "Sign in required"
TOKEN_REQUIRED = "Invalid or missing access token"
ADMIN_NOT_CONFIGURED = "Admin sign-in is not configured on this server."
TOKEN_CHECK_NOT_CONFIGURED = "Authentication is not configured"
# Auth0 SPA SDK 2.29, as published at
# https://cdn.auth0.com/js/auth0-spa-js/2.29/auth0-spa-js.production.js
AUTH0_SCRIPT_SHA256 = "6973ffd2bab5e13bfea9ba18786c7ca34d0f484436976c7b6befb8724b2cbfe7"


@pytest.fixture(scope="module")
def password_hash() -> str:
    return hash_password("a password nobody sends in these tests")


@pytest.fixture
def gate_on(monkeypatch, password_hash):
    """The shared-password gate as it runs on the server, Auth0 configured."""
    monkeypatch.delenv("V4W_AUTH_DISABLED", raising=False)
    monkeypatch.setenv("V4W_APP_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("V4W_SESSION_SECRET", "s" * 48)
    monkeypatch.setenv("AUTH0_DOMAIN", TENANT)
    monkeypatch.setenv("AUTH0_AUDIENCE", AUDIENCE)
    monkeypatch.setenv("AUTH0_CLIENT_ID", CLIENT_ID)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app, follow_redirects=False)


def _policy(response) -> str:
    return response.headers["content-security-policy"]


def _raw_get(path: str) -> tuple[int, dict[str, str]]:
    """GET `path` exactly as written. TestClient tidies "../" out of a URL
    before sending it; a real attacker's client does not have to."""
    messages = []
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
             "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
             "headers": [(b"host", b"testserver")], "client": ("127.0.0.1", 50000), "server": ("testserver", 80)}

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    asyncio.run(app(scope, receive, send))
    start = next(m for m in messages if m["type"] == "http.response.start")
    return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}


# --- the staffing side is still locked -------------------------------------

def test_staffing_page_still_needs_the_password(gate_on, client):
    page = client.get("/")
    assert page.status_code == 303
    assert page.headers["location"] == "/login.html"


def test_staffing_api_still_needs_the_password(gate_on, client):
    response = client.get("/api/model")
    assert response.status_code == 401
    assert response.json()["detail"] == SIGN_IN_REQUIRED


@pytest.mark.parametrize("path", ["/api/administrator", "/api/admin", "/admin.html.bak", "/vendor/other.js"])
def test_lookalike_paths_are_not_public(gate_on, client, path):
    response = client.get(path)
    locked = response.status_code == 303 or response.json()["detail"] == SIGN_IN_REQUIRED
    assert locked, f"{path} answered {response.status_code} without a session"


SNEAKY_PATHS = [
    "/api/admin/../../index.html",
    "/api/admin/../../app.js",
    "/api/admin/../index.html",
    "/api/admin/./../../index.html",
    "/api/admin//../../index.html",
    "/api/admin/..\\..\\index.html",
    "/api/admin/uploads/../../../logic.js",
]


@pytest.mark.parametrize("path", SNEAKY_PATHS)
def test_admin_prefix_cannot_be_used_to_step_back_into_the_staffing_files(gate_on, path):
    status, headers = _raw_get(path)
    assert status in (303, 401), f"{path} answered {status} without a session"
    if status == 303:
        assert headers["location"] == "/login.html"


@pytest.mark.parametrize("path", SNEAKY_PATHS + ["/api/admin/", "/api/admin", "/API/ADMIN/me"])
def test_only_plain_admin_paths_skip_the_session(path):
    assert needs_session(path)


@pytest.mark.parametrize("path", ["/api/admin/me", "/api/admin/config", "/api/admin/uploads",
                                  "/api/admin/uploads/00000000-0000-0000-0000-000000000001/import",
                                  "/admin.html", "/admin.js", AUTH0_SCRIPT, "/login.html"])
def test_real_admin_and_sign_in_paths_skip_the_session(path):
    assert not needs_session(path)


# --- the admin side is reached without the password, and needs a token -----

@pytest.mark.parametrize("path", ["/admin.html", "/admin.js", AUTH0_SCRIPT])
def test_admin_page_files_are_served_without_the_password(gate_on, client, path):
    assert client.get(path).status_code == 200


def test_admin_api_is_answered_by_auth0_not_by_the_password_gate(gate_on, client):
    response = client.get("/api/admin/me")
    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REQUIRED
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("method,path", [
    ("GET", "/api/admin/me"),
    ("GET", "/api/admin/uploads"),
    ("POST", "/api/admin/validate"),
    ("POST", "/api/admin/uploads"),
    ("POST", "/api/admin/uploads/00000000-0000-0000-0000-000000000001/import"),
])
def test_every_admin_route_refuses_a_request_without_a_token(gate_on, client, method, path):
    is_import = path.endswith("/import")
    files = {"file": ("calls.xlsx", b"not a workbook", "application/octet-stream")}
    response = client.request(method, path,
                              files=files if method == "POST" and not is_import else None,
                              data={"month": "2026-09"} if method == "POST" and not is_import else None,
                              json={"expected_rows": 1} if is_import else None)
    assert response.status_code == 401, f"{method} {path} answered {response.status_code}"
    assert response.json()["detail"] == TOKEN_REQUIRED


def test_switching_the_password_gate_off_does_not_switch_auth0_off(gate_on, client, monkeypatch):
    monkeypatch.setenv("V4W_AUTH_DISABLED", "1")
    assert client.get("/").status_code == 200, "the password gate should be off here"
    response = client.get("/api/admin/me")
    assert response.status_code == 401
    assert response.json()["detail"] == TOKEN_REQUIRED


def test_admin_api_says_not_configured_when_auth0_settings_are_missing(gate_on, client, monkeypatch):
    monkeypatch.delenv("AUTH0_DOMAIN")
    response = client.get("/api/admin/me", headers={"Authorization": "Bearer anything"})
    assert response.status_code == 503
    assert response.json()["detail"] == TOKEN_CHECK_NOT_CONFIGURED


def test_oversized_upload_refusal_still_carries_the_security_headers(gate_on, client):
    response = client.post("/api/admin/uploads", content=b"x",
                           headers={"content-length": str(10 ** 9), "content-type": "multipart/form-data; boundary=x"})
    assert response.status_code == 413
    assert "frame-ancestors 'none'" in _policy(response)
    assert response.headers["x-content-type-options"] == "nosniff"


# --- /api/admin/config: what the admin page needs to start Auth0 ------------

def test_config_gives_the_page_the_auth0_settings_without_a_session(gate_on, client):
    response = client.get("/api/admin/config")
    assert response.status_code == 200
    assert response.json() == {"domain": TENANT, "clientId": CLIENT_ID, "audience": AUDIENCE}


@pytest.mark.parametrize("missing", ["AUTH0_DOMAIN", "AUTH0_AUDIENCE", "AUTH0_CLIENT_ID"])
def test_config_is_unavailable_when_a_setting_is_missing(gate_on, client, monkeypatch, missing):
    monkeypatch.delenv(missing)
    response = client.get("/api/admin/config")
    assert response.status_code == 503
    assert response.json()["detail"] == ADMIN_NOT_CONFIGURED


def test_config_refuses_a_domain_that_is_not_a_hostname(gate_on, client, monkeypatch):
    monkeypatch.setenv("AUTH0_DOMAIN", "evil.example; script-src *")
    response = client.get("/api/admin/config")
    assert response.status_code == 503
    assert response.json()["detail"] == ADMIN_NOT_CONFIGURED


# --- security header ---------------------------------------------------------

def test_admin_page_may_talk_to_the_configured_auth0_domain_only(gate_on, client):
    policy = _policy(client.get("/admin.html"))
    assert f"connect-src 'self' https://{TENANT};" in policy
    assert f"frame-src https://{TENANT};" in policy
    assert "script-src 'self';" in policy
    assert "cdn.auth0.com" not in policy


def test_other_pages_keep_the_strict_header(gate_on, client):
    for path in ("/login.html", "/"):
        policy = _policy(client.get(path))
        assert "auth0" not in policy
        assert "connect-src 'self';" in policy
        assert "frame-src" not in policy


def test_admin_page_keeps_the_strict_header_when_no_tenant_is_configured(gate_on, client, monkeypatch):
    monkeypatch.delenv("AUTH0_DOMAIN")
    assert _policy(client.get("/admin.html")) == _policy(client.get("/login.html"))


def test_a_bad_auth0_domain_cannot_inject_into_the_header(gate_on, client, monkeypatch):
    monkeypatch.setenv("AUTH0_DOMAIN", "evil.example; script-src *")
    policy = _policy(client.get("/admin.html"))
    assert "evil.example" not in policy
    assert "script-src 'self';" in policy


# --- the page itself ---------------------------------------------------------

def test_admin_page_loads_the_auth0_library_from_this_site():
    html = (WEB_DIR / "admin.html").read_text(encoding="utf-8")
    assert 'src="vendor/auth0-spa-js.production.js"' in html
    assert "cdn.auth0.com" not in html


def test_the_auth0_library_is_the_published_file_unchanged():
    served = (WEB_DIR / "vendor" / "auth0-spa-js.production.js").read_bytes()
    assert hashlib.sha256(served).hexdigest() == AUTH0_SCRIPT_SHA256


def test_admin_script_has_no_tenant_values_written_into_it():
    script = (WEB_DIR / "admin.js").read_text(encoding="utf-8")
    assert ".auth0.com" not in script
    assert "/api/admin/config" in script
