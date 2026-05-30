"""FastAPI backend that authenticates VS Code extension requests.

Endpoints
---------
GET /health    Liveness probe (no auth).
GET /api/me    Returns the validated token claims. Requires a valid bearer
               token addressed to the SERVER Entra ID app and (if configured)
               carrying a required app role.
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from auth import TokenError, validate_token
from config import settings

app = FastAPI(title="Azure OBO Backend", version="0.0.1")

_bearer = HTTPBearer(auto_error=True)


def require_token(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> Dict[str, Any]:
    """FastAPI dependency that validates the incoming bearer token."""
    try:
        return validate_token(credentials.credentials)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/api/me")
def me(claims: Dict[str, Any] = Depends(require_token)) -> Dict[str, Any]:
    return {
        "message": "Token validated successfully.",
        "subject": claims.get("sub"),
        "name": claims.get("name"),
        "preferred_username": claims.get("preferred_username"),
        "tenant_id": claims.get("tid"),
        "audience": claims.get("aud"),
        "app_roles": claims.get("roles", []),
        "scopes": claims.get("scp"),
        "required_app_roles": settings.required_app_roles,
    }
