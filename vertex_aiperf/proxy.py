"""Local loopback HTTP/SSE reverse proxy with automatic Google OAuth2 token refresh.

Used when 'proxy' auth mode is enabled so multi-hour AIPerf benchmarks
seamlessly renew the 60-minute Google Identity OAuth2 access token without
interrupting in-flight or subsequent requests.
"""

from __future__ import annotations

import asyncio
from urllib.parse import urlsplit, urlunsplit

import aiohttp
from aiohttp import web

from vertex_aiperf.auth import GoogleIdentityTokenProvider

HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
)


class VertexAuthProxy:
    """Async loopback proxy that injects fresh Google Identity OAuth2 Bearer tokens."""

    def __init__(
        self, token_provider: GoogleIdentityTokenProvider, target_urls: list[str]
    ) -> None:
        if not target_urls:
            raise ValueError("At least one target URL is required for VertexAuthProxy.")
        self._token_provider = token_provider
        self._target_urls = target_urls
        self._upstreams: dict[str, tuple[str, str]] = {}
        for idx, raw_url in enumerate(target_urls):
            normalized = raw_url if "://" in raw_url else f"https://{raw_url}"
            split = urlsplit(normalized)
            self._upstreams[f"u{idx}"] = (split.scheme, split.netloc)

        self._session: aiohttp.ClientSession | None = None
        self._runner: web.AppRunner | None = None
        self._port: int | None = None

    @property
    def port(self) -> int:
        if self._port is None:
            raise RuntimeError("Proxy has not been started yet.")
        return self._port

    def build_url_mapping(self) -> dict[str, str]:
        """Map each original target URL to its local 127.0.0.1 proxy URL.

        Preserves the exact upstream path (e.g. `/v1/projects/.../v1/chat/completions`)
        under `/u<idx>/...` so AIPerf's URL path overlap deduplication works identically.
        """
        mapping: dict[str, str] = {}
        for idx, raw_url in enumerate(target_urls := self._target_urls):
            normalized = raw_url if "://" in raw_url else f"https://{raw_url}"
            split = urlsplit(normalized)
            proxied_path = f"/u{idx}{split.path}"
            local_url = urlunsplit(
                ("http", f"127.0.0.1:{self.port}", proxied_path, split.query, split.fragment)
            )
            mapping[raw_url] = local_url
            mapping[normalized] = local_url
        _ = target_urls
        return mapping

    async def start(self) -> None:
        connector = aiohttp.TCPConnector(limit=0, ttl_dns_cache=300)
        timeout = aiohttp.ClientTimeout(
            total=None, connect=30, sock_connect=30, sock_read=None
        )
        self._session = aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            auto_decompress=False,
            trust_env=True,
        )

        app = web.Application(client_max_size=256 * 1024 * 1024)
        app.router.add_route("*", "/{route_id:u[0-9]+}{tail:.*}", self._handle_proxy)

        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        sockets = site._server.sockets if site._server else []
        if not sockets:
            raise RuntimeError("Failed to bind local auth proxy socket.")
        self._port = int(sockets[0].getsockname()[1])

    async def stop(self) -> None:
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        if self._session is not None:
            await self._session.close()
            self._session = None
        self._port = None

    async def _handle_proxy(self, request: web.Request) -> web.StreamResponse:
        assert self._session is not None
        route_id = request.match_info["route_id"]
        upstream = self._upstreams.get(route_id)
        if upstream is None:
            return web.json_response({"error": f"Unknown proxy route {route_id}"}, status=404)

        scheme, netloc = upstream
        tail = request.match_info.get("tail", "")
        if not tail.startswith("/"):
            tail = "/" + tail
        upstream_url = urlunsplit((scheme, netloc, tail, request.query_string, ""))

        token, _ = await asyncio.to_thread(self._token_provider.get_access_token)

        out_headers: dict[str, str] = {}
        for k, v in request.headers.items():
            k_low = k.lower()
            if k_low not in HOP_BY_HOP_HEADERS and k_low != "authorization":
                out_headers[k] = v
        out_headers["Authorization"] = f"Bearer {token}"
        if self._token_provider.quota_project and not any(
            k.lower() == "x-goog-user-project" for k in out_headers
        ):
            out_headers["X-Goog-User-Project"] = self._token_provider.quota_project

        body = await request.read()

        async with self._session.request(
            method=request.method,
            url=upstream_url,
            headers=out_headers,
            data=body if body else None,
            allow_redirects=False,
        ) as upstream_resp:
            resp_headers = {
                k: v
                for k, v in upstream_resp.headers.items()
                if k.lower() not in HOP_BY_HOP_HEADERS
            }
            stream_resp = web.StreamResponse(
                status=upstream_resp.status,
                reason=upstream_resp.reason,
                headers=resp_headers,
            )
            await stream_resp.prepare(request)
            async for chunk in upstream_resp.content.iter_any():
                if chunk:
                    await stream_resp.write(chunk)
            await stream_resp.write_eof()
            return stream_resp
