"""Discovery, parsing, and normalization of past AIPerf benchmark runs in `artifacts/`."""

from __future__ import annotations

import csv
import datetime as dt
import functools
import json
import math
import re
from pathlib import Path
from typing import Any

try:
    import orjson
except ImportError:  # pragma: no cover
    orjson = None  # type: ignore[assignment]

STAT_FIELDS = (
    "avg",
    "min",
    "max",
    "p1",
    "p5",
    "p10",
    "p25",
    "p50",
    "p75",
    "p90",
    "p95",
    "p99",
    "std",
    "count",
    "sum",
)

PERCENTILE_FIELDS = ("p1", "p5", "p10", "p25", "p50", "p75", "p90", "p95", "p99")

# Canonical display priority so primary LLM serving metrics appear first
PRIORITY_METRIC_ORDER: dict[str, int] = {
    "time_to_first_token": 10,
    "time_to_first_output_token": 12,
    "time_to_second_token": 14,
    "inter_token_latency": 20,
    "decode_duration": 25,
    "request_latency": 30,
    "output_token_throughput": 40,
    "output_token_throughput_per_user": 45,
    "e2e_output_token_throughput": 48,
    "input_token_throughput": 50,
    "total_token_throughput": 52,
    "request_throughput": 55,
    "goodput": 58,
    "input_sequence_length": 65,
    "output_sequence_length": 68,
    "reasoning_token_count": 70,
    "total_isl": 75,
    "total_osl": 76,
    "total_output_tokens": 77,
    "request_count": 85,
    "completed_request_count": 86,
    "error_request_count": 90,
    "request_error_rate": 92,
    "benchmark_duration": 95,
}

INTERNAL_HIDDEN_TAGS = frozenset(
    {
        "min_request_timestamp",
        "max_response_timestamp",
        "skipped_context_overflow_count",
    }
)

SECRET_RE = re.compile(
    r"(--api-key(?:\s+|=)\S+|Bearer\s+\S+)",
    re.IGNORECASE,
)


def _loads_bytes(raw: bytes) -> Any:
    if orjson is not None:
        return orjson.loads(raw)
    return json.loads(raw.decode("utf-8"))


def _clean_number(val: Any) -> float | int | None:
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, float):
        return val if math.isfinite(val) else None
    try:
        parsed = float(str(val).strip())
        return parsed if math.isfinite(parsed) else None
    except (ValueError, TypeError):
        return None


@functools.lru_cache(maxsize=1)
def _load_metric_registry_metadata() -> dict[str, dict[str, Any]]:
    """Extract official human labels and polarity flags from AIPerf's MetricRegistry."""
    meta: dict[str, dict[str, Any]] = {}
    try:
        from aiperf.common.enums import MetricFlags
        from aiperf.metrics.metric_registry import MetricRegistry

        for cls in MetricRegistry.all_classes():
            tag = getattr(cls, "tag", None)
            if not tag:
                continue
            header = getattr(cls, "header", None) or _humanize_tag(str(tag))
            flags = getattr(cls, "flags", None)
            is_internal = bool(flags and (flags & MetricFlags.INTERNAL))
            larger_is_better: bool | None = None
            if flags and (flags & MetricFlags.LARGER_IS_BETTER):
                larger_is_better = True
            meta[str(tag)] = {
                "label": str(header),
                "larger_is_better": larger_is_better,
                "internal": is_internal,
            }
    except Exception:
        pass
    return meta


def _humanize_tag(tag: str) -> str:
    acronyms = {"isl": "ISL", "osl": "OSL", "ttft": "TTFT", "itl": "ITL", "e2e": "E2E", "http": "HTTP", "gpu": "GPU", "rtt": "RTT"}
    parts = tag.replace("-", "_").split("_")
    return " ".join(acronyms.get(p.lower(), p.capitalize()) for p in parts if p)


def _classify_metric(tag: str, unit: str, reg_polarity: bool | None) -> tuple[str, bool | None]:
    """Return (category, larger_is_better) for a metric."""
    u = (unit or "").strip().lower()
    t = tag.lower()

    if "throughput" in t or "goodput" in t or "/sec" in u or "/s" in u or "per_watt" in t:
        return "throughput", True

    if (
        "latency" in t
        or "time_to_" in t
        or "duration" in t
        or t.startswith("http_req_")
        or u in {"ms", "ns", "us", "s", "sec", "seconds", "milliseconds"}
    ):
        # Benchmark duration is informational rather than a latency target, though shorter for fixed work is faster
        polarity = None if t == "benchmark_duration" else False
        return "latency", polarity

    if "token" in u or "sequence_length" in t or t in {"total_isl", "total_osl"}:
        # Sequence lengths are workload characteristics (neutral polarity)
        return "tokens", None

    if "error" in t or "mismatch" in t or "discrepancy" in t or "overflow" in t:
        return "requests", False

    return "requests", reg_polarity


def _scrub_cli_command(cmd: str | None) -> str | None:
    if not cmd:
        return None
    return SECRET_RE.sub("<redacted>", cmd)


def _extract_input_config_summary(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract model, concurrency, endpoint type, streaming, and dataset from JsonExportData."""
    info: dict[str, Any] = {
        "model": None,
        "models": [],
        "endpoint_type": None,
        "streaming": None,
        "concurrency": None,
        "request_rate": None,
        "num_conversations": None,
        "dataset": None,
        "cli_command": None,
    }

    run_info = payload.get("run_info")
    if isinstance(run_info, dict):
        info["cli_command"] = _scrub_cli_command(run_info.get("cli_command"))

    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        ds_prov = metadata.get("dataset")
        if isinstance(ds_prov, dict) and ds_prov.get("name"):
            info["dataset"] = str(ds_prov["name"])
        elif isinstance(ds_prov, str):
            info["dataset"] = ds_prov

    input_cfg = payload.get("input_config")
    if not isinstance(input_cfg, dict):
        return info

    # AIPerf BenchmarkConfig nests under `benchmark` in newer schemas or flat fields in older ones
    bench = input_cfg.get("benchmark") if isinstance(input_cfg.get("benchmark"), dict) else input_cfg

    # Models
    models_block = bench.get("models")
    if isinstance(models_block, dict) and isinstance(models_block.get("items"), list):
        names = [
            str(m["name"])
            for m in models_block["items"]
            if isinstance(m, dict) and m.get("name")
        ]
        info["models"] = names
        if names:
            info["model"] = names[0]
    elif isinstance(bench.get("model_names"), list) and bench["model_names"]:
        info["models"] = [str(x) for x in bench["model_names"]]
        info["model"] = info["models"][0]

    # Endpoint
    ep = bench.get("endpoint")
    if isinstance(ep, dict):
        if ep.get("type") is not None:
            info["endpoint_type"] = str(ep["type"])
        if ep.get("streaming") is not None:
            info["streaming"] = bool(ep["streaming"])

    # Phases (concurrency / request_rate / sessions)
    phases = bench.get("phases")
    if isinstance(phases, list):
        for ph in phases:
            if not isinstance(ph, dict):
                continue
            if ph.get("name") == "profiling" or len(phases) == 1:
                if ph.get("concurrency") is not None:
                    info["concurrency"] = ph["concurrency"]
                if ph.get("request_rate") is not None:
                    info["request_rate"] = ph["request_rate"]
                if ph.get("sessions") is not None:
                    info["num_conversations"] = ph["sessions"]
                break

    # Datasets fallback
    if not info["dataset"]:
        datasets = bench.get("datasets")
        if isinstance(datasets, list) and datasets:
            ds0 = datasets[0]
            if isinstance(ds0, dict):
                info["dataset"] = str(
                    ds0.get("dataset") or ds0.get("name") or ds0.get("type") or ""
                ) or None

    return info


def _parse_json_export(json_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Parse `profile_export_aiperf.json` into normalized metric dicts and run metadata."""
    payload = _loads_bytes(json_path.read_bytes())
    if not isinstance(payload, dict):
        raise ValueError("Export JSON root must be an object.")

    registry_meta = _load_metric_registry_metadata()
    metrics: list[dict[str, Any]] = []

    for key, raw_val in payload.items():
        if key in INTERNAL_HIDDEN_TAGS or key == "warmup_metrics":
            continue
        if not isinstance(raw_val, dict) or "unit" not in raw_val:
            continue

        reg = registry_meta.get(key, {})
        if reg.get("internal"):
            continue

        unit = str(raw_val.get("unit") or "")
        label = reg.get("label") or _humanize_tag(key)
        category, larger_is_better = _classify_metric(
            key, unit, reg.get("larger_is_better")
        )

        stats: dict[str, float | int | None] = {}
        for sf in STAT_FIELDS:
            stats[sf] = _clean_number(raw_val.get(sf))

        if all(stats[sf] is None for sf in STAT_FIELDS):
            continue

        has_percentiles = any(stats[pf] is not None for pf in PERCENTILE_FIELDS)
        metrics.append(
            {
                "tag": key,
                "label": label,
                "unit": unit,
                "category": category,
                "larger_is_better": larger_is_better,
                "has_percentiles": has_percentiles,
                "priority": PRIORITY_METRIC_ORDER.get(key, 500),
                "stats": stats,
            }
        )

    metrics.sort(key=lambda m: (m["priority"], m["label"]))

    cfg_info = _extract_input_config_summary(payload)
    start_time = payload.get("start_time")
    end_time = payload.get("end_time")

    duration_sec: float | None = None
    bench_dur = payload.get("benchmark_duration")
    if isinstance(bench_dur, dict) and _clean_number(bench_dur.get("avg")) is not None:
        dur_val = float(bench_dur["avg"])
        dur_unit = str(bench_dur.get("unit") or "sec").lower()
        if dur_unit in ("ms", "milliseconds"):
            duration_sec = dur_val / 1000.0
        elif dur_unit in ("ns", "nanoseconds"):
            duration_sec = dur_val / 1e9
        else:
            duration_sec = dur_val

    meta = {
        **cfg_info,
        "schema_version": payload.get("schema_version"),
        "aiperf_version": payload.get("aiperf_version"),
        "start_time": str(start_time) if start_time else None,
        "end_time": str(end_time) if end_time else None,
        "duration_sec": duration_sec,
        "is_complete": payload.get("is_complete", True),
        "was_cancelled": bool(payload.get("was_cancelled", False)),
        "incomplete_reason": payload.get("incomplete_reason"),
    }
    return metrics, meta


def _slugify_metric_header(header_with_unit: str) -> tuple[str, str, str]:
    """Extract (tag, clean_label, unit) from a CSV metric name like 'Time to First Token (ms)'."""
    m = re.match(r"^(.*?)\s*\(([^()]+)\)\s*$", header_with_unit.strip())
    if m:
        label = m.group(1).strip()
        unit = m.group(2).strip()
    else:
        label = header_with_unit.strip()
        unit = "count"
    tag = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return tag, label, unit


def _parse_csv_export(csv_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fallback parser if only `profile_export_aiperf.csv` is present in an artifact folder."""
    text = csv_path.read_text(encoding="utf-8", errors="replace")
    reader = csv.reader(text.splitlines())
    metrics: list[dict[str, Any]] = []
    current_headers: list[str] | None = None

    for row in reader:
        if not row or all(not c.strip() for c in row):
            current_headers = None
            continue
        if row[0].strip() == "Metric":
            current_headers = [c.strip().lower() for c in row]
            continue
        if current_headers is None:
            continue

        raw_name = row[0].strip()
        if not raw_name:
            continue
        tag, label, unit = _slugify_metric_header(raw_name)
        stats: dict[str, float | int | None] = {sf: None for sf in STAT_FIELDS}

        if len(current_headers) == 2 and current_headers[1] == "value" and len(row) >= 2:
            stats["avg"] = _clean_number(row[1])
        else:
            for idx in range(1, min(len(current_headers), len(row))):
                col_key = current_headers[idx]
                if col_key in stats:
                    stats[col_key] = _clean_number(row[idx])

        if all(stats[sf] is None for sf in STAT_FIELDS):
            continue

        category, larger_is_better = _classify_metric(tag, unit, None)
        has_percentiles = any(stats[pf] is not None for pf in PERCENTILE_FIELDS)
        metrics.append(
            {
                "tag": tag,
                "label": label,
                "unit": unit,
                "category": category,
                "larger_is_better": larger_is_better,
                "has_percentiles": has_percentiles,
                "priority": PRIORITY_METRIC_ORDER.get(tag, 500),
                "stats": stats,
            }
        )

    metrics.sort(key=lambda m: (m["priority"], m["label"]))
    return metrics, {"is_complete": True, "was_cancelled": False}


def _discover_run_directories(base_dir: Path) -> list[tuple[str, Path]]:
    """Find run directories inside `base_dir` (direct children + 1-level nested sweep variations)."""
    if not base_dir.is_dir():
        return []

    resolved_base = base_dir.resolve()
    candidates: list[tuple[str, Path]] = []

    for child in sorted(base_dir.iterdir()):
        if child.name.startswith(".") or child.is_symlink() or not child.is_dir():
            continue
        resolved_child = child.resolve()
        if not resolved_child.is_relative_to(resolved_base):
            continue

        has_direct_export = (
            (resolved_child / "profile_export_aiperf.json").is_file()
            or (resolved_child / "profile_export_aiperf.csv").is_file()
        )
        if has_direct_export:
            candidates.append((child.name, resolved_child))
            continue

        # Check 1-level nested sweep sub-runs (e.g. artifacts/<sweep>/<variation>/profile_export_aiperf.json)
        nested_found = False
        for sub in sorted(resolved_child.iterdir()):
            if sub.name.startswith(".") or sub.is_symlink() or not sub.is_dir():
                continue
            resolved_sub = sub.resolve()
            if not resolved_sub.is_relative_to(resolved_base):
                continue
            if (
                (resolved_sub / "profile_export_aiperf.json").is_file()
                or (resolved_sub / "profile_export_aiperf.csv").is_file()
            ):
                candidates.append((f"{child.name}/{sub.name}", resolved_sub))
                nested_found = True

        if not nested_found:
            # Include incomplete/log-only direct run folder so user sees it clearly in UI
            candidates.append((child.name, resolved_child))

    return candidates


def _inspect_incomplete_log(run_dir: Path) -> dict[str, Any]:
    """Extract cancellation/error reason and model hint from `logs/aiperf.log` when exports are absent."""
    log_path = run_dir / "logs" / "aiperf.log"
    if not log_path.is_file() or log_path.is_symlink():
        return {
            "was_cancelled": False,
            "incomplete_reason": "No profile_export_aiperf.json or .csv found in folder.",
        }

    try:
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-16384:]
    except OSError:
        return {"was_cancelled": False, "incomplete_reason": "Unable to read logs/aiperf.log."}

    was_cancelled = (
        "Graceful shutdown requested" in tail
        or "profile_cancel" in tail
        or "Signal 2 received" in tail
    )
    last_error: str | None = None
    model_hint: str | None = None
    for line in tail.splitlines():
        if " - ERROR - " in line:
            last_error = line.split(" - ERROR - ", 1)[1].strip()
        if not model_hint and "huggingface.co/api/models/" in line:
            m = re.search(r"huggingface\.co/api/models/([^/\s?\"']+/[A-Za-z0-9._-]+)", line)
            if m:
                model_hint = m.group(1)

    if was_cancelled and last_error:
        reason = f"Cancelled before completion ({last_error})"
    elif was_cancelled:
        reason = "Cancelled before benchmark completed — no metrics exported."
    elif last_error:
        reason = last_error
    else:
        reason = "Run did not finish exporting metrics (profile_export_aiperf.json missing)."

    return {
        "was_cancelled": was_cancelled,
        "incomplete_reason": reason,
        "model": model_hint,
    }


def list_artifact_runs(base_runs_dir: Path) -> list[dict[str, Any]]:
    """Scan `base_runs_dir` and return normalized run summaries + metrics sorted newest-first."""
    discovered = _discover_run_directories(base_runs_dir)
    runs: list[dict[str, Any]] = []

    for run_id, run_dir in discovered:
        json_file = run_dir / "profile_export_aiperf.json"
        csv_file = run_dir / "profile_export_aiperf.csv"
        jsonl_file = run_dir / "profile_export.jsonl"

        stat_info = run_dir.stat()
        mtime_iso = dt.datetime.fromtimestamp(
            stat_info.st_mtime, tz=dt.timezone.utc
        ).isoformat()

        file_count = sum(
            1
            for p in run_dir.rglob("*")
            if p.is_file() and not p.is_symlink()
        )

        metrics: list[dict[str, Any]] = []
        meta: dict[str, Any] = {}
        parse_error: str | None = None

        if json_file.is_file() and not json_file.is_symlink():
            try:
                metrics, meta = _parse_json_export(json_file)
            except Exception as exc:
                parse_error = f"Failed to parse JSON export: {exc}"
        elif csv_file.is_file() and not csv_file.is_symlink():
            try:
                metrics, meta = _parse_csv_export(csv_file)
            except Exception as exc:
                parse_error = f"Failed to parse CSV export: {exc}"
        else:
            meta = _inspect_incomplete_log(run_dir)

        backend_meta: dict[str, Any] | None = None
        geap_meta_file = run_dir / "geap_run_metadata.json"
        if geap_meta_file.is_file() and not geap_meta_file.is_symlink():
            try:
                geap_obj = _loads_bytes(geap_meta_file.read_bytes())
                if isinstance(geap_obj, dict) and isinstance(geap_obj.get("backend"), dict):
                    backend_meta = geap_obj["backend"]
            except Exception:
                pass

        timestamp = meta.get("start_time") or mtime_iso
        # Normalize naive ISO timestamps for consistent sorting
        sort_ts = mtime_iso
        if meta.get("start_time"):
            try:
                parsed_dt = dt.datetime.fromisoformat(str(meta["start_time"]))
                if parsed_dt.tzinfo is None:
                    parsed_dt = parsed_dt.replace(tzinfo=dt.timezone.utc)
                sort_ts = parsed_dt.astimezone(dt.timezone.utc).isoformat()
            except ValueError:
                pass

        runs.append(
            {
                "run_id": run_id,
                "run_name": run_id,
                "has_metrics": len(metrics) > 0,
                "has_records_jsonl": jsonl_file.is_file() and not jsonl_file.is_symlink(),
                "timestamp": timestamp,
                "_sort_ts": sort_ts,
                "mtime_iso": mtime_iso,
                "file_count": file_count,
                "parse_error": parse_error,
                "model": meta.get("model"),
                "models": meta.get("models") or [],
                "backend": backend_meta,
                "endpoint_type": meta.get("endpoint_type"),
                "streaming": meta.get("streaming"),
                "concurrency": meta.get("concurrency"),
                "request_rate": meta.get("request_rate"),
                "num_conversations": meta.get("num_conversations"),
                "dataset": meta.get("dataset"),
                "cli_command": meta.get("cli_command"),
                "duration_sec": meta.get("duration_sec"),
                "aiperf_version": meta.get("aiperf_version"),
                "is_complete": meta.get("is_complete", len(metrics) > 0),
                "was_cancelled": meta.get("was_cancelled", False),
                "incomplete_reason": meta.get("incomplete_reason"),
                "metrics": metrics,
            }
        )

    runs.sort(key=lambda r: (r["has_metrics"], r["_sort_ts"], r["run_id"]), reverse=True)
    for r in runs:
        r.pop("_sort_ts", None)
    return runs


def resolve_artifact_run_dir(base_runs_dir: Path, run_id: str) -> Path:
    """Safely resolve a run directory inside `base_runs_dir`, preventing path traversal."""
    clean_rel = (run_id or "").strip().strip("/")
    if not clean_rel or ".." in clean_rel.split("/"):
        raise FileNotFoundError("Invalid run identifier.")

    resolved_base = base_runs_dir.resolve()
    candidate = (resolved_base / clean_rel).resolve()
    if (
        candidate == resolved_base
        or not candidate.is_relative_to(resolved_base)
        or not candidate.is_dir()
    ):
        raise FileNotFoundError(f"Artifact run '{run_id}' not found.")

    # Reject if any path component inside base_runs_dir is a symlink
    cur = resolved_base
    for part in Path(clean_rel).parts:
        cur = cur / part
        if cur.is_symlink():
            raise FileNotFoundError("Symlinked run directories are not permitted.")
    return candidate


def load_run_request_records(
    base_runs_dir: Path,
    run_id: str,
    *,
    max_records: int = 1500,
) -> dict[str, Any]:
    """Load per-request metric samples from `profile_export.jsonl` for single-run distributions."""
    run_dir = resolve_artifact_run_dir(base_runs_dir, run_id)
    jsonl_path = run_dir / "profile_export.jsonl"
    if not jsonl_path.is_file() or jsonl_path.is_symlink():
        return {"run_id": run_id, "available": False, "records": [], "total_records": 0}

    raw_records: list[dict[str, Any]] = []
    total_count = 0
    units: dict[str, str] = {}

    watched_tags = (
        "time_to_first_token",
        "time_to_first_output_token",
        "inter_token_latency",
        "request_latency",
        "decode_duration",
        "output_token_throughput_per_user",
        "input_sequence_length",
        "output_sequence_length",
    )

    with jsonl_path.open("rb") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line:
                continue
            try:
                obj = _loads_bytes(line)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue

            total_count += 1
            metrics_dict = obj.get("metrics")
            if not isinstance(metrics_dict, dict):
                continue

            entry: dict[str, Any] = {
                "idx": total_count,
                "error": bool(obj.get("error")),
            }
            has_val = False
            for tag in watched_tags:
                m_obj = metrics_dict.get(tag)
                if isinstance(m_obj, dict):
                    val = _clean_number(m_obj.get("value"))
                    if val is not None:
                        entry[tag] = val
                        has_val = True
                        if tag not in units and m_obj.get("unit"):
                            units[tag] = str(m_obj["unit"])

            if has_val:
                raw_records.append(entry)

    # Evenly subsample if a run has tens of thousands of records so browser SVG stays snappy
    if len(raw_records) > max_records:
        step = len(raw_records) / max_records
        sampled = [raw_records[int(i * step)] for i in range(max_records)]
    else:
        sampled = raw_records

    return {
        "run_id": run_id,
        "available": len(sampled) > 0,
        "total_records": total_count,
        "sampled_records": len(sampled),
        "units": units,
        "records": sampled,
    }
