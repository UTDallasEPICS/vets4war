"""Auth0 access-token verification and reusable permission dependencies."""

import logging
import os
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from api.auth0_config import auth0_audience, auth0_domain

bearer = HTTPBearer(auto_error=False)
log = logging.getLogger(__name__)

# Order matters: InvalidSignatureError is a subclass of DecodeError.
_JWT_REJECTIONS = (
    (jwt.InvalidSignatureError, "invalid_signature"),
    (jwt.InvalidIssuerError, "invalid_issuer"),
    (jwt.InvalidAudienceError, "invalid_audience"),
    (jwt.ExpiredSignatureError, "expired_token"),
    (jwt.InvalidAlgorithmError, "invalid_algorithm"),
    (jwt.DecodeError, "invalid_token_format"),
    # Previously these all appeared as other_validation_error. Static class
    # labels distinguish timing/claims from JWKS/key selection without logging
    # exception text (which can contain a key identifier or claim value).
    (jwt.ImmatureSignatureError, "token_not_yet_valid:ImmatureSignatureError"),
    (jwt.InvalidIssuedAtError, "invalid_issued_at:InvalidIssuedAtError"),
    (jwt.MissingRequiredClaimError, "missing_required_claim:MissingRequiredClaimError"),
    (jwt.exceptions.InvalidSubjectError, "invalid_subject:InvalidSubjectError"),
    (jwt.exceptions.InvalidJTIError, "invalid_token_id:InvalidJTIError"),
    (jwt.PyJWKClientError, "jwks_client_error:PyJWKClientError"),
    (jwt.PyJWKSetError, "invalid_jwks:PyJWKSetError"),
    (jwt.exceptions.MissingCryptographyError, "cryptography_unavailable:MissingCryptographyError"),
    (jwt.PyJWKError, "invalid_jwk:PyJWKError"),
    (jwt.InvalidKeyError, "invalid_signing_key:InvalidKeyError"),
    (jwt.InvalidTokenError, "other_validation_error:InvalidTokenError"),
)


@lru_cache(maxsize=4)
def _jwks_client(domain: str) -> jwt.PyJWKClient:
    # Cache the set for five minutes; unknown kids trigger a bounded refresh.
    # The URL comes only from server configuration, never from token headers.
    return jwt.PyJWKClient(
        f"https://{domain}/.well-known/jwks.json",
        cache_jwk_set=True, cache_keys=False, lifespan=300, timeout=5,
    )


def verify_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> dict:
    unauthorized = HTTPException(
        status_code=401, detail="Invalid or missing access token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if credentials is None:
        log.warning("missing_bearer")
        raise unauthorized
    domain, audience = auth0_domain(os.environ), auth0_audience(os.environ)
    if not domain or not audience:
        raise HTTPException(503, "Authentication is not configured")
    token = credentials.credentials
    try:
        header = jwt.get_unverified_header(token)
        if header.get("alg") != "RS256":
            log.warning("invalid_algorithm")
            raise unauthorized
        if not isinstance(header.get("kid"), str) or not header["kid"]:
            log.warning("invalid_token_format")
            raise unauthorized
        key = _jwks_client(domain).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token, key.key, algorithms=["RS256"],
            issuer=f"https://{domain}/", audience=audience,
            leeway=30,  # Bounded clock skew; iat, nbf, and exp remain validated.
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
        if not isinstance(claims["sub"], str) or not claims["sub"].strip():
            log.warning("invalid_subject")
            raise unauthorized
        return claims
    except jwt.PyJWKClientConnectionError as exc:
        log.warning("jwks_unavailable:PyJWKClientConnectionError")
        raise HTTPException(503, "Authentication keys are unavailable") from exc
    except jwt.PyJWTError as exc:
        category = next((category for error_type, category in _JWT_REJECTIONS
                         if isinstance(exc, error_type)), "other_validation_error:PyJWTError")
        # Only static categories; never attach exceptions, claims, or headers.
        log.warning(category)
        raise unauthorized from exc


def require_permissions(*required: str):
    """Require every named permission; scope strings and roles grant no access."""
    def check(claims: dict = Depends(verify_token)) -> dict:
        permissions = claims.get("permissions", [])
        if (
            not isinstance(permissions, list)
            or not all(isinstance(item, str) for item in permissions)
            or not set(required).issubset(permissions)
        ):
            raise HTTPException(403, "Insufficient permissions")
        return claims

    return check
