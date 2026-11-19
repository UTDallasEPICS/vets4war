"""Shared pytest setup.

The API tests call the real app (api.main) directly, without signing in.
The sign-in gate fails closed when it is not configured, so tests switch it
off here unless the environment already says otherwise. tests/test_site_auth.py
does not depend on this: it injects its own environment.
"""

import os

os.environ.setdefault("V4W_AUTH_DISABLED", "1")
