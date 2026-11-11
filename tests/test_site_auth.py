"""Tests for the shared-password sign-in (api/site_auth.py).

No database and no model: a small FastAPI app with one API route and a
static folder stands in for the real one, with the same install_auth() call
api/main.py makes. The clock and the environment are injected, so nothing
here sleeps or touches os.environ.

Run from the repo root:  python -m pytest tests/test_site_auth.py -v
"""

import os
import sys
import threading

import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from api.site_auth import (  # noqa: E402
    GLOBAL_LOCKOUT_FAILURES,
    LOCKOUT_FAILURES,
    LOCKOUT_WINDOW_SEC,
    MAX_LOGIN_BODY_BYTES,
    MAX_PASSWORD_CHARS,
    MAX_TRACKED_ADDRESSES,
    PUBLIC_PATHS,
    SESSION_COOKIE,
    SESSION_TTL_SEC,
    FailureLimiter,
    address_bucket,
    hash_password,
    install_auth,
    issue_session,
    load_settings,
    session_is_valid,
    verify_password,
)

PASSWORD = "correct horse battery staple"
SECRET = "s" * 48
START = 1_800_000_000.0


class Clock:
    """A clock the test moves by hand."""

    def __init__(self, now: float = START):
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture(scope="module")
def password_hash() -> str:
    return hash_password(PASSWORD)


@pytest.fixture
def env(password_hash) -> dict:
    return {"V4W_APP_PASSWORD_HASH": password_hash, "V4W_SESSION_SECRET": SECRET}


def build_client(tmp_path, env: dict, clock: Clock | None = None, **client_kwargs) -> TestClient:
    (tmp_path / "index.html").write_text("<h1>console</h1>")
    (tmp_path / "login.html").write_text("<h1>sign in</h1>")
    (tmp_path / "login.js").write_text("// sign in")
    app = FastAPI()
    install_auth(app, env=env, clock=clock or Clock())

    @app.get("/api/data")
    def data():
        return {"calls": 42}

    app.mount("/", StaticFiles(directory=str(tmp_path), html=True), name="web")
    return TestClient(app, follow_redirects=False, **client_kwargs)


# ---- password hashing ----

def test_verifies_the_right_password_and_rejects_a_wrong_one(password_hash):
    assert verify_password(PASSWORD, password_hash) is True
    assert verify_password(PASSWORD + "x", password_hash) is False
    assert verify_password("", password_hash) is False


def test_hash_never_contains_the_password_and_is_salted(password_hash):
    assert PASSWORD not in password_hash
    assert hash_password(PASSWORD) != password_hash


@pytest.mark.parametrize("stored", ["", "plain-text", "scrypt$1$2", "scrypt$x$8$1$AAAA$AAAA", "md5$1$1$1$AAAA$AAAA"])
def test_malformed_stored_hash_never_verifies(stored):
    assert verify_password(PASSWORD, stored) is False


# ---- session tokens ----

def test_session_is_valid_until_it_expires():
    token = issue_session(SECRET, START)

    assert session_is_valid(token, SECRET, START + SESSION_TTL_SEC - 1) is True
    assert session_is_valid(token, SECRET, START + SESSION_TTL_SEC + 1) is False


def test_tampered_or_foreign_sessions_are_rejected():
    token = issue_session(SECRET, START)
    version, expires, signature = token.split(".")
    extended = f"{version}.{int(expires) + 10_000}.{signature}"

    assert session_is_valid(extended, SECRET, START) is False
    assert session_is_valid(token, "another-secret-" * 4, START) is False
    assert session_is_valid(token[:-2] + "00", SECRET, START) is False
    for junk in (None, "", "a.b.c", "v1.notanumber.sig", "v1.123", "v9." + expires + "." + signature):
        assert session_is_valid(junk, SECRET, START) is False


# ---- configuration ----

def test_settings_are_on_only_with_a_hash_and_a_long_secret(env):
    assert load_settings(env).mode == "on"
    assert load_settings({}).mode == "misconfigured"
    assert load_settings({**env, "V4W_SESSION_SECRET": "short"}).mode == "misconfigured"
    assert load_settings({"V4W_SESSION_SECRET": SECRET}).mode == "misconfigured"


def test_the_off_switch_works_locally_but_never_on_vercel(env):
    assert load_settings({"V4W_AUTH_DISABLED": "1"}).mode == "off"
    assert load_settings({"V4W_AUTH_DISABLED": "1", "VERCEL": "1"}).mode == "misconfigured"
    assert load_settings({**env, "V4W_AUTH_DISABLED": "1", "VERCEL": "1"}).mode == "on"


# ---- the gate ----

def test_signed_out_api_calls_get_401_and_pages_go_to_sign_in(tmp_path, env):
    client = build_client(tmp_path, env)

    api = client.get("/api/data")
    page = client.get("/")

    assert api.status_code == 401
    assert "calls" not in api.text
    assert page.status_code == 303
    assert page.headers["location"] == "/login.html"
    assert client.get("/index.html").status_code == 303
    assert client.get("/docs").status_code == 303
    assert client.get("/openapi.json").status_code == 303


def test_sign_in_page_and_its_script_are_public(tmp_path, env):
    client = build_client(tmp_path, env)

    assert client.get("/login.html").status_code == 200
    assert client.get("/login.js").status_code == 200


def test_wrong_password_sets_no_cookie(tmp_path, env):
    client = build_client(tmp_path, env)

    response = client.post("/api/login", json={"password": "nope"})

    assert response.status_code == 401
    assert "set-cookie" not in response.headers
    assert client.get("/api/data").status_code == 401


def test_right_password_opens_the_page_and_the_api(tmp_path, env):
    client = build_client(tmp_path, env)

    response = client.post("/api/login", json={"password": PASSWORD})

    assert response.status_code == 204
    cookie = response.headers["set-cookie"].lower()
    assert cookie.startswith(f"{SESSION_COOKIE}=")
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/" in cookie
    assert f"max-age={SESSION_TTL_SEC}" in cookie
    assert client.get("/api/data").json() == {"calls": 42}
    assert client.get("/").status_code == 200
    assert client.get("/api/session").json() == {"auth_required": True}


def test_cookie_is_marked_secure_behind_https(tmp_path, env):
    client = build_client(tmp_path, env)

    plain = client.post("/api/login", json={"password": PASSWORD})
    forwarded = client.post("/api/login", json={"password": PASSWORD}, headers={"x-forwarded-proto": "https"})

    assert "secure" not in plain.headers["set-cookie"].lower()
    assert "secure" in forwarded.headers["set-cookie"].lower()


def test_cookie_is_always_secure_on_vercel(tmp_path, env):
    client = build_client(tmp_path, {**env, "VERCEL": "1"})

    response = client.post("/api/login", json={"password": PASSWORD})

    assert "secure" in response.headers["set-cookie"].lower()


def test_session_stops_working_after_it_expires(tmp_path, env):
    clock = Clock()
    client = build_client(tmp_path, env, clock)
    client.post("/api/login", json={"password": PASSWORD})

    clock.now += SESSION_TTL_SEC + 1

    assert client.get("/api/data").status_code == 401


def test_sign_out_closes_the_session(tmp_path, env):
    client = build_client(tmp_path, env)
    client.post("/api/login", json={"password": PASSWORD})

    response = client.post("/api/logout")

    assert response.status_code == 204
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert client.get("/api/data").status_code == 401


def test_a_forged_cookie_is_refused(tmp_path, env):
    client = build_client(tmp_path, env)
    client.cookies.set(SESSION_COOKIE, issue_session("attacker-secret-" * 3, START))

    assert client.get("/api/data").status_code == 401


def test_repeated_wrong_passwords_lock_sign_in_for_a_while(tmp_path, env):
    clock = Clock()
    client = build_client(tmp_path, env, clock)
    for _ in range(LOCKOUT_FAILURES):
        assert client.post("/api/login", json={"password": "guess"}).status_code == 401

    locked = client.post("/api/login", json={"password": PASSWORD})

    assert locked.status_code == 429
    assert int(locked.headers["retry-after"]) > 0
    assert "set-cookie" not in locked.headers

    clock.now += LOCKOUT_WINDOW_SEC + 1

    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 204


def test_a_success_clears_earlier_failures(tmp_path, env):
    client = build_client(tmp_path, env)
    for _ in range(LOCKOUT_FAILURES - 1):
        client.post("/api/login", json={"password": "guess"})
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 204

    for _ in range(LOCKOUT_FAILURES - 1):
        assert client.post("/api/login", json={"password": "guess"}).status_code == 401


@pytest.mark.parametrize("body", [{}, {"password": ""}, {"password": "x" * (MAX_PASSWORD_CHARS + 1)}, {"password": 123}])
def test_sign_in_rejects_malformed_input(tmp_path, env, body):
    client = build_client(tmp_path, env)

    assert client.post("/api/login", json=body).status_code == 422


def test_everything_is_refused_when_sign_in_is_not_configured(tmp_path):
    client = build_client(tmp_path, {})

    assert client.get("/api/data").status_code == 503
    assert client.get("/").status_code == 503
    assert client.get("/login.html").status_code == 503
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 503


def test_the_local_off_switch_lets_requests_through(tmp_path):
    client = build_client(tmp_path, {"V4W_AUTH_DISABLED": "1"})

    assert client.get("/api/data").json() == {"calls": 42}
    assert client.get("/").status_code == 200
    assert client.get("/api/session").json() == {"auth_required": False}


def test_responses_carry_the_hardening_headers(tmp_path, env):
    client = build_client(tmp_path, env)
    client.post("/api/login", json={"password": PASSWORD})

    api = client.get("/api/data")
    page = client.get("/login.html")

    assert api.headers["cache-control"] == "no-store"
    for response in (api, page):
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["referrer-policy"] == "no-referrer"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_failed_sign_in_does_not_say_what_was_wrong(tmp_path, env):
    client = build_client(tmp_path, env)

    response = client.post("/api/login", json={"password": "guess"})

    assert response.json() == {"detail": "Wrong password"}


# ---- hardening added after the security review ----

def test_only_the_allowed_number_of_attempts_is_ever_admitted():
    limiter = FailureLimiter()

    waits = [limiter.admit("203.0.113.9", START) for _ in range(30)]

    assert waits.count(0) == LOCKOUT_FAILURES            # a burst cannot slip past the count
    assert all(w > 0 for w in waits[LOCKOUT_FAILURES:])


def test_admission_is_safe_when_attempts_arrive_at_the_same_time():
    limiter = FailureLimiter()
    admitted = []

    def attempt():
        admitted.append(limiter.admit("203.0.113.9", START) == 0)

    threads = [threading.Thread(target=attempt) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(admitted) == LOCKOUT_FAILURES


def test_guessing_from_many_addresses_hits_a_shared_limit():
    limiter = FailureLimiter()
    for i in range(GLOBAL_LOCKOUT_FAILURES):
        assert limiter.admit(f"198.51.100.{i % 250}.{i}", START) == 0

    assert limiter.admit("a-brand-new-address", START) > 0
    assert limiter.admit("a-brand-new-address", START + LOCKOUT_WINDOW_SEC + 1) == 0


def test_a_success_gives_the_attempt_back():
    limiter = FailureLimiter()
    for _ in range(LOCKOUT_FAILURES * 3):
        assert limiter.admit("203.0.113.9", START) == 0
        limiter.forgive("203.0.113.9")


def test_the_limiter_never_tracks_more_addresses_than_its_cap():
    limiter = FailureLimiter(global_failures=10 ** 9)
    for i in range(MAX_TRACKED_ADDRESSES + 500):
        limiter.admit(f"address-{i}", START + i * 0.001)

    assert limiter.tracked() <= MAX_TRACKED_ADDRESSES


def test_ipv6_addresses_share_a_bucket_per_network_and_ipv4_do_not():
    assert address_bucket("2001:db8:1:2:aaaa::1") == address_bucket("2001:db8:1:2:bbbb::9")
    assert address_bucket("2001:db8:1:2::1") != address_bucket("2001:db8:1:3::1")
    assert address_bucket("203.0.113.9") == "203.0.113.9"
    assert address_bucket("203.0.113.9") != address_bucket("203.0.113.10")
    assert address_bucket("not an address") == "not an address"


def test_an_oversized_sign_in_body_is_refused_before_it_is_parsed(tmp_path, env):
    client = build_client(tmp_path, env)

    response = client.post("/api/login", json={"password": "x" * (MAX_LOGIN_BODY_BYTES * 4)})

    assert response.status_code == 413


def test_the_off_switch_is_ignored_inside_the_deployed_image(env):
    assert load_settings({"V4W_AUTH_DISABLED": "1", "V4W_DEPLOYED": "1"}).mode == "misconfigured"
    assert load_settings({**env, "V4W_AUTH_DISABLED": "1", "V4W_DEPLOYED": "1"}).mode == "on"


def test_changing_the_password_ends_existing_sessions(tmp_path, env):
    client = build_client(tmp_path, env)
    client.post("/api/login", json={"password": PASSWORD})
    assert client.get("/api/data").status_code == 200

    env["V4W_APP_PASSWORD_HASH"] = hash_password("a different password entirely")

    assert client.get("/api/data").status_code == 401


def test_deployed_lockout_follows_the_address_the_proxy_reports(tmp_path, env):
    client = build_client(tmp_path, {**env, "V4W_DEPLOYED": "1"})
    for _ in range(LOCKOUT_FAILURES):
        client.post("/api/login", json={"password": "guess"}, headers={"x-real-ip": "203.0.113.9"})

    same = client.post("/api/login", json={"password": PASSWORD}, headers={"x-real-ip": "203.0.113.9"})
    other = client.post("/api/login", json={"password": PASSWORD}, headers={"x-real-ip": "203.0.113.77"})

    assert same.status_code == 429
    assert other.status_code == 204


# ---- the real app ----

@pytest.fixture
def real_app(monkeypatch, password_hash):
    """api.main with sign-in switched on (the API tests run it switched off)."""
    # Import first: api.main loads .env on import, which may switch sign-in off
    # for local work. The settings are read per request, so set them after.
    from api.main import app
    monkeypatch.setenv("V4W_AUTH_DISABLED", "0")
    monkeypatch.setenv("V4W_APP_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("V4W_SESSION_SECRET", SECRET)
    return app


def test_every_route_of_the_real_app_needs_a_session(real_app):
    client = TestClient(real_app, follow_redirects=False)
    api_paths = sorted({r.path for r in real_app.routes if getattr(r, "path", "").startswith("/api/")} - PUBLIC_PATHS)

    assert {"/api/forecast", "/api/staffing", "/api/planned", "/api/model", "/api/session"} <= set(api_paths)
    for path in api_paths:
        assert client.get(path).status_code == 401, path
        assert client.post(path, json={}).status_code == 401, path
    for page in ("/", "/index.html", "/app.js", "/logic.js", "/charts.js", "/docs", "/redoc", "/openapi.json"):
        assert client.get(page).status_code == 303, page
    assert client.get("/login.html").status_code == 200


def test_the_real_app_serves_no_api_docs_even_when_signed_in(real_app):
    client = TestClient(real_app, follow_redirects=False)
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 204

    for page in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(page).status_code == 404, page


def test_a_database_error_never_echoes_the_connection_string(real_app, monkeypatch):
    monkeypatch.setenv("V4W_DATABASE_URL", "postgresql://user:hunter2-secret%zz@127.0.0.1:1/db")
    client = TestClient(real_app, follow_redirects=False)
    client.post("/api/login", json={"password": PASSWORD})

    response = client.get("/api/model")

    assert response.status_code == 503
    assert "hunter2" not in response.text
    assert "127.0.0.1" not in response.text
