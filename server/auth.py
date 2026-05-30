"""Validation of Entra ID (Azure AD) access tokens.

The Python backend receives the access token that the VS Code extension obtained
for the SERVER app. Before trusting it we verify, using the public signing keys
published by ``login.microsoftonline.com``:

1. the JWT signature (RS256, key matched by ``kid`` against the JWKS endpoint),
2. the expiry / not-before times,
3. the audience (must be the SERVER app), and
4. the app role (``roles`` claim) when one is required.

Signing keys and OpenID metadata are cached and refreshed periodically so we do
not hit the discovery endpoints on every request.
"""
from __future__ import annotations

import time
from threading import Lock
from typing import Any, Dict, List, Optional
from urllib.request import urlopen
import json

import jwt
from jwt import PyJWKClient

from config import settings


class TokenError(Exception):
    """Raised when a token fails validation."""


_METADATA_TTL_SECONDS = 3600


class _OpenIdMetadata:
    """Caches the OpenID configuration and the JWKS client built from it."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._fetched_at: float = 0.0
        self._jwks_uri: Optional[str] = None
        self._issuer: Optional[str] = None
        self._jwks_client: Optional[PyJWKClient] = None

    def _refresh_locked(self) -> None:
        with urlopen(settings.openid_config_url, timeout=10) as resp:  # noqa: S310 (trusted Microsoft URL)
            data = json.loads(resp.read().decode("utf-8"))
        self._jwks_uri = data["jwks_uri"]
        self._issuer = data.get("issuer")
        self._jwks_client = PyJWKClient(self._jwks_uri)
        self._fetched_at = time.time()

    def _ensure_fresh(self) -> None:
        if self._jwks_client is None or (time.time() - self._fetched_at) > _METADATA_TTL_SECONDS:
            with self._lock:
                if self._jwks_client is None or (time.time() - self._fetched_at) > _METADATA_TTL_SECONDS:
                    self._refresh_locked()

    @property
    def issuer_template(self) -> Optional[str]:
        self._ensure_fresh()
        return self._issuer

    def signing_key(self, token: str) -> Any:
        self._ensure_fresh()
        assert self._jwks_client is not None
        return self._jwks_client.get_signing_key_from_jwt(token).key


_metadata = _OpenIdMetadata()


def _expected_issuer(token_claims_tid: Optional[str]) -> Optional[str]:
    """Resolve the concrete issuer expected for this token.

    For single-tenant authorities the discovery document already contains the
    final issuer. For multi-tenant authorities ('common'/'organizations') it
    contains a ``{tenantid}`` placeholder that must be substituted with the
    token's own ``tid`` claim.
    """
    template = _metadata.issuer_template
    if template is None:
        return None
    if "{tenantid}" in template and token_claims_tid:
        return template.replace("{tenantid}", token_claims_tid)
    return template


def validate_token(token: str) -> Dict[str, Any]:
    """Validate an access token and return its claims.

    Raises ``TokenError`` if the token is invalid for any reason.
    """
    if not settings.server_client_id:
        raise TokenError("Server is misconfigured: AAD_SERVER_CLIENT_ID is not set.")

    try:
        signing_key = _metadata.signing_key(token)
    except Exception as exc:  # pragma: no cover - network/parse errors
        raise TokenError(f"Unable to resolve signing key: {exc}") from exc

    # Peek at the tenant id so we can compute the expected issuer for the
    # multi-tenant case without yet trusting the signature.
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError as exc:
        raise TokenError(f"Malformed token: {exc}") from exc

    expected_issuer = _expected_issuer(unverified.get("tid"))

    try:
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=settings.expected_audiences,
            issuer=expected_issuer,
            options={
                "require": ["exp", "iat", "aud"],
                "verify_signature": True,
                "verify_exp": True,
                "verify_aud": True,
                "verify_iss": expected_issuer is not None,
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise TokenError("Token has expired.") from exc
    except jwt.InvalidAudienceError as exc:
        raise TokenError("Token audience does not match this server app.") from exc
    except jwt.InvalidIssuerError as exc:
        raise TokenError("Token issuer is not trusted.") from exc
    except jwt.PyJWTError as exc:
        raise TokenError(f"Invalid token: {exc}") from exc

    _check_app_roles(claims)
    return claims


def _check_app_roles(claims: Dict[str, Any]) -> None:
    required = settings.required_app_roles
    if not required:
        return
    token_roles: List[str] = claims.get("roles", []) or []
    if not any(role in token_roles for role in required):
        raise TokenError(
            "Token is missing a required app role. "
            f"Required one of {required}, token has {token_roles}."
        )
