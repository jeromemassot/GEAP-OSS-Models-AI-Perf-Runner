"""FastAPI application serving the GEAP AIPerf Runner with Google Identity OAuth 2.0."""

from __future__ import annotations

import asyncio
import hashlib
import html
import io
import json
import zipfile
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from vertex_aiperf.auth import (
    GOOGLE_SDK_AUTHCODE_REDIRECT_URI,
    GoogleAuthError,
)
from vertex_aiperf.command_parser import (
    CommandParseError,
    parse_and_validate_aiperf_command,
)
from vertex_aiperf.runner import RunManager

STATIC_DIR = Path(__file__).resolve().parent / "static"


class StartOAuthRequest(BaseModel):
    mode: Literal["loopback", "authcode"] = Field(
        default="loopback",
        description="'loopback' redirects to http://localhost:<port>/; 'authcode' displays a pasteable code.",
    )
    client_id: str | None = None
    client_secret: str | None = None


class ExchangeOAuthCodeRequest(BaseModel):
    state: str
    code: str


class VerifyAuthRequest(BaseModel):
    quota_project: str | None = None


class ValidateCommandRequest(BaseModel):
    command: str = Field(..., description="AIPerf CLI command string")


class StartRunRequest(BaseModel):
    command: str = Field(..., description="AIPerf CLI command string")
    run_name: str | None = Field(
        default=None,
        description="Optional custom run name (also used for the downloaded .zip filename).",
    )
    hf_token: str | None = Field(
        default=None,
        repr=False,
        description="Optional HuggingFace token set as HF_TOKEN environment variable for AIPerf.",
    )
    quota_project: str | None = Field(
        default=None,
        description="Optional GCP project ID/number for X-Goog-User-Project billing/quota header.",
    )
    auth_mode: Literal["direct", "proxy"] = Field(
        default="direct",
        description="'direct' injects Bearer token in-memory; 'proxy' auto-refreshes via loopback proxy.",
    )


def _render_oauth_callback_html(*, ok: bool, title: str, detail: str) -> str:
    safe_title = html.escape(title)
    safe_detail = html.escape(detail)
    payload_json = json.dumps(
        {
            "type": "vertex_aiperf_oauth_complete",
            "ok": ok,
            "detail": detail,
        }
    )
    accent = "hsl(152, 68%, 29%)" if ok else "hsl(356, 72%, 42%)"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>{safe_title} — GEAP AIPerf Runner</title>
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg" />
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: hsl(210, 24%, 97%);
      color: hsl(216, 28%, 14%);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }}
    .card {{
      background: #fff;
      border: 1px solid hsl(214, 20%, 88%);
      border-radius: 12px;
      padding: 28px 32px;
      max-width: 440px;
      box-shadow: 0 6px 20px -4px hsla(216, 28%, 12%, 0.08);
      text-align: center;
    }}
    h1 {{ font-size: 1.15rem; margin: 0 0 8px; color: {accent}; }}
    p {{ font-size: 0.9rem; color: hsl(215, 16%, 38%); margin: 0 0 18px; }}
    a {{
      display: inline-block;
      padding: 8px 16px;
      border-radius: 6px;
      background: hsl(211, 84%, 42%);
      color: #fff;
      text-decoration: none;
      font-size: 0.86rem;
      font-weight: 600;
    }}
  </style>
</head>
<body>
  <div class="card">
    <h1>{safe_title}</h1>
    <p>{safe_detail}</p>
    <a href="/">Return to GEAP AIPerf Runner</a>
  </div>
  <script>
    (function() {{
      var msg = {payload_json};
      if (window.opener && !window.opener.closed) {{
        try {{ window.opener.postMessage(msg, "*"); }} catch (e) {{}}
        setTimeout(function() {{ window.close(); }}, 500);
      }} else if (msg.ok) {{
        setTimeout(function() {{ window.location.replace("/"); }}, 900);
      }}
    }})();
  </script>
</body>
</html>"""


def _compute_static_asset_version() -> str:
    digest = hashlib.sha256()
    for name in ("styles.css", "app.js", "favicon.svg"):
        asset = STATIC_DIR / name
        if asset.is_file():
            digest.update(asset.read_bytes())
    return digest.hexdigest()[:10]


def create_app(run_manager: RunManager | None = None) -> FastAPI:
    manager = run_manager or RunManager()
    app = FastAPI(
        title="GEAP AIPerf Runner",
        description="Lightweight Google Identity OAuth 2.0 wrapper for running NVIDIA AIPerf against Vertex AI Endpoints.",
        version="0.3.0",
    )
    app.state.run_manager = manager

    @app.middleware("http")
    async def disable_static_caching(request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        path = request.url.path
        if path in ("/", "/favicon.ico") or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> FileResponse:
        return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")

    @app.get("/", include_in_schema=False, response_model=None)
    async def index(
        code: str | None = Query(default=None),
        state: str | None = Query(default=None),
        error: str | None = Query(default=None),
    ) -> HTMLResponse | FileResponse:
        # Handle loopback Google OAuth 2.0 callback (`http://localhost:<port>/?code=...&state=...`)
        if state and manager.auth_manager.has_pending_state(state):
            if error:
                return HTMLResponse(
                    _render_oauth_callback_html(
                        ok=False,
                        title="Google Sign-In Cancelled",
                        detail=f"Google returned: {error}",
                    )
                )
            if code:
                try:
                    principal = await asyncio.to_thread(
                        manager.auth_manager.complete_oauth_flow,
                        state=state,
                        code=code,
                    )
                    return HTMLResponse(
                        _render_oauth_callback_html(
                            ok=True,
                            title="Google Identity Connected",
                            detail=f"Signed in as {principal.principal_email}. This window will close automatically.",
                        )
                    )
                except GoogleAuthError as exc:
                    return HTMLResponse(
                        _render_oauth_callback_html(
                            ok=False,
                            title="Authentication Failed",
                            detail=str(exc),
                        ),
                        status_code=400,
                    )

        ver = _compute_static_asset_version()
        raw_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        versioned_html = (
            raw_html.replace("/static/styles.css", f"/static/styles.css?v={ver}")
            .replace("/static/app.js", f"/static/app.js?v={ver}")
            .replace("/static/favicon.svg", f"/static/favicon.svg?v={ver}")
        )
        return HTMLResponse(versioned_html)

    @app.get("/api/auth/status")
    async def api_auth_status() -> dict[str, Any]:
        return await asyncio.to_thread(manager.auth_manager.get_status)

    @app.post("/api/auth/oauth/start")
    async def api_oauth_start(
        req: StartOAuthRequest, request: Request
    ) -> dict[str, Any]:
        if req.mode == "authcode":
            redirect_uri = GOOGLE_SDK_AUTHCODE_REDIRECT_URI
        else:
            port = request.url.port
            port_part = f":{port}" if port else ""
            redirect_uri = f"http://localhost{port_part}/"

        auth_url, state = manager.auth_manager.start_oauth_flow(
            redirect_uri=redirect_uri,
            client_id=req.client_id,
            client_secret=req.client_secret,
        )
        return {
            "auth_url": auth_url,
            "state": state,
            "mode": req.mode,
            "redirect_uri": redirect_uri,
        }

    @app.post("/api/auth/oauth/exchange")
    async def api_oauth_exchange(req: ExchangeOAuthCodeRequest) -> dict[str, Any]:
        try:
            principal = await asyncio.to_thread(
                manager.auth_manager.complete_oauth_flow,
                state=req.state,
                code=req.code,
            )
            status = await asyncio.to_thread(manager.auth_manager.get_status)
            return {
                "authenticated": True,
                "principal": principal.to_dict(),
                "status": status,
            }
        except GoogleAuthError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/auth/verify")
    async def api_auth_verify(req: VerifyAuthRequest) -> dict[str, Any]:
        try:
            info, expires_in = await asyncio.to_thread(
                manager.auth_manager.verify_live_token,
                quota_project=req.quota_project,
            )
            return {
                "valid": True,
                "info": info.to_dict(),
                "expires_in_seconds": expires_in,
            }
        except GoogleAuthError as exc:
            return {"valid": False, "error": str(exc)}

    @app.post("/api/auth/logout")
    async def api_auth_logout() -> dict[str, Any]:
        manager.auth_manager.clear_credentials()
        return await asyncio.to_thread(manager.auth_manager.get_status)

    @app.post("/api/validate-command")
    async def api_validate_command(req: ValidateCommandRequest) -> dict[str, Any]:
        try:
            parsed = await asyncio.to_thread(
                parse_and_validate_aiperf_command, req.command
            )
            return {"valid": True, "parsed": parsed.to_dict()}
        except CommandParseError as exc:
            return {"valid": False, "error": str(exc)}

    @app.get("/api/runs")
    async def api_list_runs() -> dict[str, Any]:
        return {"runs": manager.list_jobs()}

    @app.post("/api/runs")
    async def api_start_run(req: StartRunRequest) -> dict[str, Any]:
        try:
            job = await manager.start_run(
                raw_command=req.command,
                run_name=req.run_name,
                hf_token=req.hf_token,
                quota_project=req.quota_project,
                auth_mode=req.auth_mode,
            )
            return {"run_id": job.run_id, "job": job.to_dict(include_logs=True)}
        except (GoogleAuthError, CommandParseError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/runs/{run_id}")
    async def api_get_run(run_id: str, include_logs: bool = False) -> dict[str, Any]:
        job = manager.get_job(run_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found.")
        return {"job": job.to_dict(include_logs=include_logs)}

    @app.post("/api/runs/{run_id}/stop")
    async def api_stop_run(run_id: str) -> dict[str, Any]:
        try:
            job = await manager.stop_run(run_id)
            return {"job": job.to_dict(include_logs=False)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/runs/{run_id}/stream")
    async def api_stream_run(run_id: str) -> StreamingResponse:
        try:
            job, existing_logs, queue = manager.subscribe(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        async def event_generator():
            try:
                init_payload = json.dumps(
                    {
                        "type": "init",
                        "job": job.to_dict(include_logs=False),
                        "logs": existing_logs,
                    }
                )
                yield f"data: {init_payload}\n\n"

                while True:
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue

                    if event is None:
                        done_payload = json.dumps(
                            {
                                "type": "done",
                                "job": job.to_dict(include_logs=False),
                            }
                        )
                        yield f"data: {done_payload}\n\n"
                        break

                    yield f"data: {json.dumps(event)}\n\n"
            finally:
                manager.unsubscribe(run_id, queue)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/runs/{run_id}/artifacts-zip")
    @app.get("/api/runs/{run_id}/artifacts-zip/{requested_name}")
    async def api_download_artifacts_zip(
        run_id: str, requested_name: str | None = None
    ) -> Response:
        _ = requested_name
        job = manager.get_job(run_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found.")

        base = job.artifact_dir.resolve()
        if not base.is_dir():
            raise HTTPException(status_code=404, detail="No artifact directory found for this run.")

        def _build_zip_bytes() -> bytes:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
                for file_path in sorted(base.rglob("*")):
                    if file_path.is_file():
                        arcname = file_path.relative_to(base).as_posix()
                        zf.write(file_path, arcname=arcname)
            return buf.getvalue()

        zip_bytes = await asyncio.to_thread(_build_zip_bytes)
        zip_filename = job.zip_filename
        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{zip_filename}"',
            },
        )

    @app.get("/api/runs/{run_id}/artifacts/{artifact_path:path}")
    async def api_download_artifact(run_id: str, artifact_path: str) -> FileResponse:
        job = manager.get_job(run_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found.")

        base = job.artifact_dir.resolve()
        target = (base / artifact_path).resolve()
        if not target.is_relative_to(base) or not target.is_file():
            raise HTTPException(status_code=404, detail="Artifact file not found.")

        return FileResponse(
            target,
            filename=target.name,
        )

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    return app
