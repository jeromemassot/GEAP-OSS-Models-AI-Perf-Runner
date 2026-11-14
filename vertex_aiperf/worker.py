"""Subprocess entrypoint that injects Google OAuth2 credentials in-memory.

Invoked as:
    python -u -m vertex_aiperf.worker <aiperf_subcommand> [args...]

Pops VERTEX_AIPERF_BEARER_TOKEN and VERTEX_AIPERF_QUOTA_PROJECT from os.environ
immediately so secrets never appear in `/proc/<pid>/cmdline` (`ps aux`) and
never leak to child processes.
"""

from __future__ import annotations

import os
import sys

ENV_BEARER_TOKEN = "VERTEX_AIPERF_BEARER_TOKEN"
ENV_QUOTA_PROJECT = "VERTEX_AIPERF_QUOTA_PROJECT"


def _run_profile_with_injected_auth(
    tokens: list[str],
    bearer_token: str | None,
    quota_project: str | None,
) -> None:
    """Resolve AIPerf profile config and attach Bearer token + quota header directly."""
    from aiperf.cli import app as aiperf_app
    from aiperf.cli_runner import run_benchmark
    from aiperf.cli_utils import exit_on_error
    from aiperf.config.flags.resolver import resolve_config
    from aiperf.config.loader import build_benchmark_plan
    from aiperf.config.loader.errors import ConfigurationError

    _cmd, bound, _ignored = aiperf_app.parse_args(tokens)
    cli_config = bound.kwargs["cli_config"]

    with exit_on_error(title="Error Running AIPerf System", show_traceback=False):
        config = resolve_config(cli_config, cli_config.config_file)
        if bearer_token:
            config.benchmark.endpoint.api_key = bearer_token
        if quota_project:
            config.benchmark.endpoint.headers["X-Goog-User-Project"] = str(
                quota_project
            )
        plan = build_benchmark_plan(config)

    with exit_on_error(
        title="Error Running AIPerf System",
        quiet_for=(ConfigurationError,),
    ):
        run_benchmark(plan)


def main() -> None:
    bearer_token = os.environ.pop(ENV_BEARER_TOKEN, None)
    quota_project = os.environ.pop(ENV_QUOTA_PROJECT, None)
    tokens = list(sys.argv[1:])
    if not tokens:
        print("Error: No AIPerf arguments supplied to worker.", file=sys.stderr)
        sys.exit(2)

    if tokens[0] == "profile" and not any(t in ("-h", "--help") for t in tokens[1:]):
        _run_profile_with_injected_auth(tokens, bearer_token, quota_project)
        return

    from aiperf.cli import app as aiperf_app

    if bearer_token:
        candidate = [*tokens, "--api-key", bearer_token]
        try:
            aiperf_app.parse_args(candidate, exit_on_error=False)
            tokens = candidate
        except Exception:
            pass

    aiperf_app(tokens)


if __name__ == "__main__":
    main()
