"use strict";

const EXAMPLE_VERTEX_COMMAND = [
  "aiperf profile",
  "  --model Qwen/Qwen3.5-9B",
  "  --use-server-token-count",
  "  --random-seed 42",
  '  --url "https://YOUR-ENDPOINT-ID.us-central1-YOUR-PROJECT-NUMBER.prediction.vertexai.goog/v1/projects/YOUR-PROJECT-NUMBER/locations/us-central1/endpoints/YOUR-ENDPOINT-ID/invoke/v1/chat/completions"',
  "  --endpoint-type chat",
  "  --public-dataset exgentic_v2",
  "  --dataset-filter benchmark=swebench",
  "  --dataset-filter harness=tool_calling",
  "  --concurrency 5",
  "  --num-conversations 100",
  "  --streaming",
].join(" \\\n");

const RUN_SERIES_PALETTE = [
  "#1168C6", // Royal Blue
  "#0D8A5E", // Emerald Teal
  "#D97706", // Warm Amber
  "#D6334C", // Coral Crimson
  "#0891B2", // Deep Cyan
  "#4F6D7A", // Slate Steel
  "#B45309", // Copper Ochre
  "#15803D", // Forest Green
];

const PERCENTILE_STEPS = [
  { key: "p10", label: "p10", pos: 10 },
  { key: "p25", label: "p25", pos: 25 },
  { key: "p50", label: "p50", pos: 50 },
  { key: "p75", label: "p75", pos: 75 },
  { key: "p90", label: "p90", pos: 90 },
  { key: "p95", label: "p95", pos: 95 },
  { key: "p99", label: "p99", pos: 99 },
];

const els = {
  googleSigninBtn: document.getElementById("google-signin-btn"),
  googleSigninLabel: document.getElementById("google-signin-label"),
  verifyTokenBtn: document.getElementById("verify-token-btn"),
  verifyTokenLabel: document.getElementById("verify-token-label"),
  tokenValidityCaption: document.getElementById("token-validity-caption"),

  tabBtnConfig: document.getElementById("tab-btn-config"),
  tabBtnOutput: document.getElementById("tab-btn-output"),
  tabBtnResults: document.getElementById("tab-btn-results"),
  pastRunsCountBadge: document.getElementById("past-runs-count-badge"),
  tabPanelConfig: document.getElementById("tab-panel-config"),
  tabPanelOutput: document.getElementById("tab-panel-output"),
  tabPanelResults: document.getElementById("tab-panel-results"),

  cmdInput: document.getElementById("aiperf-cmd-input"),
  loadExampleBtn: document.getElementById("load-example-btn"),
  clearCmdBtn: document.getElementById("clear-cmd-btn"),
  cmdValidationBar: document.getElementById("cmd-validation-bar"),
  cmdMetaTags: document.getElementById("cmd-meta-tags"),
  cmdNotesList: document.getElementById("cmd-notes-list"),

  backendSelect: document.getElementById("backend-select"),
  detectBackendBtn: document.getElementById("detect-backend-btn"),
  clearBackendBtn: document.getElementById("clear-backend-btn"),
  backendDetectStatus: document.getElementById("backend-detect-status"),
  backendSpecsCard: document.getElementById("backend-specs-card"),

  runNameInput: document.getElementById("run-name-input"),
  hfTokenInput: document.getElementById("hf-token-input"),
  toggleHfTokenBtn: document.getElementById("toggle-hf-token-btn"),

  authModeDirect: document.getElementById("auth-mode-direct"),
  authModeProxy: document.getElementById("auth-mode-proxy"),
  copyCliBtn: document.getElementById("copy-cli-btn"),
  startRunBtn: document.getElementById("start-run-btn"),
  stopRunBtn: document.getElementById("stop-run-btn"),
  stopRunOutputBtn: document.getElementById("stop-run-output-btn"),
  errorBanner: document.getElementById("run-error-banner"),

  statusBadge: document.getElementById("run-status-badge"),
  runIdLabel: document.getElementById("run-id-label"),
  elapsedLabel: document.getElementById("run-elapsed-label"),
  autoscrollToggle: document.getElementById("autoscroll-toggle"),
  copyLogsBtn: document.getElementById("copy-logs-btn"),
  terminalOutput: document.getElementById("terminal-output"),

  resultsPanel: document.getElementById("results-panel"),
  artifactDirDisplay: document.getElementById("artifact-dir-display"),
  downloadZipBtn: document.getElementById("download-zip-btn"),
  artifactLinksContainer: document.getElementById("artifact-links-container"),

  historyPanel: document.getElementById("history-panel"),
  historyList: document.getElementById("history-list"),

  artifactsFolderCaption: document.getElementById("artifacts-folder-caption"),
  pastRunsSearchInput: document.getElementById("past-runs-search-input"),
  selectLatestRunBtn: document.getElementById("select-latest-run-btn"),
  selectAllRunsBtn: document.getElementById("select-all-runs-btn"),
  clearRunsSelectionBtn: document.getElementById("clear-runs-selection-btn"),
  refreshPastRunsBtn: document.getElementById("refresh-past-runs-btn"),
  pastRunsSelectorList: document.getElementById("past-runs-selector-list"),
  pastRunsIncompleteNote: document.getElementById("past-runs-incomplete-note"),

  resultsEmptyState: document.getElementById("results-empty-state"),
  resultsEmptyTitle: document.getElementById("results-empty-title"),
  resultsEmptySubtitle: document.getElementById("results-empty-subtitle"),
  resultsAnalysisWorkspace: document.getElementById("results-analysis-workspace"),
  analysisModeBadge: document.getElementById("analysis-mode-badge"),
  analysisSelectionSummary: document.getElementById("analysis-selection-summary"),
  comparisonStatSelect: document.getElementById("comparison-stat-select"),
  baselineControlWrapper: document.getElementById("baseline-control-wrapper"),
  baselineRunSelect: document.getElementById("baseline-run-select"),
  exportComparisonCsvBtn: document.getElementById("export-comparison-csv-btn"),
  resultsKpiStrip: document.getElementById("results-kpi-strip"),
  resultsChartsGrid: document.getElementById("results-charts-grid"),
  comparisonTableTitle: document.getElementById("comparison-table-title"),
  metricCategoryFilters: document.getElementById("metric-category-filters"),
  comparisonTableWrapper: document.getElementById("comparison-table-wrapper"),
  chartTooltip: document.getElementById("chart-tooltip"),
};

let activeTab = "config";
let activeRunId = null;
let eventSource = null;
let elapsedTimer = null;
let runStartedEpochMs = null;
let terminalLines = [];
let tokenExpiryEpochMs = null;
let tokenCountdownTimer = null;
let isUserAuthenticated = false;
let backendsList = [];
let backendsById = new Map();
let dynamicBackends = new Map();
let currentVertexEndpointTarget = null;
let lastAutoDetectKey = null;
let detectedDeploymentMeta = null;

/* --- Past Artifact Runs State --- */
let pastArtifactRuns = [];
let selectedArtifactRunIds = new Set();
let hasInitializedDefaultSelection = false;
let baselineRunId = null;
let activeMetricCategory = "all";
let percentileCurveMetricTag = "time_to_first_token";
let paretoLatencyMetricTag = "time_to_first_token";
let singleHistogramMetricTag = "request_latency";
const runRecordsCache = new Map();

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

function escapeHtml(value) {
  const str = String(value ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getSelectedAuthMode() {
  return els.authModeProxy && els.authModeProxy.checked ? "proxy" : "direct";
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(totalSeconds) {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatMetricNumber(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) {
    return "—";
  }
  const num = Number(val);
  if (Number.isInteger(num) && Math.abs(num) < 1e9) {
    return num.toLocaleString("en-US");
  }
  const abs = Math.abs(num);
  if (abs >= 1000) {
    return num.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  if (abs >= 10) {
    return num.toFixed(2);
  }
  if (abs >= 1) {
    return num.toFixed(2);
  }
  if (abs === 0) {
    return "0";
  }
  return num.toFixed(3);
}

function formatShortTimestamp(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 16);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateLabel(str, maxLen = 22) {
  const s = String(str ?? "");
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

/* --- Multi-Tab Switching (Config | Output | Past Runs & Metrics) --- */
function switchTab(tabName) {
  activeTab = tabName;
  const tabDefs = [
    { name: "config", btn: els.tabBtnConfig, panel: els.tabPanelConfig },
    { name: "output", btn: els.tabBtnOutput, panel: els.tabPanelOutput },
    { name: "results", btn: els.tabBtnResults, panel: els.tabPanelResults },
  ];

  for (const t of tabDefs) {
    const isCurrent = t.name === tabName;
    t.btn.classList.toggle("active", isCurrent);
    t.btn.setAttribute("aria-selected", isCurrent ? "true" : "false");
    t.btn.setAttribute("tabindex", isCurrent ? "0" : "-1");
    t.panel.classList.toggle("hidden", !isCurrent);
    t.panel.hidden = !isCurrent;
  }

  hideChartTooltip();

  if (tabName === "output" && els.autoscrollToggle && els.autoscrollToggle.checked) {
    els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
  }
  if (tabName === "results") {
    loadPastArtifactRuns(false);
  }
}

/* --- Top-Right Google Account OAuth 2.0 & Token Validity --- */
function stopTokenCountdown() {
  if (tokenCountdownTimer) {
    clearInterval(tokenCountdownTimer);
    tokenCountdownTimer = null;
  }
  tokenExpiryEpochMs = null;
}

function triggerVerifyNudge() {
  els.verifyTokenBtn.classList.remove("nudge");
  void els.verifyTokenBtn.offsetWidth;
  els.verifyTokenBtn.classList.add("nudge");
}

function setTokenVisualState(isValid, captionText, expiresInSeconds = null) {
  els.verifyTokenBtn.classList.toggle("token-valid", isValid);
  els.verifyTokenBtn.classList.toggle("token-invalid", !isValid);
  els.verifyTokenLabel.textContent = isValid ? "Verified Token" : "Verify Token";
  els.tokenValidityCaption.classList.toggle("valid", isValid);
  els.tokenValidityCaption.classList.toggle("invalid", !isValid);

  stopTokenCountdown();

  if (isValid && typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
    tokenExpiryEpochMs = Date.now() + expiresInSeconds * 1000;
    const tick = () => {
      const remaining = (tokenExpiryEpochMs - Date.now()) / 1000;
      if (remaining <= 0) {
        setTokenVisualState(false, "Token expired");
        return;
      }
      els.tokenValidityCaption.textContent = `Valid for ${formatDuration(remaining)}`;
    };
    tick();
    tokenCountdownTimer = setInterval(tick, 1000);
  } else {
    els.tokenValidityCaption.textContent = captionText;
  }
}

async function refreshAuthStatus() {
  try {
    const resp = await fetch("/api/auth/status");
    const status = await resp.json();
    renderAuthStatus(status);
  } catch {
    setTokenVisualState(false, "Auth status unavailable");
  }
}

function renderAuthStatus(status) {
  isUserAuthenticated = Boolean(status.authenticated);
  if (!status.authenticated) {
    els.googleSigninLabel.textContent = "Sign in with Google";
    els.googleSigninBtn.title = "Sign in with your Google Account";
    setTokenVisualState(false, "Not signed in");
    return;
  }

  els.googleSigninLabel.textContent = status.principal_email;
  els.googleSigninBtn.title = `Signed in as ${status.principal_email} — click to switch Google Account`;

  const exp = status.expires_in_seconds;
  if (typeof exp === "number" && exp <= 0) {
    setTokenVisualState(false, "Token expired — click Verify");
  } else if (typeof exp === "number") {
    setTokenVisualState(true, "", exp);
  } else {
    setTokenVisualState(true, "Token valid");
  }
}

async function startBrowserGoogleSignIn() {
  els.errorBanner.classList.add("hidden");
  try {
    const resp = await fetch("/api/auth/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "loopback" }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "Failed to initiate Google OAuth 2.0 flow.");
    }

    const popup = window.open(
      data.auth_url,
      "vertex_aiperf_google_oauth",
      "width=540,height=660,menubar=no,toolbar=no,status=no"
    );
    if (!popup) {
      window.location.assign(data.auth_url);
      return;
    }

    els.tokenValidityCaption.textContent = "Complete sign-in in popup...";
  } catch {
    setTokenVisualState(false, "Sign-in failed");
  }
}

async function verifyLiveToken() {
  els.verifyTokenBtn.disabled = true;
  els.verifyTokenLabel.textContent = "Verifying...";
  try {
    const resp = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await resp.json();
    if (!data.valid) {
      const msg =
        data.error && data.error.toLowerCase().includes("not signed in")
          ? "Sign in with Google first"
          : "Token invalid / expired";
      setTokenVisualState(false, msg);
      triggerVerifyNudge();
      return;
    }

    if (data.info?.principal_email) {
      els.googleSigninLabel.textContent = data.info.principal_email;
    }
    if (typeof data.expires_in_seconds === "number") {
      setTokenVisualState(true, "", data.expires_in_seconds);
    } else {
      setTokenVisualState(true, "Token valid");
    }
  } catch {
    setTokenVisualState(false, "Verification error");
    triggerVerifyNudge();
  } finally {
    els.verifyTokenBtn.disabled = false;
  }
}

window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "vertex_aiperf_oauth_complete") {
    if (event.data.ok) {
      lastAutoDetectKey = null;
      refreshAuthStatus().then(() => {
        if (currentVertexEndpointTarget) {
          autoDetectBackendFromEndpoint(false);
        }
      });
    } else {
      setTokenVisualState(false, "Sign-in cancelled");
    }
  }
});

/* --- Command Validation --- */
async function validateCommand() {
  const raw = els.cmdInput.value.trim();

  if (!raw) {
    currentVertexEndpointTarget = null;
    els.cmdValidationBar.className = "validation-bar neutral";
    els.cmdValidationBar.innerHTML =
      "Enter an <code>aiperf</code> CLI command to validate arguments and inspect endpoint metadata.";
    els.cmdMetaTags.classList.add("hidden");
    els.cmdNotesList.classList.add("hidden");
    return;
  }

  try {
    const resp = await fetch("/api/validate-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: raw }),
    });
    const data = await resp.json();

    if (!data.valid) {
      currentVertexEndpointTarget = null;
      els.cmdValidationBar.className = "validation-bar invalid";
      els.cmdValidationBar.textContent = data.error || "Invalid AIPerf command.";
      els.cmdMetaTags.classList.add("hidden");
      els.cmdNotesList.classList.add("hidden");
      return;
    }

    const p = data.parsed;
    els.cmdValidationBar.className = "validation-bar valid";
    els.cmdValidationBar.textContent = `Valid AIPerf '${p.subcommand}' command`;

    const tags = [];
    if (p.models && p.models.length) {
      tags.push(
        `<span class="meta-tag"><strong>Model:</strong> <code>${escapeHtml(p.models.join(", "))}</code></span>`
      );
    }
    if (p.endpoint_type) {
      tags.push(
        `<span class="meta-tag"><strong>Type:</strong> <code>${escapeHtml(p.endpoint_type)}${p.streaming ? " (SSE streaming)" : ""}</code></span>`
      );
    }
    if (p.vertex_endpoints && p.vertex_endpoints.length) {
      const ve = p.vertex_endpoints[0];
      if (ve.is_vertex_ai) {
        if (ve.project) {
          tags.push(
            `<span class="meta-tag"><strong>Vertex Project:</strong> <code>${escapeHtml(ve.project)}</code></span>`
          );
        }
        if (ve.location) {
          tags.push(
            `<span class="meta-tag"><strong>Region:</strong> <code>${escapeHtml(ve.location)}</code></span>`
          );
        }
        if (ve.endpoint_id) {
          tags.push(
            `<span class="meta-tag"><strong>Endpoint ID:</strong> <code>${escapeHtml(ve.endpoint_id)}</code></span>`
          );
        }
      } else if (ve.host) {
        tags.push(
          `<span class="meta-tag"><strong>Host:</strong> <code>${escapeHtml(ve.host)}</code></span>`
        );
      }
    }
    if (p.dataset_summary) {
      tags.push(
        `<span class="meta-tag"><strong>Dataset:</strong> <code>${escapeHtml(p.dataset_summary)}</code></span>`
      );
    }
    if (p.concurrency) {
      tags.push(
        `<span class="meta-tag"><strong>Load:</strong> <code>concurrency ${escapeHtml(p.concurrency)}</code></span>`
      );
    }
    if (p.num_conversations) {
      tags.push(
        `<span class="meta-tag"><strong>num-conversations:</strong> <code>${escapeHtml(p.num_conversations)}</code></span>`
      );
    }

    if (tags.length) {
      els.cmdMetaTags.innerHTML = tags.join("");
      els.cmdMetaTags.classList.remove("hidden");
    } else {
      els.cmdMetaTags.classList.add("hidden");
    }

    if (p.notes && p.notes.length) {
      els.cmdNotesList.innerHTML = p.notes
        .map((n) => `<li>${escapeHtml(n)}</li>`)
        .join("");
      els.cmdNotesList.classList.remove("hidden");
    } else {
      els.cmdNotesList.classList.add("hidden");
    }

    const firstVe = (p.vertex_endpoints || []).find(
      (ve) => ve.is_vertex_ai && ve.project && ve.location && ve.endpoint_id
    );
    if (firstVe) {
      currentVertexEndpointTarget = {
        project: firstVe.project,
        location: firstVe.location,
        endpoint_id: firstVe.endpoint_id,
      };
      const isPlaceholder =
        firstVe.project.toUpperCase().includes("YOUR-") ||
        firstVe.endpoint_id.toUpperCase().includes("YOUR-") ||
        firstVe.project.includes("[") ||
        firstVe.endpoint_id.includes("[");
      if (!isPlaceholder) {
        autoDetectBackendFromEndpoint(false);
      }
    } else {
      currentVertexEndpointTarget = null;
    }
  } catch (err) {
    els.cmdValidationBar.className = "validation-bar invalid";
    els.cmdValidationBar.textContent = `Validation request failed: ${err.message}`;
  }
}

/* --- Run Execution & Verbatim AIPerf Output Display --- */
function syncTerminalBuffer() {
  els.terminalOutput.textContent = terminalLines.join("\n");
  if (els.autoscrollToggle.checked) {
    els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
  }
}

function syncHistoryTileWithJob(job) {
  if (!job || !job.run_id || !els.historyList) return;
  const status = job.status || "idle";
  let matched = false;

  els.historyList.querySelectorAll(".history-item").forEach((btn) => {
    const isThisJob = btn.dataset.runId === job.run_id;
    btn.classList.toggle("active", btn.dataset.runId === activeRunId);
    if (isThisJob) {
      matched = true;
      const badge = btn.querySelector(".status-badge");
      if (badge) {
        badge.className = `status-badge ${status}`;
        badge.textContent = status;
      }
    }
  });

  if (!matched) {
    refreshHistory();
  }
}

function updateStatusUI(job) {
  const status = job.status || "idle";
  els.statusBadge.className = `status-badge ${status}`;
  els.statusBadge.textContent = status;
  const principalLabel = job.principal?.principal_email
    ? ` · ${job.principal.principal_email}`
    : "";
  const displayName = job.run_name || job.run_id;
  els.runIdLabel.textContent = `${displayName}${principalLabel} (${job.auth_mode === "proxy" ? "auto-refresh proxy" : "direct bearer"})`;

  const isActive = status === "starting" || status === "running";
  els.startRunBtn.disabled = isActive;
  els.stopRunBtn.classList.toggle("hidden", !isActive);
  els.stopRunOutputBtn.classList.toggle("hidden", !isActive);

  syncHistoryTileWithJob(job);

  if (!isActive) {
    stopElapsedClock();
    renderArtifacts(job);
    refreshHistory();
    loadPastArtifactRuns(false);
  }
}

function startElapsedClock(createdAtIso) {
  stopElapsedClock();
  runStartedEpochMs = createdAtIso ? Date.parse(createdAtIso) : Date.now();
  const tick = () => {
    const secs = Math.max(
      0,
      Math.floor((Date.now() - runStartedEpochMs) / 1000)
    );
    els.elapsedLabel.textContent = `· ${formatDuration(secs)}`;
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
}

function stopElapsedClock() {
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function connectStream(runId) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  activeRunId = runId;
  eventSource = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`);

  eventSource.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    if (payload.type === "init") {
      terminalLines = Array.isArray(payload.logs) ? [...payload.logs] : [];
      syncTerminalBuffer();
      updateStatusUI(payload.job);
    } else if (payload.type === "log") {
      terminalLines.push(payload.line);
      syncTerminalBuffer();
    } else if (payload.type === "status") {
      updateStatusUI(payload.job);
    } else if (payload.type === "done") {
      updateStatusUI(payload.job);
      eventSource.close();
      eventSource = null;
    }
  };

  eventSource.onerror = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    loadRunDetails(runId, false);
  };
}

function renderArtifacts(job) {
  const hasArtifacts = job.artifacts && job.artifacts.length > 0;
  if (!hasArtifacts) {
    els.resultsPanel.classList.add("hidden");
    return;
  }

  els.resultsPanel.classList.remove("hidden");
  els.artifactDirDisplay.textContent = job.artifact_dir || "";
  const zipFilename = job.zip_filename || `${job.run_id}.zip`;
  els.downloadZipBtn.href = `/api/runs/${encodeURIComponent(job.run_id)}/artifacts-zip/${encodeURIComponent(zipFilename)}`;
  els.downloadZipBtn.setAttribute("download", zipFilename);
  els.downloadZipBtn.textContent = `Download ${zipFilename}`;

  els.artifactLinksContainer.innerHTML = job.artifacts
    .map(
      (art) => `
      <a
        class="artifact-link"
        href="/api/runs/${encodeURIComponent(job.run_id)}/artifacts/${art.name.split("/").map(encodeURIComponent).join("/")}"
        download
      >
        ${escapeHtml(art.name)} (${formatBytes(art.size_bytes)})
      </a>`
    )
    .join("");
}

async function startBenchmark() {
  els.errorBanner.classList.add("hidden");
  const command = els.cmdInput.value.trim();
  const backend = els.backendSelect.value || null;
  const runName = els.runNameInput.value.trim() || null;
  const hfToken = els.hfTokenInput.value.trim() || null;
  const authMode = getSelectedAuthMode();

  if (!command) {
    els.errorBanner.textContent = "Please enter an AIPerf CLI command.";
    els.errorBanner.classList.remove("hidden");
    return;
  }

  localStorage.setItem("vertex_aiperf_cmd", command);
  if (backend) {
    localStorage.setItem("vertex_aiperf_backend", backend);
  } else {
    localStorage.removeItem("vertex_aiperf_backend");
  }
  if (runName) {
    localStorage.setItem("vertex_aiperf_run_name", runName);
  } else {
    localStorage.removeItem("vertex_aiperf_run_name");
  }

  els.startRunBtn.disabled = true;
  els.resultsPanel.classList.add("hidden");
  terminalLines = [];
  els.terminalOutput.textContent = "";

  try {
    const resp = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command,
        backend,
        run_name: runName,
        hf_token: hfToken,
        auth_mode: authMode,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "Failed to start benchmark run.");
    }

    activeRunId = data.run_id;
    refreshAuthStatus();
    updateStatusUI(data.job);
    switchTab("output");
    startElapsedClock(data.job.created_at);
    connectStream(data.run_id);
  } catch (err) {
    els.startRunBtn.disabled = false;
    els.errorBanner.textContent = err.message;
    els.errorBanner.classList.remove("hidden");
  }
}

async function stopBenchmark() {
  if (!activeRunId) return;
  els.stopRunBtn.disabled = true;
  els.stopRunOutputBtn.disabled = true;
  try {
    await fetch(`/api/runs/${encodeURIComponent(activeRunId)}/stop`, {
      method: "POST",
    });
  } finally {
    els.stopRunBtn.disabled = false;
    els.stopRunOutputBtn.disabled = false;
  }
}

async function loadRunDetails(runId, switchToOutput = true) {
  try {
    const resp = await fetch(
      `/api/runs/${encodeURIComponent(runId)}?include_logs=true`
    );
    if (!resp.ok) return;
    const { job } = await resp.json();
    activeRunId = job.run_id;
    terminalLines = Array.isArray(job.logs) ? [...job.logs] : [];
    syncTerminalBuffer();
    updateStatusUI(job);
    if (switchToOutput) {
      switchTab("output");
    }
    if (job.status === "starting" || job.status === "running") {
      startElapsedClock(job.created_at);
      connectStream(job.run_id);
    }
  } catch {
    // Ignore
  }
}

let historyRefreshSeq = 0;

async function refreshHistory() {
  const seq = ++historyRefreshSeq;
  try {
    const resp = await fetch("/api/runs");
    if (!resp.ok || seq !== historyRefreshSeq) return;
    const { runs } = await resp.json();
    if (seq !== historyRefreshSeq) return;
    if (!runs || runs.length === 0) {
      els.historyPanel.classList.add("hidden");
      return;
    }
    els.historyPanel.classList.remove("hidden");
    els.historyList.innerHTML = runs
      .map(
        (r) => `
        <button
          type="button"
          class="history-item ${r.run_id === activeRunId ? "active" : ""}"
          data-run-id="${escapeHtml(r.run_id)}"
        >
          <span class="status-badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span>
          <span>${escapeHtml(r.run_id)}</span>
        </button>`
      )
      .join("");

    els.historyList.querySelectorAll(".history-item").forEach((btn) => {
      btn.addEventListener("click", () => loadRunDetails(btn.dataset.runId, true));
    });

    // Keep the tab title status badge in sync with the active run's authoritative server state
    if (activeRunId) {
      const activeEntry = runs.find((r) => r.run_id === activeRunId);
      if (activeEntry && activeEntry.status) {
        els.statusBadge.className = `status-badge ${activeEntry.status}`;
        els.statusBadge.textContent = activeEntry.status;
      }
    }
  } catch {
    // Ignore
  }
}

function rebuildBackendSelectOptions(preserveValue = null) {
  const targetVal = preserveValue !== null ? preserveValue : els.backendSelect.value;
  const groups = new Map();

  if (dynamicBackends.size > 0) {
    groups.set("Detected from Vertex AI Endpoint", [...dynamicBackends.values()]);
  }
  for (const b of backendsList) {
    const grp = b.series || "Backends";
    if (!groups.has(grp)) groups.set(grp, []);
    groups.get(grp).push(b);
  }

  const optgroupsHtml = [...groups.entries()]
    .map(([seriesName, items]) => {
      const opts = items
        .map((b) => {
          const vramPart = b.vram_gb !== null && b.vram_gb !== undefined ? ` · ${b.vram_gb} GB VRAM` : "";
          const costPart =
            b.hourly_cost_usd !== null && b.hourly_cost_usd !== undefined
              ? ` · $${Number(b.hourly_cost_usd).toFixed(2)}/hr`
              : "";
          return `<option value="${escapeHtml(b.id)}">${escapeHtml(b.id)} — ${escapeHtml(b.chip_name)}${vramPart}${costPart}</option>`;
        })
        .join("");
      return `<optgroup label="${escapeHtml(seriesName)}">${opts}</optgroup>`;
    })
    .join("");

  els.backendSelect.innerHTML =
    `<option value="">— Select a backend (optional) —</option>` + optgroupsHtml;

  if (targetVal && (backendsById.has(targetVal) || dynamicBackends.has(targetVal))) {
    els.backendSelect.value = targetVal;
  }
}

function setBackendDetectStatus(mode, text) {
  if (!text) {
    els.backendDetectStatus.classList.add("hidden");
    els.backendDetectStatus.textContent = "";
    return;
  }
  els.backendDetectStatus.className = `backend-detect-status ${mode === "detected" ? "detected" : "fallback"}`;
  els.backendDetectStatus.textContent = text;
}

function renderSelectedBackendSpecs() {
  const selectedId = els.backendSelect.value;
  const info = selectedId ? backendsById.get(selectedId) || dynamicBackends.get(selectedId) : null;

  if (!info) {
    els.backendSpecsCard.classList.add("hidden");
    els.backendSpecsCard.innerHTML = "";
    els.clearBackendBtn.classList.add("hidden");
    return;
  }

  els.clearBackendBtn.classList.remove("hidden");
  const hasVram = info.vram_gb !== null && info.vram_gb !== undefined;
  const perChipVram =
    hasVram && info.accelerator_count > 1
      ? ` (${Math.round(info.vram_gb / info.accelerator_count)} GB / chip)`
      : "";
  const vramStr = hasVram ? `${info.vram_gb} GB${perChipVram}` : "N/A";
  const bwStr =
    info.memory_bandwidth_gb_s !== null && info.memory_bandwidth_gb_s !== undefined
      ? `${Number(info.memory_bandwidth_gb_s).toLocaleString("en-US")} GB/s`
      : "N/A";
  const costStr =
    info.hourly_cost_usd !== null && info.hourly_cost_usd !== undefined
      ? `$${Number(info.hourly_cost_usd).toFixed(2)} / hr`
      : "Unlisted";
  const accelCountStr =
    info.accelerator_count > 0
      ? `${info.accelerator_count}x ${info.family}`
      : info.family;

  let replicaItemHtml = "";
  if (
    detectedDeploymentMeta &&
    detectedDeploymentMeta.backend_id === info.id &&
    (detectedDeploymentMeta.min_replica_count !== null ||
      detectedDeploymentMeta.max_replica_count !== null)
  ) {
    const minR = detectedDeploymentMeta.min_replica_count ?? "?";
    const maxR = detectedDeploymentMeta.max_replica_count ?? minR;
    const repText = minR === maxR ? `${minR}` : `${minR} – ${maxR}`;
    replicaItemHtml = `
      <div class="backend-spec-item">
        <span class="backend-spec-label">Endpoint Replicas</span>
        <span class="backend-spec-val">${escapeHtml(repText)}</span>
      </div>`;
  }

  els.backendSpecsCard.innerHTML = `
    <div class="backend-specs-top">
      <div class="backend-specs-title-row">
        <span class="backend-machine-badge">${escapeHtml(info.id)}</span>
        <span class="backend-family-badge">${escapeHtml(info.family)}</span>
        <span class="backend-chip-heading">${escapeHtml(info.chip_name)}</span>
      </div>
      <span class="backend-cost-pill">${escapeHtml(costStr)}</span>
    </div>
    <p class="backend-specs-desc">${escapeHtml(info.description)}</p>
    <div class="backend-specs-grid">
      <div class="backend-spec-item">
        <span class="backend-spec-label">Accelerator Type</span>
        <span class="backend-spec-val">${escapeHtml(info.accelerator_type)}</span>
      </div>
      <div class="backend-spec-item">
        <span class="backend-spec-label">Accelerator Count</span>
        <span class="backend-spec-val">${escapeHtml(accelCountStr)}</span>
      </div>
      <div class="backend-spec-item">
        <span class="backend-spec-label">Total VRAM</span>
        <span class="backend-spec-val">${escapeHtml(vramStr)}</span>
      </div>
      <div class="backend-spec-item">
        <span class="backend-spec-label">Memory Bandwidth</span>
        <span class="backend-spec-val">${escapeHtml(bwStr)}</span>
      </div>
      <div class="backend-spec-item">
        <span class="backend-spec-label">Hourly Cost</span>
        <span class="backend-spec-val">${escapeHtml(costStr)}</span>
      </div>
      ${replicaItemHtml}
    </div>`;
  els.backendSpecsCard.classList.remove("hidden");
}

async function autoDetectBackendFromEndpoint(forceManualClick = false) {
  const rawCmd = els.cmdInput.value.trim();
  const payload = currentVertexEndpointTarget
    ? { ...currentVertexEndpointTarget }
    : { command: rawCmd };

  const cacheKey = currentVertexEndpointTarget
    ? `${currentVertexEndpointTarget.project}:${currentVertexEndpointTarget.location}:${currentVertexEndpointTarget.endpoint_id}:${isUserAuthenticated}`
    : null;

  if (!forceManualClick && cacheKey && cacheKey === lastAutoDetectKey) {
    return;
  }
  if (cacheKey) {
    lastAutoDetectKey = cacheKey;
  }

  if (forceManualClick) {
    els.detectBackendBtn.disabled = true;
    els.detectBackendBtn.textContent = "Detecting...";
  }

  try {
    const resp = await fetch("/api/backends/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();

    if (data.detected && data.backend_id && data.backend) {
      detectedDeploymentMeta = data;
      if (!backendsById.has(data.backend_id)) {
        dynamicBackends.set(data.backend_id, data.backend);
        rebuildBackendSelectOptions(data.backend_id);
      } else {
        els.backendSelect.value = data.backend_id;
      }
      localStorage.setItem("vertex_aiperf_backend", data.backend_id);
      const modelNote = data.deployed_model_display_name
        ? ` (${data.deployed_model_display_name})`
        : "";
      setBackendDetectStatus(
        "detected",
        `Auto-selected '${data.backend_id}' from Vertex AI Endpoint${modelNote}`
      );
      renderSelectedBackendSpecs();
      return;
    }

    if (forceManualClick || !data.requires_auth) {
      setBackendDetectStatus(
        "fallback",
        data.reason || "Could not auto-detect backend from endpoint — select a predefined backend from the list."
      );
    } else if (!els.backendSelect.value) {
      setBackendDetectStatus(
        "fallback",
        "Sign in with Google to auto-detect the backend from your Vertex AI endpoint, or choose from the predefined list."
      );
    }
  } catch {
    if (forceManualClick) {
      setBackendDetectStatus(
        "fallback",
        "Could not reach backend detection API — select a predefined backend from the list."
      );
    }
  } finally {
    if (forceManualClick) {
      els.detectBackendBtn.disabled = false;
      els.detectBackendBtn.textContent = "Detect from Endpoint";
    }
  }
}

async function loadBackendsCatalog() {
  try {
    const resp = await fetch("/api/backends");
    if (!resp.ok) return;
    const data = await resp.json();
    backendsList = Array.isArray(data.backends) ? data.backends : [];
    backendsById = new Map(backendsList.map((b) => [b.id, b]));

    const savedBackend = localStorage.getItem("vertex_aiperf_backend");
    rebuildBackendSelectOptions(savedBackend || "");
    renderSelectedBackendSpecs();
  } catch {
    // Ignore transient fetch errors
  }
}

function copyCliEquivalent() {
  const cmd = els.cmdInput.value.trim() || "aiperf profile ...";
  const backend = els.backendSelect.value.trim();
  const runName = els.runNameInput.value.trim();
  const hasHf = Boolean(els.hfTokenInput.value.trim());
  const mode = getSelectedAuthMode();
  const escapedCmd = cmd.replace(/'/g, "'\\''");
  const modeFlag = mode === "proxy" ? " --auth-mode proxy" : "";
  const backendFlag = backend
    ? ` --backend '${backend.replace(/'/g, "'\\''")}'`
    : "";
  const nameFlag = runName
    ? ` --run-name '${runName.replace(/'/g, "'\\''")}'`
    : "";
  const hfFlag = hasHf ? ' --hf-token "$HF_TOKEN"' : "";
  const full = `.venv/bin/python app.py --cli${modeFlag}${backendFlag}${nameFlag}${hfFlag} --cmd '${escapedCmd}'`;
  navigator.clipboard.writeText(full).then(() => {
    const orig = els.copyCliBtn.textContent;
    els.copyCliBtn.textContent = "Copied CLI Command";
    setTimeout(() => {
      els.copyCliBtn.textContent = orig;
    }, 1600);
  });
}

/* ============================================================================
 * Tab 3: Past Runs Discovery, Selection, Side-by-Side Table & SVG Graphics
 * ============================================================================ */

function getMetricMap(run) {
  if (!run._metricMap) {
    const map = new Map();
    for (const m of run.metrics || []) {
      map.set(m.tag, m);
    }
    run._metricMap = map;
  }
  return run._metricMap;
}

function getRunStat(run, tag, statKey = "avg") {
  const m = getMetricMap(run).get(tag);
  if (!m || !m.stats) return null;
  const val = m.stats[statKey];
  if (val !== null && val !== undefined) return Number(val);
  // Scalar metrics (like output_token_throughput) store their value in `avg`
  if (statKey !== "avg" && !m.has_percentiles && m.stats.avg !== null && m.stats.avg !== undefined) {
    return Number(m.stats.avg);
  }
  return null;
}

function getSelectedRunsOrdered() {
  const runsWithMetrics = pastArtifactRuns.filter((r) => r.has_metrics);
  return runsWithMetrics.filter((r) => selectedArtifactRunIds.has(r.run_id));
}

function getRunColorMap(selectedRuns) {
  const colorMap = new Map();
  selectedRuns.forEach((r, idx) => {
    colorMap.set(r.run_id, RUN_SERIES_PALETTE[idx % RUN_SERIES_PALETTE.length]);
  });
  return colorMap;
}

async function loadPastArtifactRuns(forceClearRecordsCache = false) {
  if (forceClearRecordsCache) {
    runRecordsCache.clear();
  }
  try {
    const resp = await fetch("/api/artifact-runs");
    if (!resp.ok) return;
    const data = await resp.json();
    pastArtifactRuns = Array.isArray(data.runs) ? data.runs : [];
    if (data.artifacts_dir) {
      els.artifactsFolderCaption.textContent = data.artifacts_dir;
    }

    const validRuns = pastArtifactRuns.filter((r) => r.has_metrics);
    els.pastRunsCountBadge.textContent = String(
      validRuns.length > 0 ? validRuns.length : pastArtifactRuns.length
    );
    els.pastRunsCountBadge.className = `status-badge ${
      validRuns.length > 0 ? "succeeded" : pastArtifactRuns.length > 0 ? "cancelled" : "idle"
    }`;

    // Prune any removed run IDs from selection
    const validIdSet = new Set(validRuns.map((r) => r.run_id));
    for (const id of [...selectedArtifactRunIds]) {
      if (!validIdSet.has(id)) {
        selectedArtifactRunIds.delete(id);
      }
    }

    // Default to selecting the newest completed run on first load
    if (!hasInitializedDefaultSelection && validRuns.length > 0) {
      hasInitializedDefaultSelection = true;
      selectedArtifactRunIds.add(validRuns[0].run_id);
    }

    if (activeTab === "results") {
      renderPastRunsTab();
    }
  } catch {
    // Ignore transient fetch errors
  }
}

function getFilteredArtifactRuns() {
  const q = (els.pastRunsSearchInput.value || "").trim().toLowerCase();
  if (!q) return pastArtifactRuns;
  return pastArtifactRuns.filter((r) => {
    const hay = [
      r.run_id,
      r.model,
      r.dataset,
      r.concurrency ? `c=${r.concurrency}` : "",
      r.incomplete_reason,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

function getFilteredRunsWithMetrics() {
  return getFilteredArtifactRuns().filter((r) => r.has_metrics);
}

function renderRunSelectorList() {
  const incompleteRuns = pastArtifactRuns.filter((r) => !r.has_metrics);
  const filteredAll = getFilteredArtifactRuns();
  const selectedRuns = getSelectedRunsOrdered();
  const colorMap = getRunColorMap(selectedRuns);

  if (incompleteRuns.length > 0) {
    els.pastRunsIncompleteNote.textContent =
      `${incompleteRuns.length} folder(s) in artifacts/ stopped before exporting metrics (shown disabled above; only completed runs with profile_export_aiperf.json or .csv can be charted).`;
    els.pastRunsIncompleteNote.classList.remove("hidden");
  } else {
    els.pastRunsIncompleteNote.classList.add("hidden");
  }

  if (pastArtifactRuns.length === 0) {
    els.pastRunsSelectorList.innerHTML = "";
    return;
  }

  if (filteredAll.length === 0) {
    els.pastRunsSelectorList.innerHTML =
      `<div class="incomplete-runs-note">No runs match filter "${escapeHtml(els.pastRunsSearchInput.value)}".</div>`;
    return;
  }

  els.pastRunsSelectorList.innerHTML = filteredAll
    .map((run) => {
      const ts = formatShortTimestamp(run.timestamp);
      if (!run.has_metrics) {
        const badgeLabel = run.was_cancelled ? "Cancelled · No Metrics" : "Incomplete · No Metrics";
        const reason = run.incomplete_reason || run.parse_error || "No exported metrics file";
        const chips = [`<span class="run-meta-chip warn">${escapeHtml(badgeLabel)}</span>`];
        if (run.model) chips.push(`<span class="run-meta-chip">${escapeHtml(truncateLabel(run.model, 22))}</span>`);
        if (ts) chips.push(`<span>${escapeHtml(ts)}</span>`);
        return `
          <div class="run-select-item incomplete" title="${escapeHtml(reason)}">
            <div class="run-select-main">
              <input
                type="checkbox"
                class="run-select-checkbox"
                disabled
                aria-label="Run ${escapeHtml(run.run_id)} has no exported metrics"
              />
              <span class="run-color-swatch" style="background:hsl(28, 88%, 52%)"></span>
              <div class="run-select-info">
                <div class="run-select-name">${escapeHtml(run.run_id)}</div>
                <div class="run-select-meta">${chips.join("")}</div>
                <div class="run-incomplete-reason">${escapeHtml(reason)}</div>
              </div>
            </div>
            <a
              class="run-select-zip"
              href="/api/artifact-runs/zip?run_id=${encodeURIComponent(run.run_id)}"
              download
              title="Download ${escapeHtml(run.run_id)}.zip (logs)"
            >.zip</a>
          </div>`;
      }

      const isSelected = selectedArtifactRunIds.has(run.run_id);
      const swatchColor = colorMap.get(run.run_id) || "hsl(214, 18%, 78%)";
      const ttft = getRunStat(run, "time_to_first_token", "avg");
      const outTps = getRunStat(run, "output_token_throughput", "avg");
      const chips = [];
      if (run.backend?.id) {
        chips.push(`<span class="run-meta-chip">${escapeHtml(run.backend.id)}</span>`);
      }
      if (run.model) chips.push(`<span class="run-meta-chip">${escapeHtml(truncateLabel(run.model, 24))}</span>`);
      if (run.concurrency !== null && run.concurrency !== undefined) {
        chips.push(`<span class="run-meta-chip">c=${escapeHtml(run.concurrency)}</span>`);
      } else if (run.request_rate !== null && run.request_rate !== undefined) {
        chips.push(`<span class="run-meta-chip">${escapeHtml(run.request_rate)} req/s</span>`);
      }
      if (ttft !== null) chips.push(`<span>TTFT ${formatMetricNumber(ttft)}ms</span>`);
      if (outTps !== null) chips.push(`<span>${formatMetricNumber(outTps)} tok/s</span>`);
      if (ts) chips.push(`<span>${escapeHtml(ts)}</span>`);

      return `
        <div class="run-select-item ${isSelected ? "selected" : ""}" data-run-id="${escapeHtml(run.run_id)}">
          <div class="run-select-main">
            <input
              type="checkbox"
              class="run-select-checkbox"
              ${isSelected ? "checked" : ""}
              aria-label="Select run ${escapeHtml(run.run_id)}"
            />
            <span class="run-color-swatch" style="background:${swatchColor}"></span>
            <div class="run-select-info">
              <div class="run-select-name" title="${escapeHtml(run.run_id)}">${escapeHtml(run.run_id)}</div>
              <div class="run-select-meta">${chips.join("")}</div>
            </div>
          </div>
          <a
            class="run-select-zip"
            href="/api/artifact-runs/zip?run_id=${encodeURIComponent(run.run_id)}"
            download
            title="Download ${escapeHtml(run.run_id)}.zip"
          >.zip</a>
        </div>`;
    })
    .join("");

  els.pastRunsSelectorList.querySelectorAll(".run-select-item[data-run-id]").forEach((card) => {
    const runId = card.dataset.runId;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".run-select-zip")) return;
      if (selectedArtifactRunIds.has(runId)) {
        selectedArtifactRunIds.delete(runId);
      } else {
        selectedArtifactRunIds.add(runId);
      }
      renderPastRunsTab();
    });
  });
}

function syncBaselineDropdown(selectedRuns) {
  if (selectedRuns.length < 2) {
    els.baselineControlWrapper.classList.add("hidden");
    baselineRunId = selectedRuns[0]?.run_id || null;
    return;
  }

  els.baselineControlWrapper.classList.remove("hidden");
  const selectedIds = selectedRuns.map((r) => r.run_id);
  if (!baselineRunId || !selectedIds.includes(baselineRunId)) {
    // Default baseline to the oldest selected run (last in newest-first order) so newer runs show progression
    baselineRunId = selectedRuns[selectedRuns.length - 1].run_id;
  }

  els.baselineRunSelect.innerHTML = selectedRuns
    .map(
      (r) =>
        `<option value="${escapeHtml(r.run_id)}" ${r.run_id === baselineRunId ? "selected" : ""}>${escapeHtml(r.run_id)}</option>`
    )
    .join("");
}

function renderKpiStrip(selectedRuns, colorMap, statKey) {
  if (selectedRuns.length === 1) {
    const run = selectedRuns[0];
    const mMap = getMetricMap(run);
    const cards = [];

    const addSingleCard = (tag, fallbackTag, title) => {
      const m = mMap.get(tag) || (fallbackTag ? mMap.get(fallbackTag) : null);
      if (!m) return;
      const primary = getRunStat(run, m.tag, statKey);
      const subParts = [];
      if (m.has_percentiles) {
        if (m.stats.p50 !== null && m.stats.p50 !== undefined && statKey !== "p50") {
          subParts.push(`p50: ${formatMetricNumber(m.stats.p50)}`);
        }
        if (m.stats.p99 !== null && m.stats.p99 !== undefined && statKey !== "p99") {
          subParts.push(`p99: ${formatMetricNumber(m.stats.p99)}`);
        }
        if (m.stats.avg !== null && m.stats.avg !== undefined && statKey !== "avg") {
          subParts.push(`avg: ${formatMetricNumber(m.stats.avg)}`);
        }
      } else if (run.duration_sec) {
        subParts.push(`Duration: ${formatMetricNumber(run.duration_sec)}s`);
      }
      cards.push(`
        <div class="kpi-tile">
          <span class="kpi-label">${escapeHtml(title || m.label)} (${m.has_percentiles ? escapeHtml(statKey) : "total/rate"})</span>
          <div class="kpi-value-row">
            <span class="kpi-value">${formatMetricNumber(primary)}</span>
            <span class="kpi-unit">${escapeHtml(m.unit)}</span>
          </div>
          <div class="kpi-sub">${escapeHtml(subParts.join(" · ") || m.label)}</div>
        </div>`);
    };

    addSingleCard("time_to_first_token", "time_to_first_output_token", "Time to First Token");
    addSingleCard("inter_token_latency", "decode_duration", "Inter Token Latency");
    addSingleCard("request_latency", null, "Request Latency");
    addSingleCard("output_token_throughput", null, "System Output Throughput");
    addSingleCard("output_token_throughput_per_user", "request_throughput", "Per-User Throughput");

    els.resultsKpiStrip.innerHTML = cards.join("");
    return;
  }

  // Multi-run comparison KPI strip: surface winning run for each headline dimension
  const dimensions = [
    { tag: "time_to_first_token", label: "Best TTFT", lowerBetter: true },
    { tag: "inter_token_latency", label: "Best Inter-Token Latency", lowerBetter: true },
    { tag: "request_latency", label: "Best Request Latency", lowerBetter: true },
    { tag: "output_token_throughput", label: "Highest Output Tok/s", lowerBetter: false },
    { tag: "output_token_throughput_per_user", label: "Highest Tok/s/User", lowerBetter: false },
  ];

  const baselineRun = selectedRuns.find((r) => r.run_id === baselineRunId) || selectedRuns[0];
  const tiles = [];

  for (const dim of dimensions) {
    let bestRun = null;
    let bestVal = null;
    let unit = "";
    for (const r of selectedRuns) {
      const m = getMetricMap(r).get(dim.tag);
      if (m && !unit) unit = m.unit;
      const v = getRunStat(r, dim.tag, statKey);
      if (v === null) continue;
      if (
        bestVal === null ||
        (dim.lowerBetter ? v < bestVal : v > bestVal)
      ) {
        bestVal = v;
        bestRun = r;
      }
    }
    if (!bestRun || bestVal === null) continue;

    const baseVal = getRunStat(baselineRun, dim.tag, statKey);
    let deltaText = "";
    if (
      baselineRun.run_id !== bestRun.run_id &&
      baseVal !== null &&
      baseVal !== 0
    ) {
      const pct = ((bestVal - baseVal) / Math.abs(baseVal)) * 100;
      const sign = pct > 0 ? "+" : "";
      deltaText = ` (${sign}${pct.toFixed(1)}% vs baseline)`;
    }
    const swatch = colorMap.get(bestRun.run_id) || "#1168C6";
    tiles.push(`
      <div class="kpi-tile">
        <span class="kpi-label">${escapeHtml(dim.label)} (${dim.tag.includes("throughput") ? "rate" : escapeHtml(statKey)})</span>
        <div class="kpi-value-row">
          <span class="kpi-value">${formatMetricNumber(bestVal)}</span>
          <span class="kpi-unit">${escapeHtml(unit)}</span>
        </div>
        <div class="kpi-sub" title="${escapeHtml(bestRun.run_id + deltaText)}">
          <span class="legend-swatch" style="background:${swatch};border-radius:50%"></span>
          <span>${escapeHtml(truncateLabel(bestRun.run_id, 20))}${escapeHtml(deltaText)}</span>
        </div>
      </div>`);
  }

  els.resultsKpiStrip.innerHTML = tiles.join("");
}

/* --- Interactive Tooltip Helpers --- */
function showChartTooltip(evt, htmlContent) {
  els.chartTooltip.innerHTML = htmlContent;
  els.chartTooltip.classList.remove("hidden");
  positionChartTooltip(evt);
}

function positionChartTooltip(evt) {
  const pad = 14;
  const rect = els.chartTooltip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 10) {
    x = evt.clientX - rect.width - pad;
  }
  if (y + rect.height > window.innerHeight - 10) {
    y = evt.clientY - rect.height - pad;
  }
  els.chartTooltip.style.left = `${Math.max(8, x)}px`;
  els.chartTooltip.style.top = `${Math.max(8, y)}px`;
}

function hideChartTooltip() {
  els.chartTooltip.classList.add("hidden");
}

function bindTooltipTargets(container) {
  container.querySelectorAll("[data-tooltip]").forEach((el) => {
    el.addEventListener("mouseenter", (e) => {
      showChartTooltip(e, el.getAttribute("data-tooltip"));
    });
    el.addEventListener("mousemove", positionChartTooltip);
    el.addEventListener("mouseleave", hideChartTooltip);
  });
}

/* --- Single-Run Charts --- */
function buildSingleRunPercentileChartHtml(run, color) {
  const latencyMetrics = (run.metrics || []).filter(
    (m) => m.category === "latency" && m.has_percentiles && m.tag !== "benchmark_duration"
  );
  if (latencyMetrics.length === 0) {
    return `
      <div class="chart-panel">
        <div class="chart-header">
          <div>
            <h4 class="chart-title">Latency Percentile Profile</h4>
            <p class="chart-subtitle">No streaming/percentile latency metrics in this run</p>
          </div>
        </div>
      </div>`;
  }

  const width = 560;
  const rowH = 44;
  const topPad = 24;
  const bottomPad = 28;
  const leftPad = 175;
  const rightPad = 56;
  const plotW = width - leftPad - rightPad;
  const height = topPad + latencyMetrics.length * rowH + bottomPad;

  // Each row normalized to its own p99/max OR shared ms axis?
  // Note: ITL is ~10ms while Request Latency can be ~2000ms! Per-row horizontal range with explicit p50/p90/p99 badges OR log scale makes BOTH ITL and Request Latency clearly readable!
  // Let's use a clean log10 scale when max/min ratio > 25x, otherwise linear ms scale, with gridlines!
  let globalMin = Infinity;
  let globalMax = 0;
  for (const m of latencyMetrics) {
    const lo = m.stats.p10 ?? m.stats.min ?? m.stats.avg ?? 0;
    const hi = m.stats.p99 ?? m.stats.max ?? m.stats.avg ?? 0;
    if (lo > 0 && lo < globalMin) globalMin = lo;
    if (hi > globalMax) globalMax = hi;
  }
  if (!Number.isFinite(globalMin) || globalMin <= 0) globalMin = 0.1;
  if (globalMax <= 0) globalMax = 1;

  const useLog = globalMax / globalMin > 25;
  const minDomain = useLog ? Math.max(0.05, globalMin * 0.8) : 0;
  const maxDomain = globalMax * 1.12;

  const scaleX = (val) => {
    const v = Math.max(minDomain, Number(val) || 0);
    if (useLog) {
      const ratio =
        (Math.log10(v) - Math.log10(minDomain)) /
        Math.max(1e-6, Math.log10(maxDomain) - Math.log10(minDomain));
      return leftPad + Math.max(0, Math.min(1, ratio)) * plotW;
    }
    return leftPad + Math.max(0, Math.min(1, v / maxDomain)) * plotW;
  };

  // Axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const val = useLog
      ? Math.pow(10, Math.log10(minDomain) + t * (Math.log10(maxDomain) - Math.log10(minDomain)))
      : t * maxDomain;
    return { x: leftPad + t * plotW, val };
  });

  const gridSvg = ticks
    .map(
      (tk) => `
      <line x1="${tk.x.toFixed(1)}" y1="${topPad - 6}" x2="${tk.x.toFixed(1)}" y2="${height - bottomPad}" stroke="hsl(214,20%,90%)" stroke-dasharray="3,3" />
      <text x="${tk.x.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10.5" fill="hsl(215,13%,50%)">${formatMetricNumber(tk.val)} ms</text>`
    )
    .join("");

  const rowsSvg = latencyMetrics
    .map((m, idx) => {
      const cy = topPad + idx * rowH + rowH / 2;
      const s = m.stats;
      const p10 = s.p10 ?? s.min ?? s.p50 ?? s.avg;
      const p25 = s.p25 ?? p10;
      const p50 = s.p50 ?? s.avg;
      const p75 = s.p75 ?? s.p90 ?? p50;
      const p90 = s.p90 ?? p75;
      const p99 = s.p99 ?? s.max ?? p90;
      const avg = s.avg;

      const x10 = scaleX(p10);
      const x25 = scaleX(p25);
      const x50 = scaleX(p50);
      const x75 = scaleX(p75);
      const x90 = scaleX(p90);
      const x99 = scaleX(p99);
      const xAvg = avg !== null ? scaleX(avg) : null;

      const tip = escapeHtml(
        `<strong>${escapeHtml(m.label)} (${escapeHtml(m.unit)})</strong>` +
          `avg: <code>${formatMetricNumber(s.avg)}</code> · std: <code>${formatMetricNumber(s.std)}</code><br/>` +
          `p50: <code>${formatMetricNumber(s.p50)}</code> · p90: <code>${formatMetricNumber(s.p90)}</code> · p99: <code>${formatMetricNumber(s.p99)}</code><br/>` +
          `min: <code>${formatMetricNumber(s.min)}</code> · max: <code>${formatMetricNumber(s.max)}</code>`
      );

      return `
        <g class="chart-hit" data-tooltip="${tip}">
          <rect x="0" y="${cy - rowH / 2}" width="${width}" height="${rowH}" fill="transparent" />
          <text x="${leftPad - 10}" y="${cy + 4}" text-anchor="end" font-size="11.5" font-weight="500" fill="hsl(216,28%,18%)">${escapeHtml(truncateLabel(m.label, 25))}</text>
          <!-- p10 to p99 whisker -->
          <line x1="${x10.toFixed(1)}" y1="${cy}" x2="${x99.toFixed(1)}" y2="${cy}" stroke="${color}" stroke-width="2" stroke-opacity="0.45" />
          <line x1="${x10.toFixed(1)}" y1="${cy - 5}" x2="${x10.toFixed(1)}" y2="${cy + 5}" stroke="${color}" stroke-width="1.5" />
          <!-- p25 to p75 IQR box -->
          <rect x="${x25.toFixed(1)}" y="${cy - 8}" width="${Math.max(3, x75 - x25).toFixed(1)}" height="16" rx="3" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="1.4" />
          <!-- p50 median bar -->
          <line x1="${x50.toFixed(1)}" y1="${cy - 9}" x2="${x50.toFixed(1)}" y2="${cy + 9}" stroke="${color}" stroke-width="2.6" />
          <!-- avg marker -->
          ${xAvg !== null ? `<circle cx="${xAvg.toFixed(1)}" cy="${cy}" r="3.8" fill="#ffffff" stroke="${color}" stroke-width="2" />` : ""}
          <!-- p90 & p99 tail markers -->
          <circle cx="${x90.toFixed(1)}" cy="${cy}" r="3.4" fill="#D97706" />
          <circle cx="${x99.toFixed(1)}" cy="${cy}" r="4.2" fill="#D6334C" />
          <text x="${(x99 + 7).toFixed(1)}" y="${cy + 3.5}" font-size="10.5" font-family="JetBrains Mono, monospace" fill="hsl(215,16%,34%)">${formatMetricNumber(p99)}</text>
        </g>`;
    })
    .join("");

  return `
    <div class="chart-panel">
      <div class="chart-header">
        <div>
          <h4 class="chart-title">Latency Percentile Spread (${useLog ? "Log Scale" : "Linear Scale"})</h4>
          <p class="chart-subtitle">IQR box (p25–p75), median line (p50), mean hollow dot, p90 &amp; p99 tail markers</p>
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-swatch" style="background:${color}"></span>p25–p75 / p50</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#D97706;border-radius:50%"></span>p90</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#D6334C;border-radius:50%"></span>p99</span>
        </div>
      </div>
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Latency percentile profile chart">
          ${gridSvg}
          ${rowsSvg}
        </svg>
      </div>
    </div>`;
}

function buildSingleRunCompositionAndThroughputHtml(run) {
  const mMap = getMetricMap(run);
  const ttftM = mMap.get("time_to_first_token") || mMap.get("time_to_first_output_token");
  const decodeM = mMap.get("decode_duration");
  const reqLatM = mMap.get("request_latency");

  if (ttftM && (decodeM || reqLatM)) {
    const statsToPlot = ["avg", "p50", "p90", "p99"];
    const width = 560;
    const rowH = 44;
    const topPad = 20;
    const bottomPad = 26;
    const leftPad = 68;
    const rightPad = 78;
    const plotW = width - leftPad - rightPad;
    const height = topPad + statsToPlot.length * rowH + bottomPad;

    const pairs = statsToPlot.map((sk) => {
      const prefill = Math.max(0, Number(ttftM.stats[sk] ?? 0));
      let decode = 0;
      if (decodeM && decodeM.stats[sk] !== null && decodeM.stats[sk] !== undefined) {
        decode = Math.max(0, Number(decodeM.stats[sk]));
      } else if (reqLatM && reqLatM.stats[sk] !== null && reqLatM.stats[sk] !== undefined) {
        decode = Math.max(0, Number(reqLatM.stats[sk]) - prefill);
      }
      return { sk, prefill, decode, total: prefill + decode };
    });

    const maxTotal = Math.max(1e-6, ...pairs.map((p) => p.total)) * 1.08;

    const rowsSvg = pairs
      .map((p, idx) => {
        const y = topPad + idx * rowH + 10;
        const barH = 22;
        const wPrefill = (p.prefill / maxTotal) * plotW;
        const wDecode = (p.decode / maxTotal) * plotW;
        const pctPrefill = p.total > 0 ? ((p.prefill / p.total) * 100).toFixed(0) : "0";
        const pctDecode = p.total > 0 ? ((p.decode / p.total) * 100).toFixed(0) : "0";
        const tip = escapeHtml(
          `<strong>${p.sk.toUpperCase()} Latency Phase Split</strong>` +
            `Prefill (TTFT): <code>${formatMetricNumber(p.prefill)} ms</code> (${pctPrefill}%)<br/>` +
            `Decode: <code>${formatMetricNumber(p.decode)} ms</code> (${pctDecode}%)<br/>` +
            `Combined: <code>${formatMetricNumber(p.total)} ms</code>`
        );
        return `
          <g class="chart-hit" data-tooltip="${tip}">
            <text x="${leftPad - 10}" y="${y + 15}" text-anchor="end" font-size="11.5" font-weight="600" fill="hsl(216,28%,20%)">${p.sk.toUpperCase()}</text>
            <rect x="${leftPad}" y="${y}" width="${Math.max(1, wPrefill).toFixed(1)}" height="${barH}" rx="3" fill="#1168C6" />
            <rect x="${(leftPad + wPrefill).toFixed(1)}" y="${y}" width="${Math.max(1, wDecode).toFixed(1)}" height="${barH}" rx="3" fill="#0D8A5E" />
            <text x="${(leftPad + wPrefill + wDecode + 8).toFixed(1)}" y="${y + 15}" font-size="10.5" font-family="JetBrains Mono, monospace" fill="hsl(215,16%,34%)">${formatMetricNumber(p.total)} ms</text>
          </g>`;
      })
      .join("");

    return `
      <div class="chart-panel">
        <div class="chart-header">
          <div>
            <h4 class="chart-title">Prefill (TTFT) vs. Decode Time Composition</h4>
            <p class="chart-subtitle">Share of end-to-end generation time across avg, p50, p90, and p99</p>
          </div>
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#1168C6"></span>Prefill (TTFT)</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#0D8A5E"></span>Decode Duration</span>
          </div>
        </div>
        <div class="svg-chart-wrap">
          <svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Prefill vs Decode composition chart">
            ${rowsSvg}
          </svg>
        </div>
      </div>`;
  }

  // Fallback for non-streaming runs: Throughput & Token Volume bar chart
  const tputMetrics = (run.metrics || []).filter((m) => m.category === "throughput" || m.category === "tokens").slice(0, 6);
  const width = 560;
  const rowH = 38;
  const leftPad = 185;
  const rightPad = 85;
  const plotW = width - leftPad - rightPad;
  const height = 24 + Math.max(1, tputMetrics.length) * rowH + 16;
  const maxVal = Math.max(1, ...tputMetrics.map((m) => Number(m.stats.avg || 0)));

  const rows = tputMetrics
    .map((m, idx) => {
      const y = 18 + idx * rowH;
      const val = Number(m.stats.avg || 0);
      const w = (val / maxVal) * plotW;
      return `
        <g>
          <text x="${leftPad - 10}" y="${y + 15}" text-anchor="end" font-size="11.5" fill="hsl(216,28%,20%)">${escapeHtml(truncateLabel(m.label, 26))}</text>
          <rect x="${leftPad}" y="${y + 2}" width="${Math.max(2, w).toFixed(1)}" height="18" rx="3" fill="#0D8A5E" />
          <text x="${(leftPad + w + 7).toFixed(1)}" y="${y + 15}" font-size="10.5" font-family="JetBrains Mono, monospace" fill="hsl(215,16%,34%)">${formatMetricNumber(val)} ${escapeHtml(m.unit)}</text>
        </g>`;
    })
    .join("");

  return `
    <div class="chart-panel">
      <div class="chart-header">
        <div>
          <h4 class="chart-title">Throughput &amp; Sequence Overview</h4>
          <p class="chart-subtitle">Aggregate token rates and sequence lengths</p>
        </div>
      </div>
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${width} ${height}">${rows}</svg>
      </div>
    </div>`;
}

function renderSingleRunRecordsPanel(recordsPayload) {
  const host = els.resultsChartsGrid.querySelector('[data-role="single-records-panel"]');
  if (!host) return;

  if (!recordsPayload || !recordsPayload.available || !recordsPayload.records.length) {
    host.remove();
    return;
  }

  const records = recordsPayload.records;
  const candidateMetrics = [
    { tag: "request_latency", label: "Request Latency" },
    { tag: "time_to_first_token", label: "Time to First Token" },
    { tag: "inter_token_latency", label: "Inter Token Latency" },
  ].filter((c) => records.some((r) => typeof r[c.tag] === "number"));

  if (candidateMetrics.length === 0) {
    host.remove();
    return;
  }

  if (!candidateMetrics.some((c) => c.tag === singleHistogramMetricTag)) {
    singleHistogramMetricTag = candidateMetrics[0].tag;
  }

  const unit = recordsPayload.units?.[singleHistogramMetricTag] || "ms";
  const vals = records
    .map((r) => r[singleHistogramMetricTag])
    .filter((v) => typeof v === "number" && Number.isFinite(v));

  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const binCount = Math.min(16, Math.max(6, Math.round(Math.sqrt(vals.length))));
  const span = Math.max(1e-6, maxV - minV);
  const bins = Array.from({ length: binCount }, (_, i) => ({
    lo: minV + (i / binCount) * span,
    hi: minV + ((i + 1) / binCount) * span,
    count: 0,
  }));

  for (const v of vals) {
    const idx = Math.min(binCount - 1, Math.floor(((v - minV) / span) * binCount));
    bins[idx].count += 1;
  }

  const maxBin = Math.max(1, ...bins.map((b) => b.count));
  const w = 520;
  const h = 210;
  const padL = 42;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const barW = plotW / binCount;

  const barsSvg = bins
    .map((b, i) => {
      const bh = (b.count / maxBin) * plotH;
      const x = padL + i * barW + 2;
      const y = padT + plotH - bh;
      const tip = escapeHtml(
        `<strong>${formatMetricNumber(b.lo)} – ${formatMetricNumber(b.hi)} ${escapeHtml(unit)}</strong>` +
          `Requests: <code>${b.count}</code> (${((b.count / vals.length) * 100).toFixed(1)}%)`
      );
      return `<rect class="chart-hit" data-tooltip="${tip}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, barW - 4).toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="2" fill="#1168C6" fill-opacity="0.82" />`;
    })
    .join("");

  // Right chart: Output Sequence Length vs Request Latency scatter (if OSL present, else Request Index vs Metric)
  const hasOsl = records.some((r) => typeof r.output_sequence_length === "number");
  const xField = hasOsl ? "output_sequence_length" : "idx";
  const xLabel = hasOsl ? "Output Sequence Length (tokens)" : "Request Sequence #";
  const pts = records.filter(
    (r) => typeof r[xField] === "number" && typeof r[singleHistogramMetricTag] === "number"
  );
  const minX = Math.min(...pts.map((p) => p[xField]));
  const maxX = Math.max(minX + 1, ...pts.map((p) => p[xField]));
  const minY = 0;
  const maxY = Math.max(1e-6, maxV * 1.08);

  const dotsSvg = pts
    .map((p) => {
      const cx = padL + ((p[xField] - minX) / (maxX - minX)) * plotW;
      const cy = padT + plotH - ((p[singleHistogramMetricTag] - minY) / (maxY - minY)) * plotH;
      const fill = p.error ? "#D6334C" : "#0D8A5E";
      const tip = escapeHtml(
        `<strong>Request #${p.idx}</strong>` +
          `${escapeHtml(xLabel)}: <code>${formatMetricNumber(p[xField])}</code><br/>` +
          `Latency: <code>${formatMetricNumber(p[singleHistogramMetricTag])} ${escapeHtml(unit)}</code>`
      );
      return `<circle class="chart-hit" data-tooltip="${tip}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.3" fill="${fill}" fill-opacity="0.68" />`;
    })
    .join("");

  const selectHtml = candidateMetrics
    .map(
      (c) =>
        `<option value="${escapeHtml(c.tag)}" ${c.tag === singleHistogramMetricTag ? "selected" : ""}>${escapeHtml(c.label)}</option>`
    )
    .join("");

  host.innerHTML = `
    <div class="chart-header">
      <div>
        <h4 class="chart-title">Per-Request Distribution &amp; Token Scaling (${recordsPayload.sampled_records.toLocaleString()} requests)</h4>
        <p class="chart-subtitle">Directly sampled from <code>profile_export.jsonl</code> — latency histogram (left) and ${escapeHtml(xLabel.toLowerCase())} correlation (right)</p>
      </div>
      <label class="inline-control-label">
        Metric
        <select data-role="single-records-metric" class="compact-select">${selectHtml}</select>
      </label>
    </div>
    <div class="charts-grid" style="gap:14px">
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${w} ${h}">
          <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="hsl(214,18%,78%)" />
          <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="hsl(214,18%,78%)" />
          <text x="${padL - 6}" y="${padT + 9}" text-anchor="end" font-size="10" fill="hsl(215,13%,50%)">${maxBin}</text>
          <text x="${padL}" y="${h - 8}" font-size="10" fill="hsl(215,13%,50%)">${formatMetricNumber(minV)} ${escapeHtml(unit)}</text>
          <text x="${w - padR}" y="${h - 8}" text-anchor="end" font-size="10" fill="hsl(215,13%,50%)">${formatMetricNumber(maxV)} ${escapeHtml(unit)}</text>
          ${barsSvg}
        </svg>
      </div>
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${w} ${h}">
          <line x1="${padL}" y1="${padT + plotH}" x2="${w - padR}" y2="${padT + plotH}" stroke="hsl(214,18%,78%)" />
          <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="hsl(214,18%,78%)" />
          <text x="${padL - 6}" y="${padT + 9}" text-anchor="end" font-size="10" fill="hsl(215,13%,50%)">${formatMetricNumber(maxV)}</text>
          <text x="${(padL + w - padR) / 2}" y="${h - 6}" text-anchor="middle" font-size="10" fill="hsl(215,13%,50%)">${escapeHtml(xLabel)}</text>
          ${dotsSvg}
        </svg>
      </div>
    </div>`;

  bindTooltipTargets(host);
  const sel = host.querySelector('[data-role="single-records-metric"]');
  if (sel) {
    sel.addEventListener("change", () => {
      singleHistogramMetricTag = sel.value;
      renderSingleRunRecordsPanel(recordsPayload);
    });
  }
}

/* --- Multi-Run Comparison Charts --- */
function buildGroupedComparisonChartHtml({
  title,
  subtitle,
  metricTags,
  selectedRuns,
  colorMap,
  statKey,
  useStatLabel,
}) {
  // Collect metric descriptors present in at least 1 selected run
  const descriptors = [];
  for (const tag of metricTags) {
    for (const r of selectedRuns) {
      const m = getMetricMap(r).get(tag);
      if (m) {
        descriptors.push({ tag: m.tag, label: m.label, unit: m.unit, hasPercentiles: m.has_percentiles });
        break;
      }
    }
  }

  if (descriptors.length === 0) {
    return `
      <div class="chart-panel">
        <div class="chart-header">
          <div>
            <h4 class="chart-title">${escapeHtml(title)}</h4>
            <p class="chart-subtitle">No matching metrics available across selected runs</p>
          </div>
        </div>
      </div>`;
  }

  const width = 560;
  const leftPad = 175;
  const rightPad = 82;
  const plotW = width - leftPad - rightPad;
  const barH = Math.max(9, Math.min(16, Math.floor(54 / selectedRuns.length)));
  const barGap = 3;
  const groupPad = 14;
  const groupH = selectedRuns.length * (barH + barGap) + groupPad;
  const topPad = 16;
  const bottomPad = 16;
  const height = topPad + descriptors.length * groupH + bottomPad;

  const baselineRun = selectedRuns.find((r) => r.run_id === baselineRunId) || selectedRuns[0];

  const groupsSvg = descriptors
    .map((desc, gIdx) => {
      const groupTop = topPad + gIdx * groupH;
      const values = selectedRuns.map((r) => getRunStat(r, desc.tag, statKey));
      const groupMax = Math.max(1e-6, ...values.map((v) => (v !== null ? v : 0))) * 1.08;
      const baseVal = getRunStat(baselineRun, desc.tag, statKey);

      const bars = selectedRuns
        .map((r, rIdx) => {
          const val = values[rIdx];
          const y = groupTop + rIdx * (barH + barGap);
          const color = colorMap.get(r.run_id) || "#1168C6";
          if (val === null) {
            return `<text x="${leftPad}" y="${y + barH - 1}" font-size="9.5" fill="hsl(215,13%,58%)">N/A</text>`;
          }
          const w = Math.max(2, (val / groupMax) * plotW);
          let deltaStr = "";
          if (r.run_id !== baselineRun.run_id && baseVal !== null && baseVal !== 0) {
            const pct = ((val - baseVal) / Math.abs(baseVal)) * 100;
            deltaStr = `<br/>Δ vs baseline: <code>${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</code>`;
          }
          const tip = escapeHtml(
            `<strong>${escapeHtml(r.run_id)}</strong>` +
              `${escapeHtml(desc.label)}: <code>${formatMetricNumber(val)} ${escapeHtml(desc.unit)}</code>` +
              deltaStr
          );
          return `
            <g class="chart-hit" data-tooltip="${tip}">
              <rect x="${leftPad}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH}" rx="2.5" fill="${color}" />
              <text x="${(leftPad + w + 6).toFixed(1)}" y="${(y + barH - 1.5).toFixed(1)}" font-size="9.8" font-family="JetBrains Mono, monospace" fill="hsl(216,20%,28%)">${formatMetricNumber(val)}</text>
            </g>`;
        })
        .join("");

      const labelY = groupTop + (selectedRuns.length * (barH + barGap)) / 2 + 3;
      const sepLine =
        gIdx < descriptors.length - 1
          ? `<line x1="12" y1="${(groupTop + groupH - groupPad / 2).toFixed(1)}" x2="${width - 12}" y2="${(groupTop + groupH - groupPad / 2).toFixed(1)}" stroke="hsl(214,20%,92%)" />`
          : "";

      return `
        <g>
          <text x="${leftPad - 10}" y="${labelY.toFixed(1)}" text-anchor="end" font-size="11.2" font-weight="500" fill="hsl(216,28%,18%)">${escapeHtml(truncateLabel(desc.label, 24))}</text>
          <text x="${leftPad - 10}" y="${(labelY + 12).toFixed(1)}" text-anchor="end" font-size="9.5" font-family="JetBrains Mono, monospace" fill="hsl(215,13%,52%)">(${escapeHtml(desc.unit)})</text>
          ${bars}
          ${sepLine}
        </g>`;
    })
    .join("");

  const legendHtml = selectedRuns
    .map(
      (r) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${colorMap.get(r.run_id)}"></span>${escapeHtml(truncateLabel(r.run_id, 18))}</span>`
    )
    .join("");

  return `
    <div class="chart-panel">
      <div class="chart-header">
        <div>
          <h4 class="chart-title">${escapeHtml(title)}${useStatLabel ? ` (${escapeHtml(statKey)})` : ""}</h4>
          <p class="chart-subtitle">${escapeHtml(subtitle)}</p>
        </div>
      </div>
      <div class="chart-legend">${legendHtml}</div>
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
          ${groupsSvg}
        </svg>
      </div>
    </div>`;
}

function buildPercentileCurvesOverlayHtml(selectedRuns, colorMap) {
  const candidateLatencyTags = [
    { tag: "time_to_first_token", label: "Time to First Token" },
    { tag: "inter_token_latency", label: "Inter Token Latency" },
    { tag: "request_latency", label: "Request Latency" },
    { tag: "decode_duration", label: "Decode Duration" },
    { tag: "time_to_first_output_token", label: "Time to First Output Token" },
  ].filter((c) =>
    selectedRuns.some((r) => {
      const m = getMetricMap(r).get(c.tag);
      return m && m.has_percentiles;
    })
  );

  if (candidateLatencyTags.length === 0) {
    return "";
  }

  if (!candidateLatencyTags.some((c) => c.tag === percentileCurveMetricTag)) {
    percentileCurveMetricTag = candidateLatencyTags[0].tag;
  }

  let unit = "ms";
  for (const r of selectedRuns) {
    const m = getMetricMap(r).get(percentileCurveMetricTag);
    if (m && m.unit) {
      unit = m.unit;
      break;
    }
  }

  const series = selectedRuns
    .map((r) => {
      const m = getMetricMap(r).get(percentileCurveMetricTag);
      if (!m || !m.has_percentiles) return null;
      const pts = PERCENTILE_STEPS.map((st, idx) => ({
        idx,
        label: st.label,
        val: m.stats[st.key] !== null && m.stats[st.key] !== undefined ? Number(m.stats[st.key]) : null,
      })).filter((p) => p.val !== null);
      return pts.length >= 2 ? { run: r, color: colorMap.get(r.run_id), pts } : null;
    })
    .filter(Boolean);

  const width = 560;
  const height = 250;
  const padL = 56;
  const padR = 22;
  const padT = 18;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const allVals = series.flatMap((s) => s.pts.map((p) => p.val));
  const maxY = Math.max(1e-6, ...(allVals.length ? allVals : [1])) * 1.1;

  const xAt = (stepIdx) =>
    padL + (stepIdx / Math.max(1, PERCENTILE_STEPS.length - 1)) * plotW;
  const yAt = (val) => padT + plotH - (val / maxY) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: padT + plotH - t * plotH,
    val: t * maxY,
  }));

  const gridSvg =
    yTicks
      .map(
        (tk) => `
      <line x1="${padL}" y1="${tk.y.toFixed(1)}" x2="${width - padR}" y2="${tk.y.toFixed(1)}" stroke="hsl(214,20%,91%)" stroke-dasharray="3,3" />
      <text x="${padL - 8}" y="${(tk.y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="hsl(215,13%,50%)">${formatMetricNumber(tk.val)}</text>`
      )
      .join("") +
    PERCENTILE_STEPS.map(
      (st, idx) =>
        `<text x="${xAt(idx).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="10.5" font-family="JetBrains Mono, monospace" fill="hsl(215,16%,38%)">${st.label}</text>`
    ).join("");

  const linesSvg = series
    .map((s) => {
      const pathD = s.pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${xAt(p.idx).toFixed(1)},${yAt(p.val).toFixed(1)}`)
        .join(" ");
      const dots = s.pts
        .map((p) => {
          const tip = escapeHtml(
            `<strong>${escapeHtml(s.run.run_id)}</strong>` +
              `${escapeHtml(p.label)}: <code>${formatMetricNumber(p.val)} ${escapeHtml(unit)}</code>`
          );
          return `<circle class="chart-hit" data-tooltip="${tip}" cx="${xAt(p.idx).toFixed(1)}" cy="${yAt(p.val).toFixed(1)}" r="4" fill="${s.color}" stroke="#ffffff" stroke-width="1.4" />`;
        })
        .join("");
      return `<path d="${pathD}" fill="none" stroke="${s.color}" stroke-width="2.2" />${dots}`;
    })
    .join("");

  const optionsHtml = candidateLatencyTags
    .map(
      (c) =>
        `<option value="${escapeHtml(c.tag)}" ${c.tag === percentileCurveMetricTag ? "selected" : ""}>${escapeHtml(c.label)}</option>`
    )
    .join("");

  return `
    <div class="chart-panel">
      <div class="chart-header">
        <div>
          <h4 class="chart-title">Tail-Latency Percentile Curves (${escapeHtml(unit)})</h4>
          <p class="chart-subtitle">Compare latency escalation from p10 through p99 across runs</p>
        </div>
        <label class="inline-control-label">
          Metric
          <select data-role="percentile-curve-metric" class="compact-select">${optionsHtml}</select>
        </label>
      </div>
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Tail latency percentile curves">
          ${gridSvg}
          ${linesSvg}
        </svg>
      </div>
    </div>`;
}

function buildParetoFrontierChartHtml(selectedRuns, colorMap, statKey) {
  const latCandidates = [
    { tag: "time_to_first_token", label: "Time to First Token" },
    { tag: "inter_token_latency", label: "Inter Token Latency" },
    { tag: "request_latency", label: "Request Latency" },
  ].filter((c) => selectedRuns.some((r) => getRunStat(r, c.tag, statKey) !== null));

  const yTag = selectedRuns.some((r) => getRunStat(r, "output_token_throughput", "avg") !== null)
    ? "output_token_throughput"
    : "request_throughput";
  const yLabel =
    yTag === "output_token_throughput"
      ? "Output Token Throughput (tokens/sec)"
      : "Request Throughput (requests/sec)";

  if (latCandidates.length === 0) {
    return "";
  }
  if (!latCandidates.some((c) => c.tag === paretoLatencyMetricTag)) {
    paretoLatencyMetricTag = latCandidates[0].tag;
  }

  const activeLatObj = latCandidates.find((c) => c.tag === paretoLatencyMetricTag) || latCandidates[0];
  const points = selectedRuns
    .map((r) => {
      const x = getRunStat(r, activeLatObj.tag, statKey);
      const y = getRunStat(r, yTag, "avg");
      if (x === null || y === null) return null;
      return { run: r, x, y, color: colorMap.get(r.run_id) };
    })
    .filter(Boolean);

  if (points.length === 0) return "";

  // Compute Pareto frontier: lower X (latency) and higher Y (throughput) is better
  const sortedByX = [...points].sort((a, b) => a.x - b.x || b.y - a.y);
  const frontier = [];
  let maxThroughputSoFar = -Infinity;
  for (const pt of sortedByX) {
    if (pt.y > maxThroughputSoFar) {
      frontier.push(pt);
      maxThroughputSoFar = pt.y;
    }
  }

  const width = 560;
  const height = 250;
  const padL = 58;
  const padR = 30;
  const padT = 20;
  const padB = 38;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const minX = Math.min(...points.map((p) => p.x)) * 0.85;
  const maxX = Math.max(minX + 1e-3, Math.max(...points.map((p) => p.x)) * 1.12);
  const minY = 0;
  const maxY = Math.max(1e-3, Math.max(...points.map((p) => p.y)) * 1.15);

  const scaleX = (v) => padL + ((v - minX) / (maxX - minX)) * plotW;
  const scaleY = (v) => padT + plotH - ((v - minY) / (maxY - minY)) * plotH;

  const frontierSvg =
    frontier.length >= 2
      ? `<path d="${frontier
          .map((p, i) => `${i === 0 ? "M" : "L"}${scaleX(p.x).toFixed(1)},${scaleY(p.y).toFixed(1)}`)
          .join(" ")}" fill="none" stroke="#0D8A5E" stroke-width="1.8" stroke-dasharray="5,4" />`
      : "";

  const xTicks = [0, 0.5, 1].map((t) => ({
    x: padL + t * plotW,
    val: minX + t * (maxX - minX),
  }));
  const yTicks = [0, 0.5, 1].map((t) => ({
    y: padT + plotH - t * plotH,
    val: minY + t * (maxY - minY),
  }));

  const axesSvg =
    yTicks
      .map(
        (tk) => `
      <line x1="${padL}" y1="${tk.y.toFixed(1)}" x2="${width - padR}" y2="${tk.y.toFixed(1)}" stroke="hsl(214,20%,91%)" stroke-dasharray="3,3" />
      <text x="${padL - 8}" y="${(tk.y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="hsl(215,13%,50%)">${formatMetricNumber(tk.val)}</text>`
      )
      .join("") +
    xTicks
      .map(
        (tk) =>
          `<text x="${tk.x.toFixed(1)}" y="${height - 18}" text-anchor="middle" font-size="10" fill="hsl(215,13%,50%)">${formatMetricNumber(tk.val)} ms</text>`
      )
      .join("") +
    `<text x="${(padL + width - padR) / 2}" y="${height - 4}" text-anchor="middle" font-size="10.5" fill="hsl(215,16%,38%)">${escapeHtml(activeLatObj.label)} (${escapeHtml(statKey)}, lower is better → left)</text>`;

  const dotsSvg = points
    .map((p) => {
      const cx = scaleX(p.x);
      const cy = scaleY(p.y);
      const isOptimal = frontier.includes(p);
      const concStr =
        p.run.concurrency !== null && p.run.concurrency !== undefined
          ? ` (c=${p.run.concurrency})`
          : "";
      const tip = escapeHtml(
        `<strong>${escapeHtml(p.run.run_id)}${escapeHtml(concStr)}${isOptimal ? " ★ Pareto Optimal" : ""}</strong>` +
          `${escapeHtml(activeLatObj.label)} (${escapeHtml(statKey)}): <code>${formatMetricNumber(p.x)} ms</code><br/>` +
          `${escapeHtml(yLabel)}: <code>${formatMetricNumber(p.y)}</code>`
      );
      return `
        <g class="chart-hit" data-tooltip="${tip}">
          ${isOptimal ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="9" fill="${p.color}" fill-opacity="0.16" />` : ""}
          <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5.5" fill="${p.color}" stroke="#ffffff" stroke-width="1.6" />
          <text x="${(cx + 8).toFixed(1)}" y="${(cy + 3.5).toFixed(1)}" font-size="10" font-family="JetBrains Mono, monospace" fill="hsl(216,24%,22%)">${escapeHtml(truncateLabel(p.run.run_id, 15))}</text>
        </g>`;
    })
    .join("");

  const optionsHtml = latCandidates
    .map(
      (c) =>
        `<option value="${escapeHtml(c.tag)}" ${c.tag === paretoLatencyMetricTag ? "selected" : ""}>${escapeHtml(c.label)}</option>`
    )
    .join("");

  return `
    <div class="chart-panel">
      <div class="chart-header">
        <div>
          <h4 class="chart-title">Throughput vs. Latency Frontier</h4>
          <p class="chart-subtitle">Y: ${escapeHtml(yLabel)} · Dashed line marks Pareto-optimal runs</p>
        </div>
        <label class="inline-control-label">
          X-Axis
          <select data-role="pareto-latency-metric" class="compact-select">${optionsHtml}</select>
        </label>
      </div>
      <div class="svg-chart-wrap">
        <svg class="svg-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Throughput vs Latency scatter chart">
          ${axesSvg}
          ${frontierSvg}
          ${dotsSvg}
        </svg>
      </div>
    </div>`;
}

function renderChartsSection(selectedRuns, colorMap, statKey) {
  if (selectedRuns.length === 1) {
    const run = selectedRuns[0];
    const color = colorMap.get(run.run_id) || "#1168C6";
    const recordsPanelPlaceholder = run.has_records_jsonl
      ? `<div data-role="single-records-panel" class="chart-panel full-span"><p class="chart-subtitle">Loading per-request records...</p></div>`
      : "";

    els.resultsChartsGrid.innerHTML =
      buildSingleRunPercentileChartHtml(run, color) +
      buildSingleRunCompositionAndThroughputHtml(run) +
      recordsPanelPlaceholder;

    bindTooltipTargets(els.resultsChartsGrid);

    if (run.has_records_jsonl) {
      if (runRecordsCache.has(run.run_id)) {
        renderSingleRunRecordsPanel(runRecordsCache.get(run.run_id));
      } else {
        fetch(`/api/artifact-runs/records?run_id=${encodeURIComponent(run.run_id)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (payload) {
              runRecordsCache.set(run.run_id, payload);
              renderSingleRunRecordsPanel(payload);
            }
          })
          .catch(() => {});
      }
    }
    return;
  }

  // Multi-run charts
  const latencyComparisonHtml = buildGroupedComparisonChartHtml({
    title: "Latency Comparison",
    subtitle: "Lower is better — comparing selected runs side-by-side",
    metricTags: [
      "time_to_first_token",
      "time_to_first_output_token",
      "inter_token_latency",
      "decode_duration",
      "request_latency",
    ],
    selectedRuns,
    colorMap,
    statKey,
    useStatLabel: true,
  });

  const throughputComparisonHtml = buildGroupedComparisonChartHtml({
    title: "Throughput Comparison",
    subtitle: "Higher is better — system & per-user token/request rates",
    metricTags: [
      "output_token_throughput",
      "output_token_throughput_per_user",
      "e2e_output_token_throughput",
      "input_token_throughput",
      "request_throughput",
    ],
    selectedRuns,
    colorMap,
    statKey: "avg",
    useStatLabel: false,
  });

  const curvesHtml = buildPercentileCurvesOverlayHtml(selectedRuns, colorMap);
  const paretoHtml = buildParetoFrontierChartHtml(selectedRuns, colorMap, statKey);

  els.resultsChartsGrid.innerHTML =
    latencyComparisonHtml + throughputComparisonHtml + curvesHtml + paretoHtml;

  bindTooltipTargets(els.resultsChartsGrid);

  const curveSel = els.resultsChartsGrid.querySelector('[data-role="percentile-curve-metric"]');
  if (curveSel) {
    curveSel.addEventListener("change", () => {
      percentileCurveMetricTag = curveSel.value;
      renderChartsSection(selectedRuns, colorMap, statKey);
    });
  }

  const paretoSel = els.resultsChartsGrid.querySelector('[data-role="pareto-latency-metric"]');
  if (paretoSel) {
    paretoSel.addEventListener("change", () => {
      paretoLatencyMetricTag = paretoSel.value;
      renderChartsSection(selectedRuns, colorMap, statKey);
    });
  }
}

/* --- Unified Union of Metrics & Side-by-Side Comparison Table --- */
function collectUnionMetrics(selectedRuns) {
  const byTag = new Map();
  for (const r of selectedRuns) {
    for (const m of r.metrics || []) {
      if (!byTag.has(m.tag)) {
        byTag.set(m.tag, {
          tag: m.tag,
          label: m.label,
          unit: m.unit,
          category: m.category,
          larger_is_better: m.larger_is_better,
          has_percentiles: m.has_percentiles,
          priority: m.priority ?? 500,
        });
      } else if (m.has_percentiles) {
        byTag.get(m.tag).has_percentiles = true;
      }
    }
  }
  const list = [...byTag.values()].sort(
    (a, b) => a.priority - b.priority || a.label.localeCompare(b.label)
  );
  if (activeMetricCategory === "all") return list;
  return list.filter((m) => m.category === activeMetricCategory);
}

function renderComparisonTable(selectedRuns, colorMap, statKey) {
  const metricsList = collectUnionMetrics(selectedRuns);

  if (selectedRuns.length === 1) {
    const run = selectedRuns[0];
    els.comparisonTableTitle.textContent = `Detailed Metrics — ${run.run_id}`;
    const mMap = getMetricMap(run);

    const rowsHtml = metricsList
      .map((meta) => {
        const m = mMap.get(meta.tag);
        const s = m ? m.stats : {};
        return `
          <tr>
            <td>
              <span class="metric-cell-title">${escapeHtml(meta.label)}</span>
              <span class="metric-cell-unit">(${escapeHtml(meta.unit)})</span>
            </td>
            <td class="val-primary">${formatMetricNumber(s.avg)}</td>
            <td>${formatMetricNumber(s.p50)}</td>
            <td>${formatMetricNumber(s.p90)}</td>
            <td>${formatMetricNumber(s.p95)}</td>
            <td>${formatMetricNumber(s.p99)}</td>
            <td>${formatMetricNumber(s.min)}</td>
            <td>${formatMetricNumber(s.max)}</td>
            <td>${formatMetricNumber(s.std)}</td>
          </tr>`;
      })
      .join("");

    els.comparisonTableWrapper.innerHTML = `
      <table class="comparison-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th>Avg</th>
            <th>p50</th>
            <th>p90</th>
            <th>p95</th>
            <th>p99</th>
            <th>Min</th>
            <th>Max</th>
            <th>Std Dev</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
    return;
  }

  // Multi-run side-by-side comparison table
  els.comparisonTableTitle.textContent = `Side-by-Side Comparison (${selectedRuns.length} Runs · Primary Stat: ${statKey})`;
  const baselineRun = selectedRuns.find((r) => r.run_id === baselineRunId) || selectedRuns[0];

  const colHeadersHtml = selectedRuns
    .map((r) => {
      const swatch = colorMap.get(r.run_id) || "#1168C6";
      const subParts = [];
      if (r.backend?.id) subParts.push(r.backend.id);
      if (r.model) subParts.push(truncateLabel(r.model, 20));
      if (r.concurrency !== null && r.concurrency !== undefined) subParts.push(`c=${r.concurrency}`);
      if (r.run_id === baselineRun.run_id) subParts.push("baseline");
      return `
        <th>
          <div class="col-run-header">
            <span class="col-run-title">
              <span class="legend-swatch" style="background:${swatch};border-radius:50%"></span>
              ${escapeHtml(r.run_id)}
            </span>
            <span class="col-run-sub">${escapeHtml(subParts.join(" · ") || "run")}</span>
          </div>
        </th>`;
    })
    .join("");

  const rowsHtml = metricsList
    .map((meta) => {
      const rowValues = selectedRuns.map((r) => getRunStat(r, meta.tag, statKey));
      const finiteVals = rowValues.filter((v) => v !== null);
      let bestVal = null;
      if (finiteVals.length >= 2 && meta.larger_is_better !== null) {
        bestVal = meta.larger_is_better
          ? Math.max(...finiteVals)
          : Math.min(...finiteVals);
      }

      const baseVal = getRunStat(baselineRun, meta.tag, statKey);
      const polarityArrow =
        meta.larger_is_better === true
          ? "↑ higher better"
          : meta.larger_is_better === false
          ? "↓ lower better"
          : "";

      const cellsHtml = selectedRuns
        .map((r, idx) => {
          const v = rowValues[idx];
          if (v === null) {
            return `<td>—</td>`;
          }
          const isBest =
            bestVal !== null && Math.abs(v - bestVal) < 1e-9;
          let deltaHtml = "";
          if (r.run_id !== baselineRun.run_id && baseVal !== null && baseVal !== 0) {
            const pct = ((v - baseVal) / Math.abs(baseVal)) * 100;
            if (Math.abs(pct) >= 0.05) {
              let cls = "delta-neutral";
              if (meta.larger_is_better === true) {
                cls = pct > 0 ? "delta-better" : "delta-worse";
              } else if (meta.larger_is_better === false) {
                cls = pct < 0 ? "delta-better" : "delta-worse";
              }
              deltaHtml = `<span class="delta-badge ${cls}">${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
            }
          }

          const m = getMetricMap(r).get(meta.tag);
          let subHtml = "";
          if (m && m.has_percentiles) {
            const p50s = formatMetricNumber(m.stats.p50);
            const p99s = formatMetricNumber(m.stats.p99);
            subHtml = `<span class="val-sub">p50 ${p50s} · p99 ${p99s}</span>`;
          }

          return `
            <td>
              <span class="val-primary ${isBest ? "val-best" : ""}">${formatMetricNumber(v)}</span>${deltaHtml}
              ${subHtml}
            </td>`;
        })
        .join("");

      return `
        <tr>
          <td>
            <span class="metric-cell-title">${escapeHtml(meta.label)}</span>
            <span class="metric-cell-unit">(${escapeHtml(meta.unit)})</span>
            ${polarityArrow ? `<span class="polarity-hint">${polarityArrow}</span>` : ""}
          </td>
          ${cellsHtml}
        </tr>`;
    })
    .join("");

  els.comparisonTableWrapper.innerHTML = `
    <table class="comparison-table">
      <thead>
        <tr>
          <th>Metric</th>
          ${colHeadersHtml}
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function renderPastRunsTab() {
  hideChartTooltip();
  renderRunSelectorList();

  const validRuns = pastArtifactRuns.filter((r) => r.has_metrics);
  const selectedRuns = getSelectedRunsOrdered();

  if (validRuns.length === 0) {
    els.resultsAnalysisWorkspace.classList.add("hidden");
    els.resultsEmptyState.classList.remove("hidden");
    if (pastArtifactRuns.length > 0) {
      els.resultsEmptyTitle.textContent = "No exported metrics found in existing artifact folder(s)";
      els.resultsEmptySubtitle.textContent =
        "The folder(s) above only contain logs because AIPerf was stopped or failed before exporting profile_export_aiperf.json. Run a benchmark to completion to unlock charts and side-by-side comparison.";
    } else {
      els.resultsEmptyTitle.textContent = "No benchmark runs in artifacts/ yet";
      els.resultsEmptySubtitle.textContent =
        "Run an AIPerf benchmark from the Configuration tab (or place exported AIPerf run folders inside artifacts/) to analyze and compare metrics here.";
    }
    return;
  }

  if (selectedRuns.length === 0) {
    els.resultsAnalysisWorkspace.classList.add("hidden");
    els.resultsEmptyState.classList.remove("hidden");
    els.resultsEmptyTitle.textContent = "Select one or more runs above";
    els.resultsEmptySubtitle.textContent =
      "Check a single run for detailed percentile & request-distribution charts, or check multiple runs for side-by-side comparison and Pareto frontier analysis.";
    return;
  }

  els.resultsEmptyState.classList.add("hidden");
  els.resultsAnalysisWorkspace.classList.remove("hidden");

  syncBaselineDropdown(selectedRuns);
  const colorMap = getRunColorMap(selectedRuns);
  const statKey = els.comparisonStatSelect.value || "avg";

  if (selectedRuns.length === 1) {
    const r = selectedRuns[0];
    els.analysisModeBadge.textContent = "Single-Run Analysis";
    const metaBits = [r.run_id, r.model, r.concurrency ? `concurrency ${r.concurrency}` : null, r.dataset].filter(Boolean);
    els.analysisSelectionSummary.textContent = metaBits.join(" · ");
  } else {
    els.analysisModeBadge.textContent = `Comparing ${selectedRuns.length} Runs`;
    els.analysisSelectionSummary.textContent = `Baseline: ${baselineRunId}`;
  }

  renderKpiStrip(selectedRuns, colorMap, statKey);
  renderChartsSection(selectedRuns, colorMap, statKey);
  renderComparisonTable(selectedRuns, colorMap, statKey);
}

function exportComparisonCsv() {
  const selectedRuns = getSelectedRunsOrdered();
  if (selectedRuns.length === 0) return;

  const statKey = els.comparisonStatSelect.value || "avg";
  const metricsList = collectUnionMetrics(selectedRuns);
  const csvEscape = (val) => {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [];
  if (selectedRuns.length === 1) {
    const r = selectedRuns[0];
    const mMap = getMetricMap(r);
    lines.push(["Metric", "Unit", "Avg", "p50", "p90", "p95", "p99", "Min", "Max", "Std"].join(","));
    for (const meta of metricsList) {
      const s = mMap.get(meta.tag)?.stats || {};
      lines.push(
        [
          csvEscape(meta.label),
          csvEscape(meta.unit),
          s.avg ?? "",
          s.p50 ?? "",
          s.p90 ?? "",
          s.p95 ?? "",
          s.p99 ?? "",
          s.min ?? "",
          s.max ?? "",
          s.std ?? "",
        ].join(",")
      );
    }
  } else {
    lines.push(
      ["Metric", "Unit", "Statistic", ...selectedRuns.map((r) => csvEscape(r.run_id))].join(",")
    );
    for (const meta of metricsList) {
      const usedStat = meta.has_percentiles ? statKey : "avg";
      lines.push(
        [
          csvEscape(meta.label),
          csvEscape(meta.unit),
          usedStat,
          ...selectedRuns.map((r) => {
            const v = getRunStat(r, meta.tag, statKey);
            return v === null ? "" : v;
          }),
        ].join(",")
      );
    }
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    selectedRuns.length === 1
      ? `${selectedRuns[0].run_id}_metrics.csv`
      : `geap_aiperf_comparison_${statKey}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* --- Event Listeners & Init --- */
els.tabBtnConfig.addEventListener("click", () => switchTab("config"));
els.tabBtnOutput.addEventListener("click", () => switchTab("output"));
els.tabBtnResults.addEventListener("click", () => switchTab("results"));

const orderedTabBtns = [els.tabBtnConfig, els.tabBtnOutput, els.tabBtnResults];
orderedTabBtns.forEach((tabEl, idx) => {
  tabEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const nextIdx = (idx + delta + orderedTabBtns.length) % orderedTabBtns.length;
      const names = ["config", "output", "results"];
      switchTab(names[nextIdx]);
      orderedTabBtns[nextIdx].focus();
    }
  });
});

els.pastRunsSearchInput.addEventListener("input", () => renderRunSelectorList());

els.selectLatestRunBtn.addEventListener("click", () => {
  const valid = pastArtifactRuns.filter((r) => r.has_metrics);
  selectedArtifactRunIds.clear();
  if (valid.length > 0) {
    selectedArtifactRunIds.add(valid[0].run_id);
  }
  renderPastRunsTab();
});

els.selectAllRunsBtn.addEventListener("click", () => {
  for (const r of getFilteredRunsWithMetrics()) {
    selectedArtifactRunIds.add(r.run_id);
  }
  renderPastRunsTab();
});

els.clearRunsSelectionBtn.addEventListener("click", () => {
  selectedArtifactRunIds.clear();
  renderPastRunsTab();
});

els.refreshPastRunsBtn.addEventListener("click", () => {
  loadPastArtifactRuns(true);
});

els.comparisonStatSelect.addEventListener("change", () => renderPastRunsTab());

els.baselineRunSelect.addEventListener("change", () => {
  baselineRunId = els.baselineRunSelect.value;
  renderPastRunsTab();
});

els.exportComparisonCsvBtn.addEventListener("click", exportComparisonCsv);

els.metricCategoryFilters.querySelectorAll(".category-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    activeMetricCategory = pill.dataset.category || "all";
    els.metricCategoryFilters.querySelectorAll(".category-pill").forEach((p) => {
      p.classList.toggle("active", p === pill);
    });
    const selectedRuns = getSelectedRunsOrdered();
    if (selectedRuns.length > 0) {
      renderComparisonTable(
        selectedRuns,
        getRunColorMap(selectedRuns),
        els.comparisonStatSelect.value || "avg"
      );
    }
  });
});

els.googleSigninBtn.addEventListener("click", startBrowserGoogleSignIn);
els.verifyTokenBtn.addEventListener("click", verifyLiveToken);

els.toggleHfTokenBtn.addEventListener("click", () => {
  const isMasked = els.hfTokenInput.type === "password";
  els.hfTokenInput.type = isMasked ? "text" : "password";
  els.toggleHfTokenBtn.textContent = isMasked ? "Hide" : "Show";
});

els.backendSelect.addEventListener("change", () => {
  const val = els.backendSelect.value;
  if (val) {
    localStorage.setItem("vertex_aiperf_backend", val);
  } else {
    localStorage.removeItem("vertex_aiperf_backend");
  }
  if (!detectedDeploymentMeta || detectedDeploymentMeta.backend_id !== val) {
    setBackendDetectStatus("", "");
  }
  renderSelectedBackendSpecs();
});

els.detectBackendBtn.addEventListener("click", () => {
  autoDetectBackendFromEndpoint(true);
});

els.clearBackendBtn.addEventListener("click", () => {
  els.backendSelect.value = "";
  detectedDeploymentMeta = null;
  localStorage.removeItem("vertex_aiperf_backend");
  setBackendDetectStatus("", "");
  renderSelectedBackendSpecs();
});

els.loadExampleBtn.addEventListener("click", () => {
  els.cmdInput.value = EXAMPLE_VERTEX_COMMAND;
  validateCommand();
});

els.clearCmdBtn.addEventListener("click", () => {
  els.cmdInput.value = "";
  validateCommand();
});

els.cmdInput.addEventListener("input", debounce(validateCommand, 320));
els.startRunBtn.addEventListener("click", startBenchmark);
els.stopRunBtn.addEventListener("click", stopBenchmark);
els.stopRunOutputBtn.addEventListener("click", stopBenchmark);
els.copyCliBtn.addEventListener("click", copyCliEquivalent);

els.copyLogsBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(els.terminalOutput.textContent || "").then(() => {
    const orig = els.copyLogsBtn.textContent;
    els.copyLogsBtn.textContent = "Copied";
    setTimeout(() => {
      els.copyLogsBtn.textContent = orig;
    }, 1400);
  });
});

(function init() {
  localStorage.removeItem("vertex_aiperf_sa");
  localStorage.removeItem("vertex_aiperf_quota_project");
  const savedCmd = localStorage.getItem("vertex_aiperf_cmd");
  const savedRunName = localStorage.getItem("vertex_aiperf_run_name");
  els.cmdInput.value = savedCmd || EXAMPLE_VERTEX_COMMAND;
  if (savedRunName) {
    els.runNameInput.value = savedRunName;
  }
  switchTab("config");
  refreshAuthStatus();
  loadBackendsCatalog();
  validateCommand();
  loadPastArtifactRuns(false);
  refreshHistory().then(async () => {
    const resp = await fetch("/api/runs").catch(() => null);
    if (!resp || !resp.ok) return;
    const { runs } = await resp.json();
    const running = (runs || []).find(
      (r) => r.status === "starting" || r.status === "running"
    );
    if (running) {
      loadRunDetails(running.run_id, true);
    }
  });
})();
