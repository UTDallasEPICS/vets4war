"""Auth0 settings, read from the environment in one place.

    AUTH0_DOMAIN      tenant hostname, no scheme or slash   (e.g. tenant.us.auth0.com)
    AUTH0_AUDIENCE    identifier of the Auth0 API the access tokens are for
    AUTH0_CLIENT_ID   id of the Auth0 single-page application the admin page uses

None of the three is a secret: the browser needs all of them to start the
Auth0 sign-in, and GET /api/admin/config hands them to the admin page. They
live in settings, not in the page's script, so a tenant can be swapped
without a code change.

The domain ends up inside a URL and inside a security header, so it is only
ever used when it is a plain hostname; anything else counts as not set.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping

HOSTNAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?")


@dataclass(frozen=True)
class Auth0Config:
    domain: str
    audience: str
    client_id: str


def auth0_domain(env: Mapping[str, str]) -> str | None:
    """The configured tenant hostname, or None when unset or not a hostname."""
    domain = env.get("AUTH0_DOMAIN", "").strip()
    return domain if HOSTNAME.fullmatch(domain) else None


def auth0_audience(env: Mapping[str, str]) -> str | None:
    return env.get("AUTH0_AUDIENCE", "").strip() or None


def auth0_config(env: Mapping[str, str]) -> Auth0Config | None:
    """Everything the admin page needs, or None unless all three are set."""
    domain, audience = auth0_domain(env), auth0_audience(env)
    client_id = env.get("AUTH0_CLIENT_ID", "").strip()
    if not (domain and audience and client_id):
        return None
    return Auth0Config(domain, audience, client_id)
