"""Google Account OAuth 2.0 (Authorization Code + PKCE) authentication and token management."""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
from dotenv import load_dotenv
import os
import secrets
import stat
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests as http_requests
from google.auth.transport.requests import Request
from google.oauth2 import credentials as oauth2_credentials

GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_TOKENINFO_URI = "https://oauth2.googleapis.com/tokeninfo"
GOOGLE_USERINFO_URI = "https://openidconnect.googleapis.com/v1/userinfo"
GOOGLE_SDK_AUTHCODE_REDIRECT_URI = (
    "https://sdk.cloud.google.com/applicationdefaultauthcode.html"
)

# Standard Installed-App OAuth client for Google Cloud CLI/Desktop user authentication
# retrieved from the .env file in the root of this repository.
load_dotenv()  # Load .env file for local development (ignored in production)
DEFAULT_INSTALLED_CLIENT_ID = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")
DEFAULT_INSTALLED_CLIENT_SECRET = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "")

OAUTH_SCOPES = (
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/cloud-platform",
)
TOKEN_REFRESH_MARGIN_SECONDS = 300  # Refresh when < 5 minutes remain


def _default_session_path() -> Path:
    return Path.home() / ".config" / "vertex_aiperf" / "oauth_session.json"


class GoogleAuthError(ValueError):
    """Raised when Google Account OAuth authentication fails or is not active."""


@dataclass(frozen=True)
class PrincipalInfo:
    """Non-sensitive metadata describing the signed-in Google Account."""

    principal_email: str
    quota_project: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "principal_email": self.principal_email,
            "quota_project": self.quota_project,
        }


@dataclass
class PendingOAuthFlow:
    """State for an in-progress OAuth 2.0 Authorization Code + PKCE login."""

    state: str
    code_verifier: str
    redirect_uri: str
    client_id: str
    client_secret: str
    auth_uri: str
    token_uri: str
    created_at: dt.datetime


def _b64url_no_pad(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _extract_email_from_id_token(id_token: str | None) -> str | None:
    """Decode email claim from an OIDC JWT payload returned over TLS from Google's token endpoint."""
    if not id_token or id_token.count(".") < 2:
        return None
    try:
        payload_b64 = id_token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        email = claims.get("email")
        return str(email) if email else None
    except Exception:
        return None


def _fetch_userinfo_email(
    access_token: str, userinfo_uri: str = GOOGLE_USERINFO_URI
) -> str | None:
    try:
        resp = http_requests.get(
            userinfo_uri,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        if resp.ok:
            data = resp.json()
            email = data.get("email")
            return str(email) if email else None
    except Exception:
        pass
    return None


class GoogleAuthManager:
    """Manages interactive Google Account OAuth 2.0 + PKCE login sessions."""

    def __init__(
        self,
        *,
        auth_uri: str = GOOGLE_AUTH_URI,
        token_uri: str = GOOGLE_TOKEN_URI,
        tokeninfo_uri: str = GOOGLE_TOKENINFO_URI,
        userinfo_uri: str = GOOGLE_USERINFO_URI,
        persist_session: bool | None = None,
        session_path: Path | None = None,
    ) -> None:
        self._auth_uri = auth_uri
        self._token_uri = token_uri
        self._tokeninfo_uri = tokeninfo_uri
        self._userinfo_uri = userinfo_uri
        # Persist session to ~/.config/vertex_aiperf/oauth_session.json in production
        # (disabled automatically when custom mock endpoints are injected in unit tests)
        if persist_session is None:
            persist_session = token_uri == GOOGLE_TOKEN_URI
        self._persist_session = persist_session
        self._session_path = session_path or _default_session_path()

        self._lock = threading.Lock()
        self._pending_flows: dict[str, PendingOAuthFlow] = {}
        self._creds: oauth2_credentials.Credentials | None = None
        self._email: str | None = None

        if self._persist_session:
            self._load_persisted_session()

    def _load_persisted_session(self) -> None:
        try:
            if not self._session_path.is_file():
                return
            data = json.loads(self._session_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not data.get("email"):
                return
            expiry = None
            if data.get("expiry"):
                expiry = dt.datetime.fromisoformat(str(data["expiry"])).replace(
                    tzinfo=None
                )
            creds = oauth2_credentials.Credentials(
                token=data.get("token"),
                refresh_token=data.get("refresh_token"),
                token_uri=data.get("token_uri") or self._token_uri,
                client_id=data.get("client_id"),
                client_secret=data.get("client_secret"),
                scopes=data.get("scopes") or list(OAUTH_SCOPES),
                expiry=expiry,
            )
            self._creds = creds
            self._email = str(data["email"])
        except Exception:
            pass

    def _save_persisted_session_unlocked(self) -> None:
        if not self._persist_session or self._creds is None or not self._email:
            return
        try:
            self._session_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "email": self._email,
                "token": self._creds.token,
                "refresh_token": self._creds.refresh_token,
                "token_uri": self._creds.token_uri or self._token_uri,
                "client_id": self._creds.client_id,
                "client_secret": self._creds.client_secret,
                "scopes": list(self._creds.scopes or OAUTH_SCOPES),
                "expiry": self._creds.expiry.isoformat() if self._creds.expiry else None,
            }
            tmp_path = self._session_path.with_suffix(".tmp")
            tmp_path.write_text(json.dumps(payload), encoding="utf-8")
            os.chmod(tmp_path, stat.S_IRUSR | stat.S_IWUSR)
            tmp_path.replace(self._session_path)
        except OSError:
            pass

    def set_credentials(
        self, creds: oauth2_credentials.Credentials, email: str
    ) -> None:
        with self._lock:
            self._creds = creds
            self._email = email
            self._save_persisted_session_unlocked()

    def clear_credentials(self) -> None:
        with self._lock:
            self._creds = None
            self._email = None
            if self._persist_session:
                try:
                    self._session_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def start_oauth_flow(
        self,
        *,
        redirect_uri: str,
        client_id: str | None = None,
        client_secret: str | None = None,
    ) -> tuple[str, str]:
        """Create an OAuth 2.0 Authorization Code + PKCE URL and return (auth_url, state)."""
        resolved_client_id = (
            (client_id or "").strip()
            or os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "").strip()
            or DEFAULT_INSTALLED_CLIENT_ID
        )
        resolved_client_secret = (
            (client_secret or "").strip()
            or os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
            or (
                DEFAULT_INSTALLED_CLIENT_SECRET
                if resolved_client_id == DEFAULT_INSTALLED_CLIENT_ID
                else ""
            )
        )

        state = secrets.token_urlsafe(24)
        code_verifier = _b64url_no_pad(secrets.token_bytes(32))
        code_challenge = _b64url_no_pad(
            hashlib.sha256(code_verifier.encode("ascii")).digest()
        )

        flow = PendingOAuthFlow(
            state=state,
            code_verifier=code_verifier,
            redirect_uri=redirect_uri,
            client_id=resolved_client_id,
            client_secret=resolved_client_secret,
            auth_uri=self._auth_uri,
            token_uri=self._token_uri,
            created_at=dt.datetime.now(dt.timezone.utc),
        )
        with self._lock:
            cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=15)
            self._pending_flows = {
                k: v for k, v in self._pending_flows.items() if v.created_at >= cutoff
            }
            self._pending_flows[state] = flow

        params: dict[str, str] = {
            "client_id": resolved_client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(OAUTH_SCOPES),
            "access_type": "offline",
            "prompt": "consent select_account",
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{self._auth_uri}?{urlencode(params)}", state

    def has_pending_state(self, state: str | None) -> bool:
        if not state:
            return False
        with self._lock:
            return state in self._pending_flows

    def complete_oauth_flow(self, *, state: str, code: str) -> PrincipalInfo:
        """Exchange an OAuth 2.0 authorization code + PKCE verifier for Google Account credentials."""
        clean_code = (code or "").strip()
        if not clean_code:
            raise GoogleAuthError("Authorization code is empty.")

        with self._lock:
            flow = self._pending_flows.pop(state, None)
        if flow is None:
            raise GoogleAuthError(
                "OAuth login state expired or is invalid. Please click 'Sign in with Google' again."
            )

        token_payload: dict[str, str] = {
            "code": clean_code,
            "client_id": flow.client_id,
            "redirect_uri": flow.redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": flow.code_verifier,
        }
        if flow.client_secret:
            token_payload["client_secret"] = flow.client_secret

        try:
            resp = http_requests.post(flow.token_uri, data=token_payload, timeout=20)
        except Exception as exc:
            raise GoogleAuthError(f"Failed to contact Google token endpoint: {exc}") from exc

        try:
            data = resp.json()
        except Exception as exc:
            raise GoogleAuthError(
                f"Unexpected response from token endpoint (HTTP {resp.status_code})."
            ) from exc

        if not resp.ok or "access_token" not in data:
            err_desc = (
                data.get("error_description")
                or data.get("error")
                or f"HTTP {resp.status_code}"
            )
            raise GoogleAuthError(f"OAuth token exchange failed: {err_desc}")

        access_token = str(data["access_token"])
        refresh_token = data.get("refresh_token")
        expires_in = int(data.get("expires_in", 3600))
        id_token = data.get("id_token")

        expiry = (
            dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
            + dt.timedelta(seconds=expires_in)
        )
        creds = oauth2_credentials.Credentials(
            token=access_token,
            refresh_token=refresh_token,
            id_token=id_token,
            token_uri=flow.token_uri,
            client_id=flow.client_id,
            client_secret=flow.client_secret or None,
            scopes=list(OAUTH_SCOPES),
            expiry=expiry,
        )

        email = (
            _extract_email_from_id_token(id_token)
            or _fetch_userinfo_email(access_token, self._userinfo_uri)
            or "Signed-in Google Account"
        )
        self.set_credentials(creds, email)
        return PrincipalInfo(principal_email=email)

    def get_status(self) -> dict[str, Any]:
        """Return current Google Account sign-in state."""
        with self._lock:
            creds = self._creds
            email = self._email

        if creds is None or not email:
            return {
                "authenticated": False,
                "principal_email": None,
                "expires_in_seconds": None,
            }

        expires_in = GoogleIdentityTokenProvider._seconds_until_expiry(creds.expiry)
        return {
            "authenticated": True,
            "principal_email": email,
            "expires_in_seconds": expires_in,
        }

    def verify_live_token(
        self, *, quota_project: str | None = None
    ) -> tuple[PrincipalInfo, float | None]:
        """Verify that the signed-in Google OAuth2 token is genuinely active.

        1. Ensures a non-expired access token (refreshing via refresh_token only if expired
           so corporate RAPT accounts with an active 60-minute access token aren't rejected).
        2. Validates the access token live against Google's tokeninfo endpoint to retrieve
           the authoritative remaining lifetime in seconds.
        """
        provider = self.build_token_provider(quota_project=quota_project)
        token, local_expires = provider.get_access_token(force_refresh=False)

        try:
            resp = http_requests.get(
                self._tokeninfo_uri,
                headers={"Authorization": f"Bearer {token}"},
                timeout=10,
            )
            if resp.status_code in (400, 401):
                # Token was revoked or expired early; try refreshing once if possible
                token, local_expires = provider.get_access_token(force_refresh=True)
                resp = http_requests.get(
                    self._tokeninfo_uri,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=10,
                )

            if not resp.ok:
                raise GoogleAuthError(
                    f"Google rejected the current access token (HTTP {resp.status_code}). Please sign in again."
                )

            info_json = resp.json()
            live_expires = float(info_json["expires_in"]) if "expires_in" in info_json else local_expires
            verified_email = info_json.get("email") or provider.info.principal_email

            with self._lock:
                if self._creds is not None and live_expires is not None:
                    self._creds.expiry = dt.datetime.now(
                        dt.timezone.utc
                    ).replace(tzinfo=None) + dt.timedelta(seconds=live_expires)
                if verified_email:
                    self._email = str(verified_email)
                self._save_persisted_session_unlocked()

            return (
                PrincipalInfo(
                    principal_email=str(verified_email),
                    quota_project=provider.quota_project,
                ),
                live_expires,
            )
        except GoogleAuthError:
            raise
        except Exception as exc:
            raise GoogleAuthError(f"Token verification failed: {exc}") from exc

    def build_token_provider(
        self,
        *,
        quota_project: str | None = None,
    ) -> GoogleIdentityTokenProvider:
        """Create a TokenProvider backed by the signed-in Google Account."""
        clean_quota = (quota_project or "").strip() or None
        with self._lock:
            creds = self._creds
            email = self._email

        if creds is None or not email:
            raise GoogleAuthError(
                "Not signed in. Click 'Sign in with Google' first to authenticate with your Google Account."
            )

        info = PrincipalInfo(
            principal_email=email,
            quota_project=clean_quota,
        )
        return GoogleIdentityTokenProvider(
            info=info,
            oauth_creds=creds,
            on_refresh=lambda: self._save_after_refresh(),
        )

    def _save_after_refresh(self) -> None:
        with self._lock:
            self._save_persisted_session_unlocked()


class GoogleIdentityTokenProvider:
    """Thread-safe OAuth2 access token provider backed by a signed-in Google Account."""

    def __init__(
        self,
        *,
        info: PrincipalInfo,
        oauth_creds: oauth2_credentials.Credentials,
        on_refresh: Any = None,
    ) -> None:
        self.info = info
        self._creds = oauth_creds
        self._on_refresh = on_refresh
        self._lock = threading.Lock()
        self._request = Request()

    @property
    def quota_project(self) -> str | None:
        return self.info.quota_project

    def get_access_token(self, *, force_refresh: bool = False) -> tuple[str, float | None]:
        """Return a valid OAuth2 Bearer token for the signed-in Google Account and seconds to expiry."""
        with self._lock:
            remaining = self._seconds_until_expiry(self._creds.expiry)
            needs_refresh = (
                force_refresh
                or not self._creds.token
                or (remaining is not None and remaining <= 60)
            )

            if not needs_refresh and remaining is not None and remaining < TOKEN_REFRESH_MARGIN_SECONDS:
                # Opportunistic background-safe refresh when < 5m left, but if refresh_token
                # is absent or RAPT blocks silent refresh, keep using the still-valid token!
                if self._creds.refresh_token:
                    try:
                        self._creds.refresh(self._request)
                        if self._on_refresh:
                            self._on_refresh()
                    except Exception:
                        pass
                return str(self._creds.token), self._seconds_until_expiry(self._creds.expiry)

            if needs_refresh:
                if not self._creds.refresh_token:
                    if (
                        self._creds.token
                        and not force_refresh
                        and (remaining is None or remaining > 0)
                    ):
                        return self._creds.token, remaining
                    raise GoogleAuthError(
                        f"OAuth2 session for '{self.info.principal_email}' expired. "
                        "Please click 'Sign in with Google' again."
                    )
                try:
                    self._creds.refresh(self._request)
                    if self._on_refresh:
                        self._on_refresh()
                except Exception as exc:
                    raise GoogleAuthError(
                        f"Failed to refresh Google OAuth2 token for '{self.info.principal_email}': {exc}"
                    ) from exc

            token = self._creds.token
            if not token:
                raise GoogleAuthError(
                    "Google OAuth2 refresh returned an empty access token."
                )

            return token, self._seconds_until_expiry(self._creds.expiry)

    @staticmethod
    def _seconds_until_expiry(expiry: dt.datetime | None) -> float | None:
        if expiry is None:
            return None
        if expiry.tzinfo is None:
            now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        else:
            now = dt.datetime.now(dt.timezone.utc)
        return max(0.0, (expiry - now).total_seconds())
