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

const els = {
  googleSigninBtn: document.getElementById("google-signin-btn"),
  googleSigninLabel: document.getElementById("google-signin-label"),
  verifyTokenBtn: document.getElementById("verify-token-btn"),
  verifyTokenLabel: document.getElementById("verify-token-label"),
  tokenValidityCaption: document.getElementById("token-validity-caption"),

  tabBtnConfig: document.getElementById("tab-btn-config"),
  tabBtnOutput: document.getElementById("tab-btn-output"),
  tabPanelConfig: document.getElementById("tab-panel-config"),
  tabPanelOutput: document.getElementById("tab-panel-output"),

  cmdInput: document.getElementById("aiperf-cmd-input"),
  loadExampleBtn: document.getElementById("load-example-btn"),
  clearCmdBtn: document.getElementById("clear-cmd-btn"),
  cmdValidationBar: document.getElementById("cmd-validation-bar"),
  cmdMetaTags: document.getElementById("cmd-meta-tags"),
  cmdNotesList: document.getElementById("cmd-notes-list"),

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
};

let activeRunId = null;
let eventSource = null;
let elapsedTimer = null;
let runStartedEpochMs = null;
let terminalLines = [];
let tokenExpiryEpochMs = null;
let tokenCountdownTimer = null;

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

/* --- Multi-Tab Switching --- */
function switchTab(tabName) {
  const showConfig = tabName === "config";

  els.tabBtnConfig.classList.toggle("active", showConfig);
  els.tabBtnConfig.setAttribute("aria-selected", showConfig ? "true" : "false");
  els.tabBtnConfig.setAttribute("tabindex", showConfig ? "0" : "-1");
  els.tabPanelConfig.classList.toggle("hidden", !showConfig);
  els.tabPanelConfig.hidden = !showConfig;

  els.tabBtnOutput.classList.toggle("active", !showConfig);
  els.tabBtnOutput.setAttribute("aria-selected", !showConfig ? "true" : "false");
  els.tabBtnOutput.setAttribute("tabindex", !showConfig ? "0" : "-1");
  els.tabPanelOutput.classList.toggle("hidden", showConfig);
  els.tabPanelOutput.hidden = showConfig;

  if (!showConfig && els.autoscrollToggle && els.autoscrollToggle.checked) {
    els.terminalOutput.scrollTop = els.terminalOutput.scrollHeight;
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
  // Force reflow so repeat clicks re-trigger animation
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
      refreshAuthStatus();
    } else {
      setTokenVisualState(false, "Sign-in cancelled");
    }
  }
});

/* --- Command Validation --- */
async function validateCommand() {
  const raw = els.cmdInput.value.trim();

  if (!raw) {
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

  if (!isActive) {
    stopElapsedClock();
    renderArtifacts(job);
    refreshHistory();
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
  const runName = els.runNameInput.value.trim() || null;
  const hfToken = els.hfTokenInput.value.trim() || null;
  const authMode = getSelectedAuthMode();

  if (!command) {
    els.errorBanner.textContent = "Please enter an AIPerf CLI command.";
    els.errorBanner.classList.remove("hidden");
    return;
  }

  localStorage.setItem("vertex_aiperf_cmd", command);
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
        run_name: runName,
        hf_token: hfToken,
        auth_mode: authMode,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.detail || "Failed to start benchmark run.");
    }

    refreshAuthStatus();
    switchTab("output");
    startElapsedClock(data.job.created_at);
    connectStream(data.run_id);
    refreshHistory();
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

async function refreshHistory() {
  try {
    const resp = await fetch("/api/runs");
    if (!resp.ok) return;
    const { runs } = await resp.json();
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
  } catch {
    // Ignore
  }
}

function copyCliEquivalent() {
  const cmd = els.cmdInput.value.trim() || "aiperf profile ...";
  const runName = els.runNameInput.value.trim();
  const hasHf = Boolean(els.hfTokenInput.value.trim());
  const mode = getSelectedAuthMode();
  const escapedCmd = cmd.replace(/'/g, "'\\''");
  const modeFlag = mode === "proxy" ? " --auth-mode proxy" : "";
  const nameFlag = runName
    ? ` --run-name '${runName.replace(/'/g, "'\\''")}'`
    : "";
  const hfFlag = hasHf ? ' --hf-token "$HF_TOKEN"' : "";
  const full = `.venv/bin/python app.py --cli${modeFlag}${nameFlag}${hfFlag} --cmd '${escapedCmd}'`;
  navigator.clipboard.writeText(full).then(() => {
    const orig = els.copyCliBtn.textContent;
    els.copyCliBtn.textContent = "Copied CLI Command";
    setTimeout(() => {
      els.copyCliBtn.textContent = orig;
    }, 1600);
  });
}

/* --- Event Listeners & Init --- */
els.tabBtnConfig.addEventListener("click", () => switchTab("config"));
els.tabBtnOutput.addEventListener("click", () => switchTab("output"));

[els.tabBtnConfig, els.tabBtnOutput].forEach((tabEl) => {
  tabEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = tabEl === els.tabBtnConfig ? "output" : "config";
      switchTab(next);
      (next === "config" ? els.tabBtnConfig : els.tabBtnOutput).focus();
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
  validateCommand();
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
