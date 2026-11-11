"""Isolated auth tests: real RSA signatures, mocked JWKS, no database/network."""

import io
import json
import logging
import time
from unittest.mock import Mock

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import auth
from api.admin import router


@pytest.fixture
def security(monkeypatch):
    monkeypatch.setenv("AUTH0_DOMAIN", "tenant.auth0.com")
    monkeypatch.setenv("AUTH0_AUDIENCE", "https://admin.example")
    auth._jwks_client.cache_clear()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid="test-key", use="sig", alg="RS256")
    fetch = Mock(side_effect=lambda *args, **kwargs: io.BytesIO(json.dumps({"keys": [jwk]}).encode()))
    monkeypatch.setattr("urllib.request.build_opener", lambda *args: Mock(open=fetch))
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        yield client, key, fetch, jwk
    auth._jwks_client.cache_clear()


def token(key, **overrides):
    claims = {
        "sub": "auth0|test", "iss": "https://tenant.auth0.com/",
        "aud": "https://admin.example", "exp": int(time.time()) + 300,
        "permissions": ["read:admin"],
    }
    claims.update(overrides)
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-key"})


def request(client, value):
    return client.get("/api/admin/me", headers={"Authorization": f"Bearer {value}"})


def test_missing_and_malformed_tokens(security):
    client, _, fetch, _ = security
    for headers in ({}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer garbage"}):
        response = client.get("/api/admin/me", headers=headers)
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"
    fetch.assert_not_called()


@pytest.mark.parametrize("overrides", [
    {"aud": "wrong"}, {"iss": "https://wrong.auth0.com/"},
    {"exp": 1}, {"exp": None}, {"sub": None}, {"sub": ""}, {"sub": "   "},
])
def test_invalid_claims(security, overrides):
    client, key, _, _ = security
    assert request(client, token(key, **overrides)).status_code == 401


def test_missing_expiration(security):
    client, key, _, _ = security
    claims = {"sub": "test", "iss": "https://tenant.auth0.com/", "aud": "https://admin.example"}
    value = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-key"})
    assert request(client, value).status_code == 401


def test_wrong_signature_and_algorithm(security):
    client, _, _, _ = security
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert request(client, token(other)).status_code == 401
    assert request(client, jwt.encode({"sub": "test"}, "x" * 32, algorithm="HS256")).status_code == 401


@pytest.mark.parametrize("permissions", [[], ["import:calls", "trigger:retraining"],
    ["read:admin:extra"], "read:admin", None, [42]])
def test_exact_permissions_required(security, permissions):
    client, key, _, _ = security
    assert request(client, token(key, permissions=permissions)).status_code == 403


def test_scope_does_not_replace_permissions(security):
    client, key, _, _ = security
    claims = jwt.decode(token(key), options={"verify_signature": False})
    del claims["permissions"]
    claims["scope"] = "read:admin"
    value = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-key"})
    assert request(client, value).status_code == 403


def test_authorized_and_jwks_cached(security):
    client, key, fetch, _ = security
    for _ in range(2):
        response = request(client, token(key))
        assert response.status_code == 200
        assert response.json() == {"sub": "auth0|test", "permissions": ["read:admin"]}
    fetch.assert_called_once()
    assert fetch.call_args.args[0].full_url == "https://tenant.auth0.com/.well-known/jwks.json"
    assert fetch.call_args.kwargs["timeout"] == 5


def test_key_rotation(security):
    client, key, fetch, jwk = security
    assert request(client, token(key)).status_code == 200
    rotated = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    next_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(rotated.public_key()))
    next_jwk.update(kid="rotated", use="sig", alg="RS256")
    fetch.side_effect = lambda *args, **kwargs: io.BytesIO(json.dumps({"keys": [jwk, next_jwk]}).encode())
    # Model the end of the client's forced-refresh cooldown without sleeping.
    auth._jwks_client("tenant.auth0.com").cooldown_duration = 0
    claims = jwt.decode(token(key), options={"verify_signature": False})
    value = jwt.encode(claims, rotated, algorithm="RS256", headers={"kid": "rotated"})
    assert request(client, value).status_code == 200
    assert fetch.call_count == 2


def test_key_fetch_failure(security):
    client, key, fetch, _ = security
    from urllib.error import URLError
    fetch.side_effect = URLError("offline")
    assert request(client, token(key)).status_code == 503


def test_missing_configuration(security, monkeypatch):
    client, key, fetch, _ = security
    monkeypatch.delenv("AUTH0_AUDIENCE")
    assert request(client, token(key)).status_code == 503
    fetch.assert_not_called()


def test_main_registers_admin_before_static_mount(security):
    from api.main import app

    _, key, _, _ = security
    with TestClient(app) as client:
        assert client.get("/api/admin/me").status_code == 401
        assert request(client, token(key)).status_code == 200
        assert client.get("/").status_code == 200

@pytest.mark.parametrize("permissions,history_status,write_status", [
    ([], 403, 403), (["import:calls"], 403, 403),
    (["read:admin"], 200, 403), (["read:admin", "import:calls"], 200, 201),
    (["trigger:retraining"], 403, 403),
])
def test_real_jwt_permissions_on_ingestion_routes(security, monkeypatch, permissions, history_status, write_status):
    from contextlib import nullcontext
    from api import admin, main
    _, key, _, _ = security
    actors = []
    connections = []
    def connect():
        connections.append(True)
        return nullcontext(object())
    monkeypatch.setattr(admin, "_pipeline_connection", connect)
    monkeypatch.setattr(main.pipeline, "contract", lambda: object())
    monkeypatch.setattr(main.pipeline, "history", lambda conn: [])
    monkeypatch.setattr(main.pipeline, "preview", lambda conn, content, month, actor, profile:
                        actors.append(actor) or {"id": "batch", "status": "validated", "validation": {}})
    monkeypatch.setattr(main.pipeline, "commit_import", lambda conn, batch, profile, **kwargs:
                        actors.append(kwargs["actor"]) or {"id": str(batch), "status": "imported"})
    headers = {"Authorization": f"Bearer {token(key, permissions=permissions)}"}
    with TestClient(main.app) as client:
        assert client.get("/api/admin/uploads", headers=headers).status_code == history_status
        response = client.post("/api/admin/uploads", headers=headers, data={"month": "2026-09"},
                               files={"file": ("calls.xlsx", b"synthetic")})
        assert response.status_code == write_status
        response = client.post("/api/admin/uploads/00000000-0000-0000-0000-000000000001/import",
                               headers=headers, json={"expected_rows": 1})
        assert response.status_code == (200 if write_status == 201 else 403)
    assert len(connections) == (int(history_status == 200) + 2 * int(write_status == 201))
    assert actors == (["auth0|test", "auth0|test"] if write_status == 201 else [])


def test_insecure_environment_variable_cannot_bypass_authentication(monkeypatch):
    from api import admin, main
    monkeypatch.setenv("V4W_INSECURE_DEV_ADMIN", "intruder")
    def forbidden(*args, **kwargs):
        pytest.fail("Unauthorized request reached ingestion")
    monkeypatch.setattr(admin, "_pipeline_connection", forbidden)
    monkeypatch.setattr(main.pipeline, "contract", forbidden)
    with TestClient(main.app) as client:
        assert client.get("/api/admin/uploads").status_code == 401
        assert client.post("/api/admin/uploads", data={"month": "2026-09"},
                           files={"file": ("calls.xlsx", b"synthetic")}).status_code == 401
        assert client.post("/api/admin/uploads/00000000-0000-0000-0000-000000000001/import",
                           json={"expected_rows": 1}).status_code == 401


@pytest.mark.parametrize("category", [
    "missing_bearer", "invalid_token_format", "invalid_signature",
    "invalid_issuer", "invalid_audience", "expired_token",
    "invalid_algorithm", "missing_required_claim:MissingRequiredClaimError",
])
def test_rejection_logs_only_allowlisted_category(security, caplog, category):
    client, key, _, _ = security
    caplog.set_level(logging.WARNING, logger="api.auth")
    overrides = {"sub": "private-subject-marker"}
    if category == "invalid_signature":
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    elif category == "invalid_issuer":
        overrides["iss"] = "https://private-issuer.invalid/"
    elif category == "invalid_audience":
        overrides["aud"] = "private-audience-marker"
    elif category == "expired_token":
        overrides["exp"] = 1
    value = token(key, **overrides)
    if category == "invalid_token_format":
        value = "private-malformed-token-marker"
    elif category == "invalid_algorithm":
        value = jwt.encode(overrides, "private-secret-marker" * 2, algorithm="HS256",
                           headers={"kid": "test-key"})
    elif category == "missing_required_claim:MissingRequiredClaimError":
        claims = jwt.decode(value, options={"verify_signature": False})
        del claims["exp"]
        value = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "test-key"})
    caplog.clear()
    response = client.get("/api/admin/me") if category == "missing_bearer" else request(client, value)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or missing access token"}
    assert response.headers["www-authenticate"] == "Bearer"
    records = [record for record in caplog.records if record.name == "api.auth"]
    assert len(records) == 1
    record = records[0]
    assert record.msg == record.getMessage() == category
    assert record.args == ()
    assert record.exc_info is None and record.stack_info is None
    assert value not in caplog.text
    assert "private-" not in caplog.text


@pytest.mark.parametrize("kid", [None, "", 42])
def test_invalid_key_identifier_logs_format_only(security, caplog, kid):
    client, key, _, _ = security
    caplog.set_level(logging.WARNING, logger="api.auth")
    claims = jwt.decode(token(key), options={"verify_signature": False})
    # Construct these malformed header values without weakening the verifier.
    header = jwt.api_jws.base64url_encode(json.dumps({"alg": "RS256", "kid": kid}).encode())
    payload = jwt.api_jws.base64url_encode(json.dumps(claims).encode())
    value = (header + b"." + payload + b".synthetic").decode()
    assert request(client, value).status_code == 401
    assert [r.getMessage() for r in caplog.records if r.name == "api.auth"] == ["invalid_token_format"]


def test_fallback_never_logs_raw_exception(security, monkeypatch, caplog):
    client, key, _, _ = security
    value = token(key)
    caplog.set_level(logging.WARNING, logger="api.auth")
    monkeypatch.setattr(auth.jwt, "decode", Mock(side_effect=jwt.InvalidTokenError("private-exception-marker")))
    assert request(client, value).status_code == 401
    records = [r for r in caplog.records if r.name == "api.auth"]
    assert [r.getMessage() for r in records] == ["other_validation_error:InvalidTokenError"]
    assert all(r.exc_info is None and r.args == () for r in records)
    assert "private-exception-marker" not in caplog.text


def test_empty_subject_logs_invalid_subject(security, caplog):
    client, key, _, _ = security
    caplog.set_level(logging.WARNING, logger="api.auth")
    assert request(client, token(key, sub="")).status_code == 401
    assert [r.getMessage() for r in caplog.records if r.name == "api.auth"] == ["invalid_subject"]


def test_success_and_permission_denial_do_not_log_jwt_rejections(security, caplog):
    client, key, _, _ = security
    caplog.set_level(logging.WARNING, logger="api.auth")
    assert request(client, token(key)).status_code == 200
    assert request(client, token(key, permissions=[])).status_code == 403
    assert not [r for r in caplog.records if r.name == "api.auth"]


@pytest.mark.parametrize("overrides,diagnostic", [
    # One hour ahead, not one minute: these values are fixed when the suite is
    # collected, and a full run can take longer than a minute to get here.
    ({"iat": int(time.time()) + 3600}, "token_not_yet_valid:ImmatureSignatureError"),
    ({"nbf": int(time.time()) + 3600}, "token_not_yet_valid:ImmatureSignatureError"),
    ({"iat": "private-invalid-time"}, "invalid_issued_at:InvalidIssuedAtError"),
    ({"sub": 42}, "invalid_subject:InvalidSubjectError"),
    ({"jti": 42}, "invalid_token_id:InvalidJTIError"),
])
def test_previously_generic_claim_failures_have_specific_diagnostics(security, caplog, overrides, diagnostic):
    client, key, _, _ = security
    caplog.set_level(logging.WARNING, logger="api.auth")
    value = token(key, **overrides)
    response = request(client, value)
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid or missing access token"}
    assert response.headers["www-authenticate"] == "Bearer"
    records = [r for r in caplog.records if r.name == "api.auth"]
    assert [r.getMessage() for r in records] == [diagnostic]
    assert all(r.exc_info is None and r.args == () and r.stack_info is None for r in records)
    assert value not in caplog.text and "private-invalid-time" not in caplog.text


@pytest.mark.parametrize("claim", ["iat", "nbf"])
def test_same_signed_token_becomes_valid_within_clock_skew_window(security, monkeypatch, caplog, claim):
    from datetime import datetime, timezone
    client, key, _, _ = security
    now = int(time.time())
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(now, tz=tz)
    monkeypatch.setattr(jwt.api_jwt, "datetime", Clock)
    value = token(key, **{claim: now + 31}, exp=now + 300)
    caplog.set_level(logging.WARNING, logger="api.auth")
    assert request(client, value).status_code == 401
    assert [r.getMessage() for r in caplog.records if r.name == "api.auth"] == ["token_not_yet_valid:ImmatureSignatureError"]
    now += 2
    caplog.clear()
    assert request(client, value).status_code == 200
    assert not [r for r in caplog.records if r.name == "api.auth"]


@pytest.mark.parametrize("claim,offset,status", [
    ("iat", 10, 200),
    ("iat", 30, 200),
    ("iat", 31, 401),
    ("nbf", 10, 200),
    ("nbf", 30, 200),
    ("nbf", 31, 401),
    ("exp", -10, 200),
    ("exp", -30, 401),
    ("exp", -31, 401),
])
def test_thirty_second_clock_skew_boundaries(security, monkeypatch, caplog, claim, offset, status):
    from datetime import datetime
    client, key, _, _ = security
    now = int(time.time())
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(now, tz=tz)
    monkeypatch.setattr(jwt.api_jwt, "datetime", Clock)
    value = token(key, **{claim: now + offset})
    caplog.set_level(logging.WARNING, logger="api.auth")
    response = request(client, value)
    assert response.status_code == status
    diagnostics = [r.getMessage() for r in caplog.records if r.name == "api.auth"]
    if status == 401:
        assert response.json() == {"detail": "Invalid or missing access token"}
        assert response.headers["www-authenticate"] == "Bearer"
        assert diagnostics == (["expired_token"] if claim == "exp" else
                               ["token_not_yet_valid:ImmatureSignatureError"])
    else:
        assert response.json()["permissions"] == ["read:admin"]
        assert not diagnostics


def test_signing_key_rotation_cooldown_can_temporarily_reject_a_new_key(security, caplog):
    client, key, fetch, jwk = security
    assert request(client, token(key)).status_code == 200
    rotated = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    next_jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(rotated.public_key()))
    next_jwk.update(kid="synthetic-rotated-key", use="sig", alg="RS256")
    fetch.side_effect = lambda *args, **kwargs: io.BytesIO(json.dumps({"keys": [jwk, next_jwk]}).encode())
    claims = jwt.decode(token(key), options={"verify_signature": False})
    value = jwt.encode(claims, rotated, algorithm="RS256", headers={"kid": "synthetic-rotated-key"})
    caplog.set_level(logging.WARNING, logger="api.auth")
    assert request(client, value).status_code == 401
    assert fetch.call_count == 1  # Cached set; unknown key refresh is cooling down.
    assert [r.getMessage() for r in caplog.records if r.name == "api.auth"] == ["jwks_client_error:PyJWKClientError"]
    assert "synthetic-rotated-key" not in caplog.text
    jwks_client = auth._jwks_client("tenant.auth0.com")
    jwks_client._last_successful_fetch -= jwks_client.cooldown_duration + 1
    caplog.clear()
    assert request(client, value).status_code == 200
    assert fetch.call_count == 2
    assert not [r for r in caplog.records if r.name == "api.auth"]


@pytest.mark.parametrize("exception_type,diagnostic,status", [
    (jwt.PyJWKClientConnectionError, "jwks_unavailable:PyJWKClientConnectionError", 503),
    (jwt.PyJWKClientError, "jwks_client_error:PyJWKClientError", 401),
    (jwt.PyJWKSetError, "invalid_jwks:PyJWKSetError", 401),
    (jwt.PyJWKError, "invalid_jwk:PyJWKError", 401),
    (jwt.exceptions.MissingCryptographyError, "cryptography_unavailable:MissingCryptographyError", 401),
    (jwt.InvalidKeyError, "invalid_signing_key:InvalidKeyError", 401),
    (jwt.PyJWTError, "other_validation_error:PyJWTError", 401),
])
def test_key_stage_diagnostics_never_log_exception_values(security, monkeypatch, caplog, exception_type, diagnostic, status):
    client, key, _, _ = security
    monkeypatch.setattr(auth._jwks_client("tenant.auth0.com"), "get_signing_key_from_jwt",
                        Mock(side_effect=exception_type("private-key-url-or-identifier-marker")))
    caplog.set_level(logging.WARNING, logger="api.auth")
    value = token(key)
    response = request(client, value)
    assert response.status_code == status
    records = [r for r in caplog.records if r.name == "api.auth"]
    assert [r.getMessage() for r in records] == [diagnostic]
    assert all(r.exc_info is None and r.args == () and r.stack_info is None for r in records)
    assert value not in caplog.text and "private-key-url-or-identifier-marker" not in caplog.text
    if status == 401:
        assert response.json() == {"detail": "Invalid or missing access token"}
    else:
        assert response.json() == {"detail": "Authentication keys are unavailable"}
