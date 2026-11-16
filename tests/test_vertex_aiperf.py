"""Unit and end-to-end integration tests for Google Account OAuth 2.0 + AIPerf."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import tempfile
import threading
import time
import unittest
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

from aiohttp import web
from fastapi.testclient import TestClient
from tokenizers import Tokenizer
from tokenizers.models import WordLevel
from tokenizers.pre_tokenizers import Whitespace

from vertex_aiperf.auth import GoogleAuthError, GoogleAuthManager
from vertex_aiperf.command_parser import (
    CommandParseError,
    inspect_vertex_url,
    parse_and_validate_aiperf_command,
    rewrite_urls_in_tokens,
)
from vertex_aiperf.runner import RunManager, run_cli_mode, sanitize_run_name
from vertex_aiperf.server import create_app


def _make_fake_id_token(email: str) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"RS256","typ":"JWT"}').rstrip(b"=").decode()
    payload = (
        base64.urlsafe_b64encode(
            json.dumps({"iss": "https://accounts.google.com", "email": email}).encode()
        )
        .rstrip(b"=")
        .decode()
    )
    return f"{header}.{payload}.sig"


def create_local_hf_tokenizer(directory: Path) -> Path:
    vocab = {
        "<unk>": 0,
        "<pad>": 1,
        "Hello": 2,
        "world": 3,
        "Vertex": 4,
        "AI": 5,
        "benchmark": 6,
        "test": 7,
    }
    tok = Tokenizer(WordLevel(vocab=vocab, unk_token="<unk>"))
    tok.pre_tokenizer = Whitespace()
    tok_dir = directory / "local_tokenizer"
    tok_dir.mkdir(parents=True, exist_ok=True)
    tok.save(str(tok_dir / "tokenizer.json"))
    (tok_dir / "tokenizer_config.json").write_text(
        json.dumps(
            {
                "tokenizer_class": "PreTrainedTokenizerFast",
                "unk_token": "<unk>",
                "pad_token": "<pad>",
            }
        ),
        encoding="utf-8",
    )
    return tok_dir


class MockGoogleOAuth2Server:
    """Local mock of Google's OAuth 2.0 token & userinfo endpoints with PKCE check."""

    def __init__(
        self,
        *,
        user_email: str = "jeromemassot@example.com",
        minted_access_token: str = "mock-user-principal-oauth-token-123456",
        refreshed_access_token: str = "mock-user-principal-refreshed-token-789012",
    ) -> None:
        self.user_email = user_email
        self.minted_access_token = minted_access_token
        self.refreshed_access_token = refreshed_access_token
        self.expected_code_challenge: str | None = None
        self.grant_types_seen: list[str] = []

        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length).decode("utf-8")
                params = parse_qs(body)
                grant_type = (params.get("grant_type") or [""])[0]
                parent.grant_types_seen.append(grant_type)

                if grant_type == "authorization_code":
                    verifier = (params.get("code_verifier") or [""])[0]
                    computed_challenge = (
                        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                        .rstrip(b"=")
                        .decode("ascii")
                    )
                    if (
                        parent.expected_code_challenge
                        and computed_challenge != parent.expected_code_challenge
                    ):
                        self._write_json(400, {"error": "invalid_grant", "error_description": "PKCE mismatch"})
                        return
                    self._write_json(
                        200,
                        {
                            "access_token": parent.minted_access_token,
                            "refresh_token": "1//mock-user-refresh-token",
                            "expires_in": 3600,
                            "token_type": "Bearer",
                            "id_token": _make_fake_id_token(parent.user_email),
                        },
                    )
                elif grant_type == "refresh_token":
                    self._write_json(
                        200,
                        {
                            "access_token": parent.refreshed_access_token,
                            "expires_in": 3600,
                            "token_type": "Bearer",
                            "id_token": _make_fake_id_token(parent.user_email),
                        },
                    )
                else:
                    self._write_json(400, {"error": "unsupported_grant_type"})

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/userinfo":
                    self._write_json(200, {"email": parent.user_email})
                elif self.path.startswith("/tokeninfo"):
                    auth = self.headers.get("Authorization", "")
                    valid_tokens = {
                        f"Bearer {parent.minted_access_token}",
                        f"Bearer {parent.refreshed_access_token}",
                    }
                    if auth in valid_tokens:
                        self._write_json(
                            200,
                            {
                                "email": parent.user_email,
                                "expires_in": "3542",
                            },
                        )
                    else:
                        self._write_json(400, {"error": "invalid_token"})
                else:
                    self._write_json(404, {"error": "not_found"})

            def _write_json(self, status: int, payload: dict[str, object]) -> None:
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self.auth_uri = f"http://127.0.0.1:{self.port}/auth"
        self.token_uri = f"http://127.0.0.1:{self.port}/token"
        self.tokeninfo_uri = f"http://127.0.0.1:{self.port}/tokeninfo"
        self.userinfo_uri = f"http://127.0.0.1:{self.port}/userinfo"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> MockGoogleOAuth2Server:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()


class TestGoogleAccountOAuth(unittest.TestCase):
    def test_requires_google_account_signin_initially(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            mgr = GoogleAuthManager(
                persist_session=True,
                session_path=Path(tmpdir) / "nonexistent_session.json",
            )
            status = mgr.get_status()
            self.assertFalse(status["authenticated"])
            with self.assertRaises(GoogleAuthError):
                mgr.build_token_provider()

    def test_pkce_oauth_flow_verify_token_and_session_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir, MockGoogleOAuth2Server() as oauth_srv:
            sess_file = Path(tmpdir) / "oauth_session.json"
            mgr = GoogleAuthManager(
                auth_uri=oauth_srv.auth_uri,
                token_uri=oauth_srv.token_uri,
                tokeninfo_uri=oauth_srv.tokeninfo_uri,
                userinfo_uri=oauth_srv.userinfo_uri,
                persist_session=True,
                session_path=sess_file,
            )
            auth_url, state = mgr.start_oauth_flow(redirect_uri="http://localhost:8080/")
            parsed_url = urlparse(auth_url)
            qs = parse_qs(parsed_url.query)
            self.assertEqual(qs["code_challenge_method"], ["S256"])
            self.assertIn("https://www.googleapis.com/auth/cloud-platform", qs["scope"][0])

            oauth_srv.expected_code_challenge = qs["code_challenge"][0]
            principal = mgr.complete_oauth_flow(state=state, code="4/mock-auth-code")
            self.assertEqual(principal.principal_email, "jeromemassot@example.com")
            self.assertTrue(sess_file.is_file())

            # Reloading a fresh manager restores the persisted session across server restarts
            mgr_reloaded = GoogleAuthManager(
                auth_uri=oauth_srv.auth_uri,
                token_uri=oauth_srv.token_uri,
                tokeninfo_uri=oauth_srv.tokeninfo_uri,
                userinfo_uri=oauth_srv.userinfo_uri,
                persist_session=True,
                session_path=sess_file,
            )
            self.assertTrue(mgr_reloaded.get_status()["authenticated"])
            verified_info, live_exp = mgr_reloaded.verify_live_token()
            self.assertEqual(verified_info.principal_email, "jeromemassot@example.com")
            self.assertEqual(live_exp, 3542.0)
            # Notice verify_live_token verified via /tokeninfo without forcing an unnecessary refresh_token grant!
            self.assertEqual(oauth_srv.grant_types_seen, ["authorization_code"])

            provider = mgr_reloaded.build_token_provider(quota_project="123456789012")
            tok2, _ = provider.get_access_token(force_refresh=True)
            self.assertEqual(tok2, "mock-user-principal-refreshed-token-789012")
            self.assertEqual(
                oauth_srv.grant_types_seen,
                ["authorization_code", "refresh_token"],
            )

    def test_invalid_state_rejected(self) -> None:
        mgr = GoogleAuthManager(persist_session=False)
        with self.assertRaises(GoogleAuthError):
            mgr.complete_oauth_flow(state="nonexistent", code="abc")


class TestCommandParser(unittest.TestCase):
    def test_parses_exact_user_prompt_command_with_num_conversations(self) -> None:
        raw = (
            'aiperf profile  --model Qwen/Qwen3.5-9B  --use-server-token-count  '
            '--random-seed 42  --url "https://9876543210987654321.us-central1-123456789012.prediction.vertexai.goog'
            '/v1/projects/123456789012/locations/us-central1/endpoints/9876543210987654321/invoke/v1/chat/completions"  '
            '--endpoint-type chat  --public-dataset exgentic_v2  '
            '--dataset-filter benchmark=swebench  --dataset-filter harness=tool_calling  '
            '--concurrency 5  --num-conversations 100 --streaming"'
        )
        parsed = parse_and_validate_aiperf_command(raw)
        self.assertEqual(parsed.subcommand, "profile")
        self.assertEqual(parsed.models, ["Qwen/Qwen3.5-9B"])
        self.assertTrue(parsed.streaming)
        self.assertEqual(parsed.concurrency, "5")
        self.assertEqual(parsed.num_conversations, "100")
        self.assertEqual(parsed.to_dict()["num_conversations"], "100")
        ve = parsed.vertex_endpoints[0]
        self.assertTrue(ve.is_vertex_ai)
        self.assertEqual(ve.project, "123456789012")
        self.assertEqual(ve.location, "us-central1")
        self.assertEqual(ve.endpoint_id, "9876543210987654321")

    def test_rejects_shell_chaining_operators(self) -> None:
        with self.assertRaises(CommandParseError):
            parse_and_validate_aiperf_command(
                "aiperf profile --model m --url http://localhost:8000 ; whoami"
            )

    def test_sanitize_run_name(self) -> None:
        self.assertIsNone(sanitize_run_name(None))
        self.assertIsNone(sanitize_run_name("   "))
        self.assertEqual(sanitize_run_name("Qwen 3.5 9B Run 1.zip"), "Qwen-3.5-9B-Run-1")
        self.assertEqual(sanitize_run_name("../../my_bench"), "my_bench")
        with self.assertRaises(ValueError):
            sanitize_run_name("...")


class TestEndToEndGoogleAccountAIPerf(unittest.TestCase):
    """Runs real AIPerf benchmarks authenticated via Google Account OAuth 2.0."""

    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tmpdir.name)
        self.tok_dir = create_local_hf_tokenizer(self.root)
        self.dataset_file = self.root / "prompts.jsonl"
        self.dataset_file.write_text(
            '{"text": "Hello Vertex AI"}\n{"text": "Hello world benchmark test"}\n',
            encoding="utf-8",
        )
        self.expected_token = "mock-e2e-google-account-oauth-token-999"
        self.oauth_server = MockGoogleOAuth2Server(
            user_email="jeromemassot@example.com",
            minted_access_token=self.expected_token,
            refreshed_access_token=self.expected_token,
        )
        self.oauth_server.__enter__()

        self.auth_headers_seen: list[str] = []
        self._start_mock_vertex_server()

    def tearDown(self) -> None:
        self._stop_mock_vertex_server()
        self.oauth_server.__exit__(None, None, None)
        self.tmpdir.cleanup()

    def _start_mock_vertex_server(self) -> None:
        self._loop = asyncio.new_event_loop()
        ready = threading.Event()

        async def handle_chat(request: web.Request) -> web.StreamResponse:
            auth_hdr = request.headers.get("Authorization", "")
            self.auth_headers_seen.append(auth_hdr)
            if auth_hdr != f"Bearer {self.expected_token}":
                return web.json_response({"error": "Unauthenticated"}, status=401)

            payload = await request.json()
            if payload.get("stream"):
                resp = web.StreamResponse(
                    status=200,
                    headers={"Content-Type": "text/event-stream"},
                )
                await resp.prepare(request)
                chunks = [
                    {
                        "id": "chatcmpl-1",
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hello"}, "finish_reason": None}],
                    },
                    {
                        "id": "chatcmpl-1",
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {"content": " Vertex"}, "finish_reason": "stop"}],
                    },
                    {
                        "id": "chatcmpl-1",
                        "object": "chat.completion.chunk",
                        "choices": [],
                        "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
                    },
                ]
                for chunk in chunks:
                    await resp.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                    await asyncio.sleep(0.01)
                await resp.write(b"data: [DONE]\n\n")
                await resp.write_eof()
                return resp

            return web.json_response(
                {
                    "id": "chatcmpl-1",
                    "object": "chat.completion",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello Vertex"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
                }
            )

        async def boot() -> None:
            app = web.Application()
            app.router.add_post(
                "/v1/projects/123456789012/locations/us-central1/endpoints/9876543210987654321/invoke/v1/chat/completions",
                handle_chat,
            )
            self._vertex_runner = web.AppRunner(app, access_log=None)
            await self._vertex_runner.setup()
            site = web.TCPSite(self._vertex_runner, "127.0.0.1", 0)
            await site.start()
            self.vertex_port = site._server.sockets[0].getsockname()[1]
            self.vertex_url = (
                f"http://127.0.0.1:{self.vertex_port}"
                "/v1/projects/123456789012/locations/us-central1/endpoints/9876543210987654321/invoke/v1/chat/completions"
            )
            ready.set()

        def run_loop() -> None:
            asyncio.set_event_loop(self._loop)
            self._loop.run_until_complete(boot())
            self._loop.run_forever()

        self._vertex_thread = threading.Thread(target=run_loop, daemon=True)
        self._vertex_thread.start()
        ready.wait(timeout=5.0)

    def _stop_mock_vertex_server(self) -> None:
        async def shutdown() -> None:
            await self._vertex_runner.cleanup()

        fut = asyncio.run_coroutine_threadsafe(shutdown(), self._loop)
        fut.result(timeout=5.0)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._vertex_thread.join(timeout=5.0)

    def _build_aiperf_cmd(self) -> str:
        return (
            f'aiperf profile --model Qwen/Qwen3.5-9B '
            f'--tokenizer "{self.tok_dir}" '
            f'--use-server-token-count '
            f'--input-file "{self.dataset_file}" '
            f'--custom-dataset-type single_turn '
            f'--url "{self.vertex_url}" '
            f'--endpoint-type chat '
            f'--concurrency 2 '
            f'--num-conversations 4 '
            f'--no-server-metrics '
            f'--no-gpu-telemetry '
            f'--streaming'
        )

    def test_ui_html_and_full_runs_direct_proxy_and_cli(self) -> None:
        import re

        auth_mgr = GoogleAuthManager(
            auth_uri=self.oauth_server.auth_uri,
            token_uri=self.oauth_server.token_uri,
            tokeninfo_uri=self.oauth_server.tokeninfo_uri,
            userinfo_uri=self.oauth_server.userinfo_uri,
        )
        runs_dir = self.root / "runs"
        manager = RunManager(base_runs_dir=runs_dir, auth_manager=auth_mgr)
        app = create_app(run_manager=manager)

        with TestClient(app) as client:
            # 1. Verify cache-busting headers, versioned static URLs, and 100% matching DOM IDs between app.js & index.html
            home_resp = client.get("/")
            self.assertIn("no-store", home_resp.headers.get("cache-control", ""))
            html_page = home_resp.text
            self.assertRegex(html_page, r"/static/app\.js\?v=[0-9a-f]{10}")
            self.assertRegex(html_page, r"/static/styles\.css\?v=[0-9a-f]{10}")
            self.assertRegex(html_page, r"/static/favicon\.svg\?v=[0-9a-f]{10}")
            self.assertIn("<title>GEAP AIPerf Runner</title>", html_page)
            self.assertIn("<h1>GEAP AIPerf Runner</h1>", html_page)
            self.assertIn("Benchmarks your GEAP deployed models with AIPerf", html_page)
            self.assertIn('class="brand-rocket-icon"', html_page)
            self.assertNotIn("Vertex AI AIPerf Runner", html_page)

            fav_svg_resp = client.get("/static/favicon.svg")
            self.assertEqual(fav_svg_resp.status_code, 200)
            self.assertIn("<svg", fav_svg_resp.text)
            fav_ico_resp = client.get("/favicon.ico")
            self.assertEqual(fav_ico_resp.status_code, 200)
            self.assertIn("<svg", fav_ico_resp.text)

            js_resp = client.get("/static/app.js")
            self.assertEqual(js_resp.status_code, 200)
            self.assertIn("no-store", js_resp.headers.get("cache-control", ""))
            referenced_ids = set(re.findall(r'getElementById\("([^"]+)"\)', js_resp.text))
            html_ids = set(re.findall(r'id="([^"]+)"', html_page))
            missing_ids = referenced_ids - html_ids
            self.assertEqual(missing_ids, set(), f"app.js references missing HTML IDs: {missing_ids}")

            self.assertNotIn('id="runtime-badge"', html_page)
            self.assertIn('class="header-auth"', html_page)
            self.assertIn('id="google-signin-btn"', html_page)
            self.assertIn('id="verify-token-btn"', html_page)
            self.assertIn('id="token-validity-caption"', html_page)
            self.assertIn('id="tab-btn-config"', html_page)
            self.assertIn('id="tab-btn-output"', html_page)
            self.assertIn('id="tab-btn-results"', html_page)
            self.assertIn('id="tab-panel-config"', html_page)
            self.assertIn('id="tab-panel-output"', html_page)
            self.assertIn('id="tab-panel-results"', html_page)
            self.assertIn('id="past-runs-selector-list"', html_page)
            self.assertIn('id="comparison-table-wrapper"', html_page)
            self.assertIn('id="results-charts-grid"', html_page)
            self.assertIn('id="run-name-input"', html_page)
            self.assertIn('type="password"', html_page)
            self.assertIn('id="hf-token-input"', html_page)
            self.assertIn('id="download-zip-btn"', html_page)
            self.assertIn('id="history-panel"', html_page)
            self.assertNotIn("identity-source-select", html_page)
            self.assertNotIn("metrics-table-container", html_page)

            # 2. Validate command returns num_conversations
            cmd = self._build_aiperf_cmd()
            val_cmd = client.post("/api/validate-command", json={"command": cmd}).json()
            self.assertTrue(val_cmd["valid"])
            self.assertEqual(val_cmd["parsed"]["num_conversations"], "4")

            # 3. Complete Google Account OAuth 2.0 loopback callback
            start_oauth = client.post("/api/auth/oauth/start", json={"mode": "loopback"}).json()
            qs = parse_qs(urlparse(start_oauth["auth_url"]).query)
            self.oauth_server.expected_code_challenge = qs["code_challenge"][0]

            cb = client.get(f"/?code=4/browser-code&state={start_oauth['state']}")
            self.assertEqual(cb.status_code, 200)

            status_res = client.get("/api/auth/status").json()
            self.assertTrue(status_res["authenticated"])
            self.assertEqual(status_res["principal_email"], "jeromemassot@example.com")

            verify_res = client.post("/api/auth/verify", json={}).json()
            self.assertTrue(verify_res["valid"])

            # 4. Run full AIPerf benchmark in BOTH 'direct' and 'proxy' modes (with custom run_name and optional hf_token)
            test_hf_secret = "hf_secretTestTokenValue123456789"
            for mode in ("direct", "proxy"):
                self.auth_headers_seen.clear()
                custom_name = f"qwen3.5-bench-{mode}"
                run_res = client.post(
                    "/api/runs",
                    json={
                        "command": cmd,
                        "run_name": custom_name,
                        "hf_token": test_hf_secret,
                        "auth_mode": mode,
                    },
                )
                self.assertEqual(run_res.status_code, 200, run_res.text)
                self.assertNotIn(test_hf_secret, run_res.text)
                run_id = run_res.json()["run_id"]
                self.assertEqual(run_id, custom_name)
                self.assertEqual(run_res.json()["job"]["zip_filename"], f"{custom_name}.zip")

                deadline = time.monotonic() + 35.0
                job_data = None
                while time.monotonic() < deadline:
                    poll_resp = client.get(f"/api/runs/{run_id}?include_logs=true")
                    self.assertNotIn(test_hf_secret, poll_resp.text)
                    poll = poll_resp.json()["job"]
                    if poll["status"] in ("succeeded", "failed", "cancelled"):
                        job_data = poll
                        break
                    time.sleep(0.3)

                self.assertIsNotNone(job_data, f"Run timed out in mode={mode}")
                assert job_data is not None
                self.assertEqual(
                    job_data["status"],
                    "succeeded",
                    f"Mode {mode} failed:\n" + "\n".join(job_data.get("logs", [])),
                )
                self.assertGreaterEqual(len(self.auth_headers_seen), 4)
                self.assertTrue(
                    all(h == f"Bearer {self.expected_token}" for h in self.auth_headers_seen)
                )
                joined_logs = "\n".join(job_data["logs"])
                self.assertNotIn(self.expected_token, joined_logs)
                self.assertNotIn("[vertex-aiperf]", joined_logs)
                # Verify verbatim AIPerf ASCII table layout is surfaced in logs
                self.assertIn("┏━", joined_logs)
                self.assertIn("Time to First Token", joined_logs)

                # Verify single-click ZIP archive uses custom run_name.zip and contains all generated files
                zip_res = client.get(f"/api/runs/{run_id}/artifacts-zip/{custom_name}.zip")
                self.assertEqual(zip_res.status_code, 200)
                self.assertEqual(zip_res.headers["content-type"], "application/zip")
                self.assertIn(
                    f'filename="{custom_name}.zip"',
                    zip_res.headers.get("content-disposition", ""),
                )
                with zipfile.ZipFile(io.BytesIO(zip_res.content)) as zf:
                    zip_names = set(zf.namelist())
                expected_names = {art["name"] for art in job_data["artifacts"]}
                self.assertTrue(expected_names)
                self.assertEqual(zip_names, expected_names)
                self.assertIn("profile_export_aiperf.csv", zip_names)
                self.assertIn("profile_export_aiperf.json", zip_names)

            # 4b. Verify Past Runs & Metrics discovery API across both completed runs
            art_runs_res = client.get("/api/artifact-runs")
            self.assertEqual(art_runs_res.status_code, 200)
            art_runs = art_runs_res.json()["runs"]
            art_by_id = {r["run_id"]: r for r in art_runs}
            self.assertIn("qwen3.5-bench-direct", art_by_id)
            self.assertIn("qwen3.5-bench-proxy", art_by_id)
            for rid in ("qwen3.5-bench-direct", "qwen3.5-bench-proxy"):
                r_obj = art_by_id[rid]
                self.assertTrue(r_obj["has_metrics"])
                self.assertTrue(r_obj["has_records_jsonl"])
                self.assertEqual(r_obj["model"], "Qwen/Qwen3.5-9B")
                self.assertEqual(r_obj["concurrency"], 2)
                metric_tags = {m["tag"] for m in r_obj["metrics"]}
                self.assertIn("time_to_first_token", metric_tags)
                self.assertIn("inter_token_latency", metric_tags)
                self.assertIn("request_latency", metric_tags)
                self.assertIn("output_token_throughput", metric_tags)

            rec_res = client.get("/api/artifact-runs/records", params={"run_id": "qwen3.5-bench-direct"})
            self.assertEqual(rec_res.status_code, 200)
            rec_payload = rec_res.json()
            self.assertTrue(rec_payload["available"])
            self.assertGreaterEqual(rec_payload["total_records"], 4)
            self.assertIn("request_latency", rec_payload["records"][0])

            hist_zip_res = client.get("/api/artifact-runs/zip", params={"run_id": "qwen3.5-bench-direct"})
            self.assertEqual(hist_zip_res.status_code, 200)
            self.assertEqual(hist_zip_res.headers["content-type"], "application/zip")

            # 5. Verify CLI mode
            cli_out = self.root / "cli_out"
            rc = asyncio.run(
                run_cli_mode(
                    raw_command=f'{cmd} --output-artifact-dir "{cli_out}"',
                    auth_manager=auth_mgr,
                )
            )
            self.assertEqual(rc, 0)
            self.assertTrue((cli_out / "profile_export_aiperf.json").is_file())


    def test_hf_token_is_exported_as_env_var_to_worker(self) -> None:
        from unittest.mock import patch

        auth_mgr = GoogleAuthManager(
            auth_uri=self.oauth_server.auth_uri,
            token_uri=self.oauth_server.token_uri,
            userinfo_uri=self.oauth_server.userinfo_uri,
        )
        _, state = auth_mgr.start_oauth_flow(redirect_uri="http://localhost:8080/")
        self.oauth_server.expected_code_challenge = None
        auth_mgr.complete_oauth_flow(state=state, code="4/code")

        captured_env: dict[str, str] = {}
        orig_exec = asyncio.create_subprocess_exec

        async def spy_exec(*args: object, **kwargs: object):
            env = kwargs.get("env")
            if isinstance(env, dict):
                captured_env.update(env)
            return await orig_exec(*args, **kwargs)  # type: ignore[arg-type]

        mgr = RunManager(base_runs_dir=self.root / "hf_runs", auth_manager=auth_mgr)
        with patch("vertex_aiperf.runner.asyncio.create_subprocess_exec", side_effect=spy_exec):
            with TestClient(create_app(mgr)) as client:
                res = client.post(
                    "/api/runs",
                    json={
                        "command": "aiperf plugins",
                        "hf_token": "hf_unit_test_secret_token_abc",
                    },
                )
                self.assertEqual(res.status_code, 200)
                run_id = res.json()["run_id"]
                deadline = time.monotonic() + 15.0
                while time.monotonic() < deadline:
                    j = client.get(f"/api/runs/{run_id}").json()["job"]
                    if j["status"] in ("succeeded", "failed"):
                        break
                    time.sleep(0.1)

        self.assertEqual(captured_env.get("HF_TOKEN"), "hf_unit_test_secret_token_abc")


class TestArtifactResultsDiscovery(unittest.TestCase):
    """Tests discovery of incomplete folders, CSV fallback, nested sweeps, and path traversal."""

    def test_incomplete_folder_csv_fallback_nested_sweep_and_security(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            base = Path(tmpdir)
            # 1. Incomplete log-only directory (like an interrupted run)
            (base / "incomplete_run" / "logs").mkdir(parents=True)
            (base / "incomplete_run" / "logs" / "aiperf.log").write_text("started\n", encoding="utf-8")

            # 2. CSV-only run directory
            csv_dir = base / "csv_only_run"
            csv_dir.mkdir()
            (csv_dir / "profile_export_aiperf.csv").write_text(
                "Metric,avg,min,max,p99,p90,p50,std\n"
                "Time to First Token (ms),12.50,8.10,20.00,19.80,16.40,11.90,2.10\n"
                "Inter Token Latency (ms),4.20,3.80,5.10,5.05,4.80,4.15,0.35\n"
                "\n"
                "Metric,Value\n"
                "Output Token Throughput (tokens/sec),412.75\n",
                encoding="utf-8",
            )

            # 3. Nested sweep variation directory
            sweep_var = base / "conc_sweep" / "concurrency_10"
            sweep_var.mkdir(parents=True)
            (sweep_var / "profile_export_aiperf.json").write_text(
                json.dumps(
                    {
                        "schema_version": "1.4",
                        "time_to_first_token": {"unit": "ms", "avg": 25.4, "p50": 24.0, "p90": 31.2, "p99": 38.0},
                        "output_token_throughput": {"unit": "tokens/sec", "avg": 820.5},
                    }
                ),
                encoding="utf-8",
            )

            mgr = RunManager(
                base_runs_dir=base,
                auth_manager=GoogleAuthManager(persist_session=False),
            )
            with TestClient(create_app(mgr)) as client:
                res = client.get("/api/artifact-runs")
                self.assertEqual(res.status_code, 200)
                runs = {r["run_id"]: r for r in res.json()["runs"]}

                self.assertIn("incomplete_run", runs)
                self.assertFalse(runs["incomplete_run"]["has_metrics"])

                self.assertIn("csv_only_run", runs)
                self.assertTrue(runs["csv_only_run"]["has_metrics"])
                csv_tags = {m["tag"]: m for m in runs["csv_only_run"]["metrics"]}
                self.assertIn("time_to_first_token", csv_tags)
                self.assertAlmostEqual(csv_tags["time_to_first_token"]["stats"]["p99"], 19.8)
                self.assertEqual(csv_tags["time_to_first_token"]["larger_is_better"], False)
                self.assertEqual(csv_tags["output_token_throughput"]["larger_is_better"], True)

                self.assertIn("conc_sweep/concurrency_10", runs)
                self.assertTrue(runs["conc_sweep/concurrency_10"]["has_metrics"])

                # Path traversal must be rejected with 404
                trav_rec = client.get("/api/artifact-runs/records", params={"run_id": "../../etc"})
                self.assertEqual(trav_rec.status_code, 404)
                trav_zip = client.get("/api/artifact-runs/zip", params={"run_id": "../outside"})
                self.assertEqual(trav_zip.status_code, 404)


if __name__ == "__main__":
    unittest.main()
