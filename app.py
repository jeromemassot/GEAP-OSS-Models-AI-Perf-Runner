#!/usr/bin/env python3
"""Entry point for the GEAP AIPerf Runner (Google Account OAuth 2.0).

Examples:
    # Start the lightweight web UI (default: http://localhost:8080)
    .venv/bin/python app.py

    # Run in terminal CLI mode with interactive Google Account OAuth sign-in
    .venv/bin/python app.py --cli \\
        --cmd 'aiperf profile --model Qwen/Qwen3.5-9B --url "https://..." --streaming'
"""

from __future__ import annotations

import argparse
import asyncio
import sys

import uvicorn

from vertex_aiperf.auth import GoogleAuthError
from vertex_aiperf.command_parser import CommandParseError
from vertex_aiperf.runner import run_cli_mode
from vertex_aiperf.server import create_app


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run NVIDIA AIPerf against Vertex AI Endpoints authenticated with Google Account OAuth 2.0."
    )
    parser.add_argument(
        "--host",
        default="localhost",
        help="Host interface for the web UI (default: localhost).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="Port for the web UI (default: 8080).",
    )
    parser.add_argument(
        "--cli",
        action="store_true",
        help="Run directly in terminal CLI mode instead of starting the web server.",
    )
    parser.add_argument(
        "--cmd",
        "--command",
        dest="command",
        help="Full aiperf CLI command string to execute (required with --cli).",
    )
    parser.add_argument(
        "--run-name",
        help="Optional name for the benchmark run and its artifact directory.",
    )
    parser.add_argument(
        "--hf-token",
        help="Optional HuggingFace token exported as HF_TOKEN before running AIPerf.",
    )
    parser.add_argument(
        "--quota-project",
        help="Optional GCP project ID/number for the X-Goog-User-Project header.",
    )
    parser.add_argument(
        "--auth-mode",
        choices=("direct", "proxy"),
        default="direct",
        help="Authentication mode: 'direct' (zero-hop Bearer injection) or 'proxy' (auto-refreshing loopback proxy for >55m runs).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if args.cli or args.command:
        if not args.command:
            parser.error("--cli requires --cmd '<aiperf command>'.")
        try:
            return asyncio.run(
                run_cli_mode(
                    raw_command=args.command,
                    run_name=args.run_name,
                    hf_token=args.hf_token,
                    quota_project=args.quota_project,
                    auth_mode=args.auth_mode,
                )
            )
        except (GoogleAuthError, CommandParseError) as exc:
            print(f"[vertex-aiperf] Error: {exc}", file=sys.stderr)
            return 2

    web_app = create_app()
    display_host = "localhost" if args.host in ("127.0.0.1", "localhost") else args.host
    bind_host = "127.0.0.1" if args.host == "localhost" else args.host
    print(f"Starting GEAP AIPerf Runner at http://{display_host}:{args.port}")
    uvicorn.run(web_app, host=bind_host, port=args.port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
