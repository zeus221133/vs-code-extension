"""Configuration for the token-validating backend.

All values are read from environment variables so the same code works in local
development and in production. See ``.env.example`` for the full list.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import List


def _split(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # Entra ID tenant id (a GUID) or 'common'/'organizations'.
    tenant_id: str = field(default_factory=lambda: os.environ.get("AAD_TENANT_ID", "common"))

    # Application (client) id of the SERVER Entra ID app registration. Incoming
    # access tokens must be addressed to this app (audience check).
    server_client_id: str = field(default_factory=lambda: os.environ.get("AAD_SERVER_CLIENT_ID", ""))

    # App roles that the caller must hold (any one of them). Empty => no role
    # check (only signature/expiry/audience are enforced).
    required_app_roles: List[str] = field(
        default_factory=lambda: _split(os.environ.get("AAD_REQUIRED_APP_ROLES", ""))
    )

    # Optional client secret of the SERVER app, used only for the On-Behalf-Of
    # flow to call downstream APIs. Not required for token validation.
    server_client_secret: str = field(
        default_factory=lambda: os.environ.get("AAD_SERVER_CLIENT_SECRET", "")
    )

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.tenant_id}"

    @property
    def openid_config_url(self) -> str:
        return f"{self.authority}/v2.0/.well-known/openid-configuration"

    @property
    def expected_audiences(self) -> List[str]:
        # v2.0 tokens use the bare client id; v1.0 tokens use the api://<id> URI.
        return [self.server_client_id, f"api://{self.server_client_id}"]


settings = Settings()
