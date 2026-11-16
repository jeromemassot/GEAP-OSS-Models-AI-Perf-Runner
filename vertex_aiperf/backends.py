"""Catalog of Vertex AI / GCE accelerator backends and their hardware characteristics."""

from __future__ import annotations

import re
from enum import Enum
from typing import Any

import requests as http_requests


class AcceleratorFamily(str, Enum):
    GPU = "GPU"
    TPU = "TPU"


class AcceleratorType(str, Enum):
    NVIDIA_TESLA_A100 = "NVIDIA_TESLA_A100"
    NVIDIA_A100_80GB = "NVIDIA_A100_80GB"
    NVIDIA_H100_80GB = "NVIDIA_H100_80GB"
    NVIDIA_H200_141GB = "NVIDIA_H200_141GB"
    NVIDIA_B200 = "NVIDIA_B200"
    NVIDIA_GB200 = "NVIDIA_GB200"
    NVIDIA_L4 = "NVIDIA_L4"
    NVIDIA_RTX_PRO_6000 = "NVIDIA_RTX_PRO_6000"


BACKEND_CATALOG: dict[str, dict[str, Any]] = {
    # Nvidia GPUs - A2 Series (NVIDIA A100 40GB / 80GB)
    "a2-highgpu-1g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-40GB",
        "accelerator_type": AcceleratorType.NVIDIA_TESLA_A100.value,
        "accelerator_count": 1,
        "vram_gb": 40,
        "hourly_cost_usd": 3.67,
        "memory_bandwidth_gb_s": 1555,
        "description": "High-bandwidth A100 GPU for low latency inference",
    },
    "a2-highgpu-2g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-40GB (2x)",
        "accelerator_type": AcceleratorType.NVIDIA_TESLA_A100.value,
        "accelerator_count": 2,
        "vram_gb": 80,
        "hourly_cost_usd": 7.34,
        "memory_bandwidth_gb_s": 3110,
        "description": "Dual A100 (40GB) GPUs for distributed inference",
    },
    "a2-highgpu-4g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-40GB (4x)",
        "accelerator_type": AcceleratorType.NVIDIA_TESLA_A100.value,
        "accelerator_count": 4,
        "vram_gb": 160,
        "hourly_cost_usd": 14.68,
        "memory_bandwidth_gb_s": 6220,
        "description": "Quad A100 (40GB) GPUs for multi-GPU inference",
    },
    "a2-highgpu-8g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-40GB (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_TESLA_A100.value,
        "accelerator_count": 8,
        "vram_gb": 320,
        "hourly_cost_usd": 29.36,
        "memory_bandwidth_gb_s": 12440,
        "description": "8x A100 (40GB) GPUs for large model serving",
    },
    "a2-megagpu-16g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-40GB (16x)",
        "accelerator_type": AcceleratorType.NVIDIA_TESLA_A100.value,
        "accelerator_count": 16,
        "vram_gb": 640,
        "hourly_cost_usd": 58.72,
        "memory_bandwidth_gb_s": 24880,
        "description": "16x A100 (40GB) GPUs for ultra-large model serving",
    },
    "a2-ultragpu-1g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-80GB",
        "accelerator_type": AcceleratorType.NVIDIA_A100_80GB.value,
        "accelerator_count": 1,
        "vram_gb": 80,
        "hourly_cost_usd": 4.50,
        "memory_bandwidth_gb_s": 2039,
        "description": "Large memory A100 GPU for 30B-70B models",
    },
    "a2-ultragpu-2g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-80GB (2x)",
        "accelerator_type": AcceleratorType.NVIDIA_A100_80GB.value,
        "accelerator_count": 2,
        "vram_gb": 160,
        "hourly_cost_usd": 9.00,
        "memory_bandwidth_gb_s": 4078,
        "description": "Dual A100 (80GB) GPUs for large models with low latency",
    },
    "a2-ultragpu-4g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-80GB (4x)",
        "accelerator_type": AcceleratorType.NVIDIA_A100_80GB.value,
        "accelerator_count": 4,
        "vram_gb": 320,
        "hourly_cost_usd": 18.00,
        "memory_bandwidth_gb_s": 8156,
        "description": "Quad A100 (80GB) GPUs for 70B+ model inference",
    },
    "a2-ultragpu-8g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia A100-80GB (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_A100_80GB.value,
        "accelerator_count": 8,
        "vram_gb": 640,
        "hourly_cost_usd": 36.00,
        "memory_bandwidth_gb_s": 16312,
        "description": "8x A100 (80GB) GPU cluster for high-throughput 70B+ model serving",
    },
    # Nvidia GPUs - A3 Series (NVIDIA H100 / H200)
    "a3-highgpu-1g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia H100-80GB",
        "accelerator_type": AcceleratorType.NVIDIA_H100_80GB.value,
        "accelerator_count": 1,
        "vram_gb": 80,
        "hourly_cost_usd": 3.75,
        "memory_bandwidth_gb_s": 3350,
        "description": "Single H100 SXM5 GPU for high-performance LLM serving",
    },
    "a3-highgpu-2g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia H100-80GB (2x)",
        "accelerator_type": AcceleratorType.NVIDIA_H100_80GB.value,
        "accelerator_count": 2,
        "vram_gb": 160,
        "hourly_cost_usd": 7.50,
        "memory_bandwidth_gb_s": 6700,
        "description": "Dual H100 GPU configuration for low-latency medium models",
    },
    "a3-highgpu-4g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia H100-80GB (4x)",
        "accelerator_type": AcceleratorType.NVIDIA_H100_80GB.value,
        "accelerator_count": 4,
        "vram_gb": 320,
        "hourly_cost_usd": 15.00,
        "memory_bandwidth_gb_s": 13400,
        "description": "Quad H100 GPUs for multi-GPU inference up to 70B models",
    },
    "a3-highgpu-8g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia H100-80GB (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_H100_80GB.value,
        "accelerator_count": 8,
        "vram_gb": 640,
        "hourly_cost_usd": 30.00,
        "memory_bandwidth_gb_s": 26800,
        "description": "Ultra-performance 8x H100 cluster for massive concurrency",
    },
    "a3-edgegpu-8g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia H100-80GB (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_H100_80GB.value,
        "accelerator_count": 8,
        "vram_gb": 640,
        "hourly_cost_usd": 30.00,
        "memory_bandwidth_gb_s": 26800,
        "description": "Edge-optimized 8x H100 cluster for massive concurrency",
    },
    "a3-ultragpu-8g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia H200-141GB (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_H200_141GB.value,
        "accelerator_count": 8,
        "vram_gb": 1128,
        "hourly_cost_usd": 35.00,
        "memory_bandwidth_gb_s": 38400,
        "description": "Ultra-performance 8x H200 (141GB) cluster for massive models and high concurrency",
    },
    # Nvidia GPUs - A4 Series (NVIDIA B200)
    "a4-highgpu-8g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia B200 (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_B200.value,
        "accelerator_count": 8,
        "vram_gb": 1440,
        "hourly_cost_usd": 40.00,
        "memory_bandwidth_gb_s": 64000,
        "description": "Next-gen 8x NVIDIA B200 Blackwell GPU cluster for frontier models",
    },
    # Nvidia GPUs - A4X Series (NVIDIA GB200)
    "a4x-highgpu-4g": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia GB200 (4x)",
        "accelerator_type": AcceleratorType.NVIDIA_GB200.value,
        "accelerator_count": 4,
        "vram_gb": 768,
        "hourly_cost_usd": 30.00,
        "memory_bandwidth_gb_s": 32000,
        "description": "Quad NVIDIA GB200 Grace Blackwell superchip node for ultra-high throughput",
    },
    # Nvidia GPUs - G2 Series (NVIDIA L4)
    "g2-standard-4": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 1,
        "vram_gb": 24,
        "hourly_cost_usd": 0.70,
        "memory_bandwidth_gb_s": 300,
        "description": "Entry-level single L4 GPU for small models (up to 7B FP8/INT4)",
    },
    "g2-standard-8": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 1,
        "vram_gb": 24,
        "hourly_cost_usd": 0.85,
        "memory_bandwidth_gb_s": 300,
        "description": "Cost-effective GPU for small models (up to 7B-9B FP8/INT4)",
    },
    "g2-standard-12": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 1,
        "vram_gb": 24,
        "hourly_cost_usd": 1.05,
        "memory_bandwidth_gb_s": 300,
        "description": "Single L4 GPU with 12 vCPUs for low-latency small models",
    },
    "g2-standard-16": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 1,
        "vram_gb": 24,
        "hourly_cost_usd": 1.25,
        "memory_bandwidth_gb_s": 300,
        "description": "Single L4 GPU with 16 vCPUs for medium memory CPU workloads",
    },
    "g2-standard-24": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4 (2x)",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 2,
        "vram_gb": 48,
        "hourly_cost_usd": 1.70,
        "memory_bandwidth_gb_s": 600,
        "description": "Dual L4 GPU setup for models up to 13B-15B FP8",
    },
    "g2-standard-32": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 1,
        "vram_gb": 24,
        "hourly_cost_usd": 1.75,
        "memory_bandwidth_gb_s": 300,
        "description": "Single L4 GPU with 32 vCPUs for CPU-intensive pre/post-processing",
    },
    "g2-standard-48": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4 (4x)",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 4,
        "vram_gb": 96,
        "hourly_cost_usd": 3.40,
        "memory_bandwidth_gb_s": 1200,
        "description": "Multi-GPU L4 setup for medium models (up to 30B FP8)",
    },
    "g2-standard-96": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia L4 (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_L4.value,
        "accelerator_count": 8,
        "vram_gb": 192,
        "hourly_cost_usd": 6.80,
        "memory_bandwidth_gb_s": 2400,
        "description": "8x L4 GPU configuration for models up to 70B FP8",
    },
    # Nvidia GPUs - G4 Series (NVIDIA RTX PRO 6000)
    "g4-standard-48": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia RTX PRO 6000",
        "accelerator_type": AcceleratorType.NVIDIA_RTX_PRO_6000.value,
        "accelerator_count": 1,
        "vram_gb": 48,
        "hourly_cost_usd": 1.30,
        "memory_bandwidth_gb_s": 850,
        "description": "RTX PRO 6000 GPU for medium models (up to 30B FP8) and high-throughput inference",
    },
    "g4-standard-96": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia RTX PRO 6000 (2x)",
        "accelerator_type": AcceleratorType.NVIDIA_RTX_PRO_6000.value,
        "accelerator_count": 2,
        "vram_gb": 96,
        "hourly_cost_usd": 2.60,
        "memory_bandwidth_gb_s": 1700,
        "description": "Nvidia RTX PRO 6000 Blackwell GPU for high-throughput LLM inference",
    },
    "g4-standard-192": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia RTX PRO 6000 (4x)",
        "accelerator_type": AcceleratorType.NVIDIA_RTX_PRO_6000.value,
        "accelerator_count": 4,
        "vram_gb": 192,
        "hourly_cost_usd": 10.40,
        "memory_bandwidth_gb_s": 6800,
        "description": "Quad RTX PRO 6000 GPUs for multi-GPU inference and large context windows",
    },
    "g4-standard-384": {
        "family": AcceleratorFamily.GPU,
        "chip_name": "Nvidia RTX PRO 6000 (8x)",
        "accelerator_type": AcceleratorType.NVIDIA_RTX_PRO_6000.value,
        "accelerator_count": 8,
        "vram_gb": 384,
        "hourly_cost_usd": 20.80,
        "memory_bandwidth_gb_s": 13600,
        "description": "8x RTX PRO 6000 GPU cluster for massive multi-GPU model serving",
    },
}


def _series_group_for_machine(machine_type: str) -> str:
    prefix = machine_type.split("-", 1)[0].lower()
    groups = {
        "a2": "A2 Series — NVIDIA A100 (40GB / 80GB)",
        "a3": "A3 Series — NVIDIA H100 / H200",
        "a4": "A4 Series — NVIDIA B200",
        "a4x": "A4X Series — NVIDIA GB200",
        "g2": "G2 Series — NVIDIA L4",
        "g4": "G4 Series — NVIDIA RTX PRO 6000",
    }
    return groups.get(prefix, f"{prefix.upper()} Series")


_DYNAMIC_DETECTED_BACKENDS: dict[str, dict[str, Any]] = {}

_SAFE_PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_LOCATION_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_SAFE_ENDPOINT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_PLACEHOLDER_TOKENS = frozenset(
    {
        "your-project-number",
        "your-project-id",
        "your-endpoint-id",
        "project-id",
        "endpoint-id",
        "project-num",
    }
)


def is_placeholder_vertex_target(
    project: str | None, location: str | None, endpoint_id: str | None
) -> bool:
    for val in (project, location, endpoint_id):
        if not val:
            return True
        low = val.strip().lower().strip("[]<>")
        if low in _PLACEHOLDER_TOKENS or low.startswith("your-") or low.startswith("your_"):
            return True
    return False


def get_backend_info(backend_id: str | None) -> dict[str, Any] | None:
    """Return a JSON-serializable backend spec dictionary for `backend_id`, or None."""
    if not backend_id:
        return None
    clean_id = backend_id.strip()
    if not clean_id:
        return None
    raw = BACKEND_CATALOG.get(clean_id)
    if raw is None:
        if clean_id in _DYNAMIC_DETECTED_BACKENDS:
            return dict(_DYNAMIC_DETECTED_BACKENDS[clean_id])
        raise ValueError(f"Unknown backend '{clean_id}'.")
    family = raw["family"].value if isinstance(raw["family"], Enum) else str(raw["family"])
    return {
        "id": clean_id,
        "series": _series_group_for_machine(clean_id),
        "family": family,
        "chip_name": str(raw["chip_name"]),
        "accelerator_type": str(raw["accelerator_type"]),
        "accelerator_count": int(raw["accelerator_count"]),
        "vram_gb": int(raw["vram_gb"]),
        "hourly_cost_usd": float(raw["hourly_cost_usd"]),
        "memory_bandwidth_gb_s": int(raw["memory_bandwidth_gb_s"]),
        "description": str(raw["description"]),
    }


def list_backends() -> list[dict[str, Any]]:
    """Return all configured backends in catalog order."""
    result: list[dict[str, Any]] = []
    for key in BACKEND_CATALOG:
        info = get_backend_info(key)
        if info is not None:
            result.append(info)
    return result


def _vertex_get_json(
    url: str, access_token: str, quota_project: str | None
) -> tuple[int, dict[str, Any] | None, str | None]:
    """Perform an authenticated GET against Vertex AI, retrying without quota project on 403."""
    headers = {"Authorization": f"Bearer {access_token}"}
    if quota_project:
        headers["X-Goog-User-Project"] = quota_project

    try:
        resp = http_requests.get(url, headers=headers, timeout=8)
        if resp.status_code == 403 and quota_project and "USER_PROJECT_DENIED" in resp.text:
            headers.pop("X-Goog-User-Project", None)
            resp = http_requests.get(url, headers=headers, timeout=8)
    except Exception as exc:
        return 0, None, f"Could not reach Vertex AI API: {exc}"

    if not resp.ok:
        err_msg = f"HTTP {resp.status_code}"
        try:
            err_json = resp.json()
            if isinstance(err_json, dict) and isinstance(err_json.get("error"), dict):
                api_msg = err_json["error"].get("message")
                if api_msg:
                    err_msg = f"HTTP {resp.status_code}: {api_msg}"
        except Exception:
            pass
        return resp.status_code, None, err_msg

    try:
        payload = resp.json()
        if isinstance(payload, dict):
            return resp.status_code, payload, None
        return resp.status_code, None, "Unexpected non-object JSON from Vertex AI API."
    except Exception as exc:
        return resp.status_code, None, f"Invalid JSON from Vertex AI API: {exc}"


def _pick_primary_deployed_model(endpoint_payload: dict[str, Any]) -> dict[str, Any] | None:
    deployed = endpoint_payload.get("deployedModels")
    if not isinstance(deployed, list) or not deployed:
        return None

    traffic_split = endpoint_payload.get("trafficSplit")
    if isinstance(traffic_split, dict) and traffic_split:
        best_id = max(
            traffic_split.items(),
            key=lambda kv: float(kv[1]) if isinstance(kv[1], (int, float)) else 0.0,
        )[0]
        for dm in deployed:
            if isinstance(dm, dict) and str(dm.get("id")) == str(best_id):
                return dm

    first = deployed[0]
    return first if isinstance(first, dict) else None


def detect_vertex_endpoint_backend(
    *,
    project: str,
    location: str,
    endpoint_id: str,
    access_token: str,
    api_base_url: str | None = None,
) -> dict[str, Any]:
    """Query Vertex AI `endpoints.get` to auto-detect the backend machine type & replica specs."""
    clean_proj = (project or "").strip()
    clean_loc = (location or "").strip().lower()
    clean_ep = (endpoint_id or "").strip()

    if is_placeholder_vertex_target(clean_proj, clean_loc, clean_ep):
        return {
            "detected": False,
            "reason": "Replace placeholder project/endpoint IDs in --url to auto-detect backend, or select one manually.",
        }

    if (
        not _SAFE_PROJECT_RE.match(clean_proj)
        or not _SAFE_LOCATION_RE.match(clean_loc)
        or not _SAFE_ENDPOINT_RE.match(clean_ep)
    ):
        return {
            "detected": False,
            "reason": "Invalid Vertex AI project, location, or endpoint identifier format.",
        }

    if api_base_url:
        base = api_base_url.rstrip("/")
    elif clean_loc == "global":
        base = "https://aiplatform.googleapis.com"
    else:
        base = f"https://{clean_loc}-aiplatform.googleapis.com"

    ep_url = f"{base}/v1/projects/{clean_proj}/locations/{clean_loc}/endpoints/{clean_ep}"
    _status, ep_data, err = _vertex_get_json(ep_url, access_token, clean_proj)
    if ep_data is None:
        return {
            "detected": False,
            "reason": f"Unable to fetch Vertex AI endpoint metadata ({err}). Select a backend manually below.",
        }

    dm = _pick_primary_deployed_model(ep_data)
    if dm is None:
        return {
            "detected": False,
            "reason": "Vertex AI endpoint has no deployedModels. Select a backend manually below.",
        }

    dedicated = dm.get("dedicatedResources")
    if not isinstance(dedicated, dict) and isinstance(dm.get("sharedResources"), str):
        pool_path = dm["sharedResources"].lstrip("/")
        pool_url = f"{base}/v1/{pool_path}"
        _p_status, pool_data, _p_err = _vertex_get_json(pool_url, access_token, clean_proj)
        if isinstance(pool_data, dict):
            dedicated = pool_data.get("dedicatedResources")

    if not isinstance(dedicated, dict):
        return {
            "detected": False,
            "reason": "Endpoint uses serverless/automatic resources without a dedicated machineType. Select a backend manually if applicable.",
        }

    machine_spec = dedicated.get("machineSpec")
    if not isinstance(machine_spec, dict) or not machine_spec.get("machineType"):
        return {
            "detected": False,
            "reason": "No machineSpec.machineType reported on the deployed model. Select a backend manually below.",
        }

    machine_type = str(machine_spec["machineType"]).strip()
    accel_type = str(machine_spec.get("acceleratorType") or "").strip() or "CPU_OR_UNSPECIFIED"
    raw_count = machine_spec.get("acceleratorCount")
    accel_count = int(raw_count) if isinstance(raw_count, (int, float)) else 0
    tpu_topo = machine_spec.get("tpuTopology")

    min_replicas = dedicated.get("minReplicaCount")
    max_replicas = dedicated.get("maxReplicaCount")

    if machine_type in BACKEND_CATALOG:
        backend_info = get_backend_info(machine_type)
        in_catalog = True
    else:
        is_tpu = "TPU" in accel_type.upper() or bool(tpu_topo) or machine_type.startswith("ct")
        family = AcceleratorFamily.TPU.value if is_tpu else AcceleratorFamily.GPU.value
        chip_label = accel_type if accel_type != "CPU_OR_UNSPECIFIED" else machine_type
        if accel_count > 1:
            chip_label = f"{chip_label} ({accel_count}x)"
        backend_info = {
            "id": machine_type,
            "series": "Detected from Vertex AI Endpoint",
            "family": family,
            "chip_name": chip_label,
            "accelerator_type": accel_type,
            "accelerator_count": accel_count,
            "vram_gb": None,
            "hourly_cost_usd": None,
            "memory_bandwidth_gb_s": None,
            "description": "Detected live from Vertex AI Endpoint machineSpec (outside predefined catalog).",
        }
        _DYNAMIC_DETECTED_BACKENDS[machine_type] = backend_info
        in_catalog = False

    return {
        "detected": True,
        "in_catalog": in_catalog,
        "backend_id": machine_type,
        "backend": backend_info,
        "endpoint_display_name": ep_data.get("displayName"),
        "deployed_model_display_name": dm.get("displayName"),
        "min_replica_count": int(min_replicas) if isinstance(min_replicas, int) else None,
        "max_replica_count": int(max_replicas) if isinstance(max_replicas, int) else None,
    }
