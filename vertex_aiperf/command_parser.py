"""Parsing, sanitization, Vertex AI URL inspection, and AIPerf validation."""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

VERTEX_PATH_RE = re.compile(
    r"/projects/(?P<project>[^/]+)/locations/(?P<location>[^/]+)/endpoints/(?P<endpoint_id>[^/]+)"
)
SHELL_OPERATORS = frozenset({";", "&&", "||", "|", ">", ">>", "<", "2>&1", "&"})
SMART_QUOTES_TRANSLATION = str.maketrans(
    {
        "\u201c": '"',
        "\u201d": '"',
        "\u2018": "'",
        "\u2019": "'",
    }
)


class CommandParseError(ValueError):
    """Raised when the entered AIPerf CLI command is invalid."""


@dataclass
class VertexEndpointMetadata:
    """Extracted details when a URL targets Google Cloud Vertex AI."""

    url: str
    is_vertex_ai: bool
    host: str
    project: str | None = None
    location: str | None = None
    endpoint_id: str | None = None
    is_dedicated_dns: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "is_vertex_ai": self.is_vertex_ai,
            "host": self.host,
            "project": self.project,
            "location": self.location,
            "endpoint_id": self.endpoint_id,
            "is_dedicated_dns": self.is_dedicated_dns,
        }


@dataclass
class ParsedAIPerfCommand:
    """Structured representation of a validated AIPerf CLI command."""

    subcommand: str
    tokens: list[str]
    normalized_display: str
    notes: list[str] = field(default_factory=list)
    models: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    vertex_endpoints: list[VertexEndpointMetadata] = field(default_factory=list)
    endpoint_type: str | None = None
    streaming: bool = False
    concurrency: str | None = None
    num_conversations: str | None = None
    dataset_summary: str | None = None
    artifact_dir: str | None = None
    has_explicit_artifact_dir: bool = False
    has_explicit_stats_interval: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "subcommand": self.subcommand,
            "tokens": self.tokens,
            "normalized_display": self.normalized_display,
            "notes": self.notes,
            "models": self.models,
            "urls": self.urls,
            "vertex_endpoints": [ve.to_dict() for ve in self.vertex_endpoints],
            "endpoint_type": self.endpoint_type,
            "streaming": self.streaming,
            "concurrency": self.concurrency,
            "num_conversations": self.num_conversations,
            "dataset_summary": self.dataset_summary,
            "artifact_dir": self.artifact_dir,
            "has_explicit_artifact_dir": self.has_explicit_artifact_dir,
            "has_explicit_stats_interval": self.has_explicit_stats_interval,
        }


def inspect_vertex_url(url: str) -> VertexEndpointMetadata:
    """Inspect an endpoint URL and extract Vertex AI metadata if present."""
    candidate = url if "://" in url else f"http://{url}"
    parsed = urlparse(candidate)
    host = (parsed.hostname or "").lower()
    is_vertex_host = (
        host.endswith(".prediction.vertexai.goog")
        or host.endswith("-aiplatform.googleapis.com")
        or host == "aiplatform.googleapis.com"
    )
    match = VERTEX_PATH_RE.search(parsed.path or "")
    project = match.group("project") if match else None
    location = match.group("location") if match else None
    endpoint_id = match.group("endpoint_id") if match else None
    return VertexEndpointMetadata(
        url=url,
        is_vertex_ai=bool(is_vertex_host or match),
        host=host,
        project=project,
        location=location,
        endpoint_id=endpoint_id,
        is_dedicated_dns=host.endswith(".prediction.vertexai.goog"),
    )


def _preprocess_command_text(raw_command: str) -> tuple[str, list[str]]:
    """Normalize multi-line shell continuations, prompts, and stray trailing quotes."""
    notes: list[str] = []
    text = (raw_command or "").strip()
    if not text:
        raise CommandParseError("AIPerf CLI command cannot be empty.")

    if any(ch in text for ch in ("\u201c", "\u201d", "\u2018", "\u2019")):
        text = text.translate(SMART_QUOTES_TRANSLATION)
        notes.append("Normalized typographic curly quotes to standard ASCII quotes.")

    # Collapse shell line continuations (`\` before newline) and newlines
    text = re.sub(r"\\\r?\n", " ", text)
    text = re.sub(r"[\r\n]+", " ", text).strip()

    # Strip common shell prompt prefix ($ aiperf ... or > aiperf ...)
    if text.startswith("$ "):
        text = text[2:].strip()
        notes.append("Removed leading '$ ' shell prompt prefix.")

    return text, notes


def _tokenize_with_quote_recovery(text: str, notes: list[str]) -> list[str]:
    """Tokenize command via shlex, recovering cleanly from a single stray trailing quote."""
    try:
        return shlex.split(text, posix=True)
    except ValueError as exc:
        if "No closing quotation" in str(exc) and text and text[-1] in ('"', "'"):
            trimmed = text[:-1].rstrip()
            try:
                tokens = shlex.split(trimmed, posix=True)
                notes.append(
                    f"Removed unmatched trailing {text[-1]} quote at the end of the command."
                )
                return tokens
            except ValueError:
                pass
        raise CommandParseError(f"Command quoting error: {exc}") from exc


def _strip_executable_prefix(tokens: list[str], notes: list[str]) -> list[str]:
    """Strip leading python/aiperf executable tokens, leaving [subcommand, ...args]."""
    if not tokens:
        raise CommandParseError("AIPerf CLI command cannot be empty.")

    idx = 0
    first_base = os.path.basename(tokens[0])

    # Handle `python -m aiperf ...` or `.venv/bin/python -m aiperf ...`
    if first_base.startswith("python") and len(tokens) >= 3 and tokens[1] == "-m":
        mod = tokens[2]
        if mod in ("aiperf", "aiperf.cli"):
            idx = 3
        else:
            raise CommandParseError(
                f"Expected an 'aiperf' command, got module '{mod}'."
            )
    elif first_base in ("aiperf", "aiperf.exe"):
        idx = 1
    elif tokens[0].startswith("-"):
        # User pasted flags directly without `aiperf profile`
        notes.append("Prepended default 'profile' subcommand.")
        return ["profile", *tokens]

    remaining = tokens[idx:]
    if not remaining:
        raise CommandParseError(
            "Missing AIPerf subcommand and arguments (e.g., 'aiperf profile --model ...')."
        )

    if remaining[0].startswith("-"):
        notes.append("Prepended default 'profile' subcommand.")
        remaining = ["profile", *remaining]

    return remaining


def _strip_conflicting_auth_flags(tokens: list[str], notes: list[str]) -> list[str]:
    """Remove existing --api-key or Authorization headers so Google OAuth2 auth wins."""
    cleaned: list[str] = []
    i = 0
    removed_api_key = False
    removed_auth_header = False

    while i < len(tokens):
        tok = tokens[i]
        if tok == "--api-key":
            removed_api_key = True
            i += 2  # skip flag + value
            continue
        if tok.startswith("--api-key="):
            removed_api_key = True
            i += 1
            continue
        if tok in ("--header", "-H") and i + 1 < len(tokens):
            hdr_val = tokens[i + 1]
            if hdr_val.lstrip().lower().startswith("authorization:") or (
                '"authorization"' in hdr_val.lower()
            ):
                removed_auth_header = True
                i += 2
                continue
        if (tok.startswith("--header=") or tok.startswith("-H=")) and (
            "authorization" in tok.split("=", 1)[1].lower()
        ):
            removed_auth_header = True
            i += 1
            continue

        cleaned.append(tok)
        i += 1

    if removed_api_key:
        notes.append(
            "Removed existing --api-key flag; Google Identity OAuth2 token will be used instead."
        )
    if removed_auth_header:
        notes.append(
            "Removed existing Authorization header; Google Identity OAuth2 token will be used instead."
        )
    return cleaned


def parse_and_validate_aiperf_command(
    raw_command: str,
    *,
    validate_with_aiperf: bool = True,
) -> ParsedAIPerfCommand:
    """Parse, sanitize, and validate an AIPerf CLI command string."""
    preprocessed, notes = _preprocess_command_text(raw_command)
    raw_tokens = _tokenize_with_quote_recovery(preprocessed, notes)

    for tok in raw_tokens:
        if tok in SHELL_OPERATORS:
            raise CommandParseError(
                f"Shell operator '{tok}' is not allowed. Enter only a single aiperf CLI command."
            )

    tokens = _strip_executable_prefix(raw_tokens, notes)
    tokens = _strip_conflicting_auth_flags(tokens, notes)

    subcommand = tokens[0]
    has_explicit_artifact_dir = any(
        t in ("--output-artifact-dir", "--artifact-dir")
        or t.startswith("--output-artifact-dir=")
        or t.startswith("--artifact-dir=")
        for t in tokens[1:]
    )
    has_explicit_stats_interval = any(
        t == "--stats-interval" or t.startswith("--stats-interval=")
        for t in tokens[1:]
    )

    normalized_display = "aiperf " + " ".join(shlex.quote(t) for t in tokens)

    result = ParsedAIPerfCommand(
        subcommand=subcommand,
        tokens=tokens,
        normalized_display=normalized_display,
        notes=notes,
        has_explicit_artifact_dir=has_explicit_artifact_dir,
        has_explicit_stats_interval=has_explicit_stats_interval,
    )

    if not validate_with_aiperf:
        return result

    try:
        from aiperf.cli import app as aiperf_app

        _cmd, bound, _ignored = aiperf_app.parse_args(tokens, exit_on_error=False)
    except SystemExit as exc:
        raise CommandParseError(f"AIPerf rejected command arguments (exit {exc.code}).") from exc
    except Exception as exc:
        raise CommandParseError(f"Invalid AIPerf CLI arguments: {exc}") from exc

    cli_cfg = bound.kwargs.get("cli_config") if bound and bound.kwargs else None
    if subcommand == "profile" and cli_cfg is not None:
        try:
            from aiperf.config.flags.resolver import resolve_config
            from aiperf.config.loader import build_benchmark_plan

            resolved = resolve_config(cli_cfg, cli_cfg.config_file)
            build_benchmark_plan(resolved)
        except Exception as exc:
            raise CommandParseError(f"AIPerf configuration error: {exc}") from exc

        bench = resolved.benchmark
        result.models = [m.name for m in bench.models.items]
        result.urls = list(bench.endpoint.urls)
        result.vertex_endpoints = [inspect_vertex_url(u) for u in result.urls]
        result.endpoint_type = str(bench.endpoint.type.value if hasattr(bench.endpoint.type, "value") else bench.endpoint.type)
        result.streaming = bool(bench.endpoint.streaming)
        result.artifact_dir = str(Path(bench.artifacts.dir).resolve())

        conv_cli = getattr(cli_cfg, "conversation_num", None)
        if conv_cli is not None:
            result.num_conversations = str(conv_cli)

        # Extract profiling concurrency / rate / sessions summary
        for phase in bench.phases:
            if getattr(phase, "name", "") == "profiling" or len(bench.phases) == 1:
                conc = getattr(phase, "concurrency", None)
                rate = getattr(phase, "request_rate", None)
                sessions = getattr(phase, "sessions", None)
                if conc is not None:
                    result.concurrency = str(conc)
                elif rate is not None:
                    result.concurrency = f"{rate} req/s"
                if result.num_conversations is None and sessions is not None:
                    result.num_conversations = str(sessions)
                break

        if bench.datasets:
            ds = bench.datasets[0]
            ds_type = getattr(ds, "type", None)
            ds_type_val = ds_type.value if hasattr(ds_type, "value") else str(ds_type)
            if hasattr(ds, "dataset") and ds.dataset is not None:
                pub_name = ds.dataset.value if hasattr(ds.dataset, "value") else str(ds.dataset)
                result.dataset_summary = pub_name
            elif hasattr(ds, "file") and ds.file is not None:
                result.dataset_summary = f"{ds_type_val}: {ds.file}"
            else:
                result.dataset_summary = ds_type_val
    elif cli_cfg is not None:
        urls = getattr(cli_cfg, "urls", None) or getattr(cli_cfg, "url", None)
        if isinstance(urls, str):
            result.urls = [urls]
        elif isinstance(urls, (list, tuple)):
            result.urls = list(urls)
        result.vertex_endpoints = [inspect_vertex_url(u) for u in result.urls]
        models = getattr(cli_cfg, "model_names", None) or getattr(cli_cfg, "model", None)
        if isinstance(models, str):
            result.models = [models]
        elif isinstance(models, (list, tuple)):
            result.models = list(models)

    return result


def rewrite_urls_in_tokens(tokens: list[str], url_mapping: dict[str, str]) -> list[str]:
    """Replace --url / -u values according to url_mapping (used in local proxy mode)."""
    rewritten: list[str] = []
    i = 0
    replaced_any = False
    while i < len(tokens):
        tok = tokens[i]
        if tok in ("--url", "-u") and i + 1 < len(tokens):
            orig = tokens[i + 1]
            norm = orig if "://" in orig else f"http://{orig}"
            new_url = url_mapping.get(orig) or url_mapping.get(norm) or orig
            rewritten.extend([tok, new_url])
            replaced_any = True
            i += 2
            continue
        if tok.startswith("--url=") or tok.startswith("-u="):
            flag, orig = tok.split("=", 1)
            norm = orig if "://" in orig else f"http://{orig}"
            new_url = url_mapping.get(orig) or url_mapping.get(norm) or orig
            rewritten.append(f"{flag}={new_url}")
            replaced_any = True
            i += 1
            continue
        rewritten.append(tok)
        i += 1

    if not replaced_any and len(url_mapping) == 1:
        only_proxy_url = next(iter(url_mapping.values()))
        rewritten.extend(["--url", only_proxy_url])
    return rewritten
