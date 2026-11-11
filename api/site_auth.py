"""Shared-password sign-in for the staffing console.

One password, no usernames. install_auth(app) puts a gate in front of every
route and static file: without a valid session cookie an API call gets 401
and a page request is sent to /login.html.

How it stays safe while staying simple:
  * The password itself is never stored. $V4W_APP_PASSWORD_HASH holds a
    salted scrypt hash (slow on purpose, so guessing is expensive).
  * A session is a signed expiry time, nothing else: "v1.<expires>.<hmac>"
    keyed by $V4W_SESSION_SECRET. No server-side session store, so it works
    on hosts that start and stop instances freely. Changing the secret signs
    everyone out.
  * The cookie is HttpOnly (page scripts cannot read it), SameSite=Strict
    (other sites cannot ride it) and Secure whenever the request came over
    HTTPS.
  * Repeated wrong passwords lock sign-in for a while: per address, and
    across all addresses together. Only two passwords are checked at a
    time, so a flood cannot exhaust the server.
  * The session signature also covers the password hash, so changing the
    password ends every existing session.
  * Fail closed: if the hash or the secret is missing, every request gets
    503 rather than an open page. $V4W_AUTH_DISABLED=1 turns the gate off for
    local development only; it is ignored on Vercel and inside the deployed
    image (Dockerfile.vercel sets V4W_DEPLOYED=1).

Environment:
    V4W_APP_PASSWORD_HASH   output of `python -m api.site_auth hash`
    V4W_SESSION_SECRET      output of `python -m api.site_auth secret` (32+ chars)
    V4W_AUTH_DISABLED       "1" to run without sign-in on your own machine

Command line (from the repo root):
    python -m api.site_auth password     print a new random password
    python -m api.site_auth hash         read a password (prompt or stdin), print its hash
    python -m api.site_auth secret       print a new session secret
"""

from __future__ import annotations

import base64
import binascii
import getpass
import hashlib
import hmac
import ipaddress
import os
import secrets
import sys
import threading
import time
from dataclasses import dataclass
from typing import Callable, Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

from api.auth0_config import auth0_domain

SESSION_COOKIE = "v4w_session"
SESSION_TTL_SEC = 12 * 60 * 60          # one working day, then sign in again
SESSION_VERSION = "v1"
MIN_SECRET_CHARS = 32
MAX_PASSWORD_CHARS = 256

# scrypt cost: about 0.1 s and 32 MB per check on a current laptop.
SCRYPT_N = 2 ** 15
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_KEY_BYTES = 32
SCRYPT_SALT_BYTES = 16
SCRYPT_MAX_MEMORY = 128 * 1024 * 1024
# Upper bounds accepted from a stored hash, so a bad value cannot stall the server.
SCRYPT_MAX_N = 2 ** 17
SCRYPT_MAX_R = 16
SCRYPT_MAX_P = 4

LOCKOUT_FAILURES = 5                    # wrong passwords from one address...
LOCKOUT_WINDOW_SEC = 15 * 60            # ...within this window lock sign-in until it passes
GLOBAL_LOCKOUT_FAILURES = 60            # wrong passwords from ALL addresses in the window, then sign-in pauses
MAX_TRACKED_ADDRESSES = 5000
MAX_ADDRESS_CHARS = 64
MAX_LOGIN_BODY_BYTES = 1024             # a sign-in request is a few dozen bytes; refuse anything bigger unread
VERIFY_SLOTS = 2                        # password checks allowed at once (each costs ~0.1 s CPU and 32 MB)
BUSY_RETRY_SEC = 2

LOGIN_PAGE = "/login.html"
ADMIN_PAGE = "/admin.html"
# Everything not listed here needs a session. Exact matches only. The admin
# page's three files carry nothing private: what it shows comes from the
# admin API, which Auth0 guards.
PUBLIC_PATHS = frozenset({LOGIN_PAGE, "/login.js", "/api/login", "/api/logout",
                          ADMIN_PAGE, "/admin.js", "/vendor/auth0-spa-js.production.js"})
# Routes under these prefixes are guarded by Auth0 access tokens (api/auth.py),
# not by the session cookie. The trailing slash matters: "/api/administrator"
# is not one of them.
TOKEN_GUARDED_PREFIXES = ("/api/admin/",)

# Generated passwords: 20 characters from 31 look-alike-free symbols, about 99 bits.
PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
PASSWORD_GROUPS = 4
PASSWORD_GROUP_CHARS = 5

def _policy(connect_to: str = "'self'", frames_from: str | None = None) -> str:
    """One Content-Security-Policy. Everything is this site only, except the
    fonts, and whatever `connect_to` and `frames_from` add."""
    frames = f"frame-src {frames_from}; " if frames_from else ""
    return (
        "default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; "
        f"connect-src {connect_to}; {frames}object-src 'none'; base-uri 'none'; form-action 'self'; "
        "frame-ancestors 'none'"
    )


CONTENT_SECURITY_POLICY = _policy()
HSTS = "max-age=31536000; includeSubDomains"
PATH_STEPS = ("", ".", "..")


def _is_plain(path: str) -> bool:
    """True when the path means exactly what it says: no "..", ".", empty
    segment or backslash. The static file server tidies such paths AFTER the
    gate has looked at them, so "/api/admin/../../index.html" would otherwise
    pass the gate as an admin path and then be served as "/index.html"."""
    return "\\" not in path and not any(segment in PATH_STEPS for segment in path.split("/")[1:])


def needs_session(path: str) -> bool:
    """False for the sign-in files, the admin page's files and the admin API."""
    if path in PUBLIC_PATHS:
        return False
    return not (path.startswith(TOKEN_GUARDED_PREFIXES) and _is_plain(path))


def content_security_policy(path: str, auth0_domain: str | None) -> str:
    """The policy for one response. Only the admin page may reach beyond this
    site, and only to the configured Auth0 tenant: to exchange the sign-in
    code for a token, and to renew it in a hidden frame."""
    if path != ADMIN_PAGE or not auth0_domain:
        return CONTENT_SECURITY_POLICY
    tenant = f"https://{auth0_domain}"
    return _policy(connect_to=f"'self' {tenant}", frames_from=tenant)


# =============================================================================
# Password hashing
# =============================================================================

def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p,
                          dklen=SCRYPT_KEY_BYTES, maxmem=SCRYPT_MAX_MEMORY)


def hash_password(password: str) -> str:
    """Salted scrypt hash as "scrypt$N$r$p$salt$key" (salt and key base64)."""
    salt = secrets.token_bytes(SCRYPT_SALT_BYTES)
    key = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(key)}"


def verify_password(password: str, stored: str) -> bool:
    """True only when `password` matches the stored hash. Never raises."""
    try:
        scheme, n, r, p, salt, key = stored.split("$")
        n, r, p = int(n), int(r), int(p)
        if scheme != "scrypt" or not (1 < n <= SCRYPT_MAX_N and 0 < r <= SCRYPT_MAX_R and 0 < p <= SCRYPT_MAX_P):
            return False
        expected = base64.b64decode(key, validate=True)
        actual = _scrypt(password, base64.b64decode(salt, validate=True), n, r, p)
    except (ValueError, binascii.Error):
        return False
    return len(expected) == SCRYPT_KEY_BYTES and hmac.compare_digest(actual, expected)


def new_password() -> str:
    groups = ("".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_GROUP_CHARS))
              for _ in range(PASSWORD_GROUPS))
    return "-".join(groups)


# =============================================================================
# Session tokens
# =============================================================================

def _signature(secret: str, payload: str) -> str:
    return hmac.new(secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).hexdigest()


def issue_session(secret: str, now: float, ttl_sec: int = SESSION_TTL_SEC) -> str:
    payload = f"{SESSION_VERSION}.{int(now) + ttl_sec}"
    return f"{payload}.{_signature(secret, payload)}"


def session_is_valid(token: str | None, secret: str, now: float) -> bool:
    """True when the token was signed with `secret` and has not expired."""
    if not token or not token.isascii():
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    version, expires, signature = parts
    if version != SESSION_VERSION or not expires.isdigit():
        return False
    # Signature first, in constant time; the expiry is only trusted once it checks out.
    if not hmac.compare_digest(signature, _signature(secret, f"{version}.{expires}")):
        return False
    return int(expires) > now


# =============================================================================
# Configuration
# =============================================================================

@dataclass(frozen=True)
class AuthSettings:
    mode: str               # "on" | "off" | "misconfigured"
    password_hash: str = ""
    secret: str = ""
    deployed: bool = False  # behind the host's proxy: the off-switch is ignored, proxy headers are trusted
    auth0_domain: str | None = None  # the admin page's Auth0 tenant, when one is configured

    @property
    def signing_key(self) -> str:
        """Key for session signatures. Includes the password hash, so a new
        password invalidates every session issued under the old one."""
        return f"{self.secret}|{self.password_hash}"


def load_settings(env: Mapping[str, str]) -> AuthSettings:
    deployed = bool(env.get("VERCEL")) or env.get("V4W_DEPLOYED") == "1"
    password_hash = env.get("V4W_APP_PASSWORD_HASH", "").strip()
    secret = env.get("V4W_SESSION_SECRET", "").strip()
    configured = password_hash.startswith("scrypt$") and len(secret) >= MIN_SECRET_CHARS
    tenant = auth0_domain(env)
    if env.get("V4W_AUTH_DISABLED") == "1" and not deployed:
        return AuthSettings("off", deployed=deployed, auth0_domain=tenant)
    if configured:
        return AuthSettings("on", password_hash, secret, deployed, tenant)
    return AuthSettings("misconfigured", deployed=deployed, auth0_domain=tenant)


# =============================================================================
# Failed-attempt lockout
# =============================================================================

class FailureLimiter:
    """Wrong-password counts in this process's memory: per client address, and
    one shared count across all addresses.

    admit() counts an attempt BEFORE the password is checked and does so under
    a lock, so a burst of simultaneous guesses cannot slip past the limit;
    forgive() gives the attempt back when the password turned out right.

    A host that runs several instances keeps one set of counts per instance,
    so this slows guessing rather than capping it exactly. A long random
    password is still the real protection.
    """

    def __init__(self, max_failures: int = LOCKOUT_FAILURES, window_sec: int = LOCKOUT_WINDOW_SEC,
                 global_failures: int = GLOBAL_LOCKOUT_FAILURES):
        self._max = max_failures
        self._window = window_sec
        self._global_max = global_failures
        self._lock = threading.Lock()
        self._by_address: dict[str, tuple[float, ...]] = {}
        self._all: tuple[float, ...] = ()

    def _fresh(self, stamps: tuple[float, ...], now: float) -> tuple[float, ...]:
        return tuple(t for t in stamps if now - t < self._window)

    def _wait(self, stamps: tuple[float, ...], limit: int, now: float) -> int:
        if len(stamps) < limit:
            return 0
        return max(1, int(stamps[-limit] + self._window - now) + 1)

    def admit(self, key: str, now: float) -> int:
        """0 when `key` may try now (the attempt is counted); else seconds to wait."""
        with self._lock:
            mine = self._fresh(self._by_address.get(key, ()), now)
            everyone = self._fresh(self._all, now)
            wait = self._wait(mine, self._max, now) or self._wait(everyone, self._global_max, now)
            if wait:
                return wait
            others = {k: v for k, v in self._by_address.items() if k != key}
            if len(others) >= MAX_TRACKED_ADDRESSES:
                others = {k: fresh for k, v in others.items() if (fresh := self._fresh(v, now))}
            while len(others) >= MAX_TRACKED_ADDRESSES:      # still full: forget the stalest address
                others.pop(min(others, key=lambda k: others[k][-1]))
            self._by_address = {**others, key: (*mine, now)}
            self._all = (*everyone, now)
            return 0

    def forgive(self, key: str) -> None:
        """The password was right: drop this address's count and one shared attempt."""
        with self._lock:
            self._by_address = {k: v for k, v in self._by_address.items() if k != key}
            self._all = self._all[:-1]

    def tracked(self) -> int:
        with self._lock:
            return len(self._by_address)


def address_bucket(address: str) -> str:
    """Lockout key for a client address. An IPv6 client controls a whole /64,
    so those are counted per network; anything else is counted as given."""
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return address[:MAX_ADDRESS_CHARS]
    if parsed.version == 6:
        return str(ipaddress.ip_network(f"{parsed}/64", strict=False))
    return str(parsed)


# =============================================================================
# Wiring
# =============================================================================

class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_CHARS)


def _is_https(request: Request, settings: AuthSettings) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return settings.deployed or forwarded == "https" or request.url.scheme == "https"


def _client_key(request: Request, settings: AuthSettings) -> str:
    # The host's proxy sets these itself; anywhere else they are the caller's to
    # forge, so only the socket address is trusted there.
    if settings.deployed:
        reported = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0]
        if reported.strip():
            return address_bucket(reported.strip())
    return address_bucket(request.client.host if request.client else "unknown")


def _harden(response: Response, request: Request, settings: AuthSettings) -> Response:
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = content_security_policy(request.url.path, settings.auth0_domain)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    if _is_https(request, settings):
        response.headers["Strict-Transport-Security"] = HSTS
    return response


def install_auth(app: FastAPI, env: Mapping[str, str] | None = None,
                 clock: Callable[[], float] = time.time) -> None:
    """Gate every route of `app` and add /api/login, /api/logout, /api/session.

    Call it before mounting static files, so the routes it adds are matched
    first. `env` and `clock` are injectable for tests; settings are read per
    request, so a changed environment takes effect without a restart.
    """
    environment = os.environ if env is None else env
    limiter = FailureLimiter()
    verify_slots = threading.BoundedSemaphore(VERIFY_SLOTS)

    @app.middleware("http")
    async def require_session(request: Request, call_next):
        settings = load_settings(environment)
        if settings.mode == "misconfigured":
            refused = JSONResponse({"detail": "Sign-in is not configured on this server."}, status_code=503)
            return _harden(refused, request, settings)
        path = request.url.path
        if path == "/api/login" and request.method == "POST":
            declared = request.headers.get("content-length", "")
            if not declared.isdigit() or int(declared) > MAX_LOGIN_BODY_BYTES:
                too_big = JSONResponse({"detail": "Request too large"}, status_code=413)
                return _harden(too_big, request, settings)
        signed_in = settings.mode == "off" or session_is_valid(
            request.cookies.get(SESSION_COOKIE), settings.signing_key, clock())
        if signed_in or not needs_session(path):
            return _harden(await call_next(request), request, settings)
        if path.startswith("/api/"):
            return _harden(JSONResponse({"detail": "Sign in required"}, status_code=401), request, settings)
        return _harden(RedirectResponse(LOGIN_PAGE, status_code=303), request, settings)

    @app.post("/api/login", status_code=204)
    def login(body: LoginBody, request: Request):
        settings = load_settings(environment)
        if settings.mode != "on":
            return Response(status_code=204)        # gate is off: nothing to sign in to
        key, now = _client_key(request, settings), clock()
        if not verify_slots.acquire(blocking=False):
            return JSONResponse({"detail": "Sign-in is busy. Try again in a moment."}, status_code=429,
                                headers={"Retry-After": str(BUSY_RETRY_SEC)})
        try:
            wait = limiter.admit(key, now)       # counts the attempt before checking it
            if wait:
                return JSONResponse({"detail": "Too many attempts. Try again later."}, status_code=429,
                                    headers={"Retry-After": str(wait)})
            if not verify_password(body.password, settings.password_hash):
                return JSONResponse({"detail": "Wrong password"}, status_code=401)
            limiter.forgive(key)
        finally:
            verify_slots.release()
        response = Response(status_code=204)
        response.set_cookie(SESSION_COOKIE, issue_session(settings.signing_key, now), max_age=SESSION_TTL_SEC,
                            path="/", httponly=True, samesite="strict", secure=_is_https(request, settings))
        return response

    @app.post("/api/logout", status_code=204)
    def logout(request: Request):
        settings = load_settings(environment)
        response = Response(status_code=204)
        response.set_cookie(SESSION_COOKIE, "", max_age=0, path="/", httponly=True, samesite="strict",
                            secure=_is_https(request, settings))
        return response

    @app.get("/api/session")
    def session():
        """Reached only with a valid session (or with the gate off)."""
        return {"auth_required": load_settings(environment).mode == "on"}


# =============================================================================
# Command line
# =============================================================================

def _read_password() -> str:
    if sys.stdin.isatty():
        password = getpass.getpass("Password: ")
        if getpass.getpass("Again: ") != password:
            sys.exit("The two entries differ.")
        return password
    return sys.stdin.readline().rstrip("\n")


def main(argv: list[str]) -> None:
    command = argv[1] if len(argv) > 1 else ""
    if command == "password":
        print(new_password())
    elif command == "secret":
        print(secrets.token_urlsafe(48))
    elif command == "hash":
        password = _read_password()
        if not 0 < len(password) <= MAX_PASSWORD_CHARS:
            sys.exit(f"Password must be 1 to {MAX_PASSWORD_CHARS} characters.")
        print(hash_password(password))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
