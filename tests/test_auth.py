"""Authentication tests use a local mock OIDC issuer; no provider credentials."""
from base64 import b64encode
import json
import time
from urllib.parse import parse_qs, urlsplit

from authlib.integrations.starlette_client import OAuth
from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
from itsdangerous import TimestampSigner
from joserfc import jwt
from joserfc.jwk import RSAKey
import pytest

from api import auth
from api.admin import router as admin_router

SECRET = "synthetic-session-secret-for-tests-123456789"


def cookie(email="admin@example.test", signed_in_at=None):
    payload = {"user": {"email": email, "sub": "test-subject", "signed_in_at": signed_in_at or time.time()}, "csrf": "test-csrf"}
    return TimestampSigner(SECRET).sign(b64encode(json.dumps(payload).encode())).decode()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("V4W_SESSION_SECRET", SECRET)
    monkeypatch.setenv("V4W_ADMIN_EMAILS", "admin@example.test,trainer@example.test")
    monkeypatch.setenv("V4W_VIEWER_EMAILS", "viewer@example.test")
    monkeypatch.setenv("V4W_REQUIRE_AUTH", "true")
    monkeypatch.setenv("V4W_COOKIE_SECURE", "false")
    monkeypatch.setenv("V4W_PUBLIC_URL", "https://testserver")
    app = FastAPI()
    auth.install_auth(app)
    app.include_router(admin_router)

    @app.get("/api/forecast")
    def forecast():
        return {"ok": True}

    return TestClient(app, follow_redirects=False)


def test_unauthenticated_access_is_blocked_and_login_is_public(client):
    assert client.get("/api/forecast").status_code == 401
    assert client.get("/api/admin/uploads").status_code == 401
    assert client.get("/admin").headers["location"] == "/login?next=admin"
    assert client.get("/login").status_code == 200
    assert client.get("/api/session").json()["user"] is None


def test_viewer_can_use_dashboard_but_not_upload(client):
    client.cookies.set("v4w_session", cookie("viewer@example.test"))
    assert client.get("/api/forecast").status_code == 200
    assert client.get("/api/admin/uploads").status_code == 403
    assert client.post("/api/admin/uploads").status_code == 403


def test_admin_csrf_logout_and_allowlist_revocation(client, monkeypatch):
    client.cookies.set("v4w_session", cookie())
    assert client.get("/admin").status_code == 200
    assert client.post("/auth/logout").status_code == 403
    assert client.post("/auth/logout", headers={"X-CSRF-Token": "wrong"}).status_code == 403
    assert client.post("/auth/logout", headers={"X-CSRF-Token": "test-csrf"}).status_code == 200
    # A subsequent request with no cookie cannot access the portal.
    client.cookies.clear()
    assert client.get("/api/session").json()["user"] is None
    client.cookies.set("v4w_session", cookie())
    monkeypatch.setenv("V4W_ADMIN_EMAILS", "trainer@example.test")
    assert client.get("/api/admin/uploads").status_code == 401


def test_expired_and_tampered_sessions_are_rejected(client):
    client.cookies.set("v4w_session", cookie(signed_in_at=time.time() - 9 * 3600))
    assert client.get("/api/forecast").status_code == 401
    client.cookies.set("v4w_session", cookie() + "tampered")
    assert client.get("/api/forecast").status_code == 401


def test_admin_is_protected_even_when_dashboard_auth_is_disabled(client, monkeypatch):
    monkeypatch.setenv("V4W_REQUIRE_AUTH", "false")
    assert client.get("/api/forecast").status_code == 200
    assert client.get("/api/admin/uploads").status_code == 401


def test_unconfigured_signin_returns_setup_error(client, monkeypatch):
    monkeypatch.delenv("V4W_OIDC_CLIENT_ID", raising=False)
    assert client.get("/auth/login").status_code == 503


@pytest.fixture
def oidc(client, monkeypatch):
    signing_key = RSAKey.generate_key(2048, private=True)
    public_key = {**signing_key.as_dict(private=False), "kid": "test-key"}
    state = {"verified": True, "email": "admin@example.test", "audience": "test-client"}

    def issuer(request):
        if request.url.path == "/jwks":
            return httpx.Response(200, json={"keys": [public_key]})
        if request.url.path == "/token":
            assert b"code_verifier=" in request.content
            claims = {"iss": "https://issuer.test", "sub": "test-subject", "aud": state["audience"],
                      "exp": int(time.time()) + 300, "iat": int(time.time()), "nonce": state["nonce"],
                      "email": state["email"], "email_verified": state["verified"]}
            token = jwt.encode({"alg": "RS256", "kid": "test-key"}, claims, signing_key)
            return httpx.Response(200, json={"access_token": "provider-access-token", "token_type": "Bearer", "id_token": token})
        raise AssertionError("Unexpected provider request")

    oauth = OAuth()
    remote = oauth.register("test", client_id="test-client", client_secret="test-secret",
                            authorize_url="https://issuer.test/authorize", access_token_url="https://issuer.test/token",
                            jwks_uri="https://issuer.test/jwks", issuer="https://issuer.test",
                            client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256", "transport": httpx.MockTransport(issuer)})
    monkeypatch.setattr(auth, "oauth_client", lambda: remote)
    response = client.get("/auth/login?next=admin")
    params = parse_qs(urlsplit(response.headers["location"]).query)
    assert params["code_challenge_method"] == ["S256"]
    state.update(nonce=params["nonce"][0], state=params["state"][0])
    return state


def test_real_oidc_code_flow_validates_token_and_keeps_tokens_out_of_cookie(client, oidc):
    response = client.get("/auth/callback", params={"code": "test-code", "state": oidc["state"]})
    assert response.status_code == 303 and response.headers["location"] == "/admin"
    session = client.get("/api/session").json()
    assert session["user"] == {"email": "admin@example.test", "role": "admin"}
    assert session["csrf"]
    signed = response.cookies.get("v4w_session")
    payload = TimestampSigner(SECRET).unsign(signed)
    from base64 import b64decode
    assert "provider-access-token" not in b64decode(payload).decode()


@pytest.mark.parametrize("field,value", [("verified", False), ("email", "unknown@example.test"), ("audience", "wrong-client")])
def test_oidc_rejects_unverified_unknown_or_invalid_audience(client, oidc, field, value):
    oidc[field] = value
    response = client.get("/auth/callback", params={"code": "test-code", "state": oidc["state"]})
    assert "error=" in response.headers["location"]
    assert client.get("/api/session").json()["user"] is None


def test_oidc_rejects_wrong_state(client, oidc):
    response = client.get("/auth/callback", params={"code": "test-code", "state": "wrong-state"})
    assert response.headers["location"] == "/login?error=signin"
    assert client.get("/api/session").json()["user"] is None
