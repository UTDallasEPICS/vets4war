"""Shared OIDC sign-in. No provider tokens are retained in browser cookies."""
from __future__ import annotations

import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlsplit

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import FileResponse, JSONResponse, RedirectResponse

router = APIRouter()
WEB = Path(__file__).resolve().parent.parent / "web"


def emails(name):
    return {email.strip().lower() for email in os.getenv(name, "").split(",") if email.strip()}


def role_for(email):
    email = email.lower()
    if email in emails("V4W_ADMIN_EMAILS"):
        return "admin"
    if email in emails("V4W_VIEWER_EMAILS"):
        return "viewer"
    return None


def identity(request):
    user = request.session.get("user")
    if not user or time.time() - user.get("signed_in_at", 0) >= 8 * 3600:
        return None
    role = role_for(user["email"])
    return {**user, "role": role} if role else None


def require_admin(request):
    user = identity(request)
    if not user:
        raise HTTPException(401, "Sign in to continue.")
    if user["role"] != "admin":
        raise HTTPException(403, "Administrator access is required.")
    return user


def oauth_client():
    required = ("V4W_OIDC_METADATA_URL", "V4W_OIDC_CLIENT_ID", "V4W_OIDC_CLIENT_SECRET", "V4W_PUBLIC_URL")
    if not all(os.getenv(key) for key in required):
        raise HTTPException(503, "Sign-in is not configured. Ask the administrator to configure OIDC.")
    oauth = OAuth()
    return oauth.register(
        "organization", server_metadata_url=os.environ[required[0]],
        client_id=os.environ[required[1]], client_secret=os.environ[required[2]],
        client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
    )


class AccessMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        public = path in {"/login", "/auth/login", "/auth/callback", "/api/session", "/health", "/portal.css"}
        user = identity(request)
        # Admin endpoints always require authentication, even in dashboard dev mode.
        admin = path == "/admin" or path.startswith("/api/admin/")
        protected = admin or (os.getenv("V4W_REQUIRE_AUTH", "true").lower() == "true" and not public)
        if protected and not user:
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Sign in to continue."}, status_code=401)
            return RedirectResponse("/login?next=admin" if admin else "/login", status_code=303)
        if admin and user and user["role"] != "admin":
            return JSONResponse({"detail": "Administrator access is required."}, status_code=403)
        if request.method not in {"GET", "HEAD", "OPTIONS"} and user:
            expected = request.session.get("csrf", "")
            actual = request.headers.get("x-csrf-token", "")
            if not expected or not secrets.compare_digest(expected, actual):
                return JSONResponse({"detail": "Refresh the page and try again."}, status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response


def install_auth(app):
    # Session middleware must wrap AccessMiddleware so request.session is available.
    app.add_middleware(AccessMiddleware)
    app.add_middleware(
        SessionMiddleware, secret_key=os.getenv("V4W_SESSION_SECRET") or secrets.token_urlsafe(48),
        session_cookie="v4w_session", max_age=8 * 3600, same_site="lax",
        https_only=os.getenv("V4W_COOKIE_SECURE", "true").lower() == "true",
    )
    app.include_router(router)


@router.get("/login")
def login_page():
    return FileResponse(WEB / "login.html")


@router.get("/auth/login")
async def login(request: Request, next: str = "dashboard"):
    if len(os.getenv("V4W_SESSION_SECRET", "")) < 32:
        raise HTTPException(503, "Configure a shared session secret of at least 32 characters.")
    base = os.getenv("V4W_PUBLIC_URL", "").rstrip("/")
    parsed = urlsplit(base)
    local = parsed.hostname in {"localhost", "127.0.0.1"}
    if not parsed.netloc or (parsed.scheme != "https" and not (local and parsed.scheme == "http")) or parsed.path:
        raise HTTPException(503, "Configure V4W_PUBLIC_URL as the HTTPS site origin.")
    request.session["after_login"] = "/admin" if next == "admin" else "/"
    return await oauth_client().authorize_redirect(request, base + "/auth/callback")


@router.get("/auth/callback")
async def callback(request: Request):
    try:
        token = await oauth_client().authorize_access_token(request)
        claims = token.get("userinfo") or {}
        email = str(claims.get("email", "")).lower()
        # Require verified email from the validated ID token; never accept a
        # caller-supplied email, UPN, or an unverified email claim as identity.
        if not claims.get("sub") or claims.get("email_verified") is not True or not role_for(email):
            request.session.clear()
            return RedirectResponse("/login?error=access", status_code=303)
        destination = request.session.get("after_login", "/")
        request.session.clear()
        request.session.update(user={"email": email, "sub": claims["sub"], "signed_in_at": time.time()},
                               csrf=secrets.token_urlsafe(32))
        return RedirectResponse(destination, status_code=303)
    except HTTPException:
        raise
    except Exception:
        # Never render provider responses, codes, or tokens into errors/logs.
        request.session.clear()
        return RedirectResponse("/login?error=signin", status_code=303)


@router.get("/api/session")
def session(request: Request):
    user = identity(request)
    return {"user": {"email": user["email"], "role": user["role"]} if user else None,
            "csrf": request.session.get("csrf") if user else None}


@router.post("/auth/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}
