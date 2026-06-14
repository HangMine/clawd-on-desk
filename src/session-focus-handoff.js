"use strict";

const http = require("http");

const EDITOR_FOCUS_PORT_BASE = 23456;
const EDITOR_FOCUS_PORT_RANGE = 5;
const EDITOR_FOCUS_TIMEOUT_MS = 400;

function sanitizeFocusError(err) {
  if (typeof err === "string" && err) return err.replace(/[\r\n\t]+/g, " ");
  return err && err.message ? err.message.replace(/[\r\n\t]+/g, " ") : "unknown";
}

function normalizeEditor(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "code" || text === "cursor" ? text : null;
}

function buildCodexEditorUriPayload(focusEntry, sessionId) {
  const editor = normalizeEditor(focusEntry && focusEntry.editor) || "code";
  const pids = Array.isArray(focusEntry && focusEntry.pidChain)
    ? focusEntry.pidChain.filter((pid) => Number.isFinite(pid) && pid > 0)
    : [];
  if (focusEntry && Number.isFinite(focusEntry.sourcePid) && focusEntry.sourcePid > 0 && !pids.includes(focusEntry.sourcePid)) {
    pids.push(focusEntry.sourcePid);
  }
  const params = new URLSearchParams();
  params.set("action", "focus-codex");
  params.set("editor", editor);
  params.set("sessionId", String(sessionId || (focusEntry && focusEntry.id) || ""));
  if (focusEntry && typeof focusEntry.cwd === "string" && focusEntry.cwd) params.set("cwd", focusEntry.cwd);
  if (pids.length) params.set("pids", pids.join(","));
  return { editor, params };
}

async function requestCodexEditorUriFocus(shell, focusEntry, sessionId) {
  if (!shell || typeof shell.openExternal !== "function") {
    return { ok: false, reason: "shell-openExternal-missing" };
  }
  const { params } = buildCodexEditorUriPayload(focusEntry, sessionId);
  const schemes = ["vscode-insiders", "vscode"];
  for (const scheme of schemes) {
    const url = `${scheme}://clawd.clawd-terminal-focus?${params.toString()}`;
    try {
      await shell.openExternal(url);
      return { ok: true, scheme };
    } catch {}
  }
  return { ok: false, reason: "uri-open-failed" };
}

function postEditorFocusRequest(port, path, body, timeoutMs = EDITOR_FOCUS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let parsed = null;
        if (raw.trim()) {
          try { parsed = JSON.parse(raw); } catch {}
        }
        resolve({
          ok: res.statusCode === 200,
          statusCode: res.statusCode || 0,
          body: parsed,
        });
      });
    });
    req.on("error", (err) => resolve({
      ok: false,
      statusCode: 0,
      error: err,
    }));
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.end(payload);
  });
}

async function requestCodexEditorFocus(focusEntry, sessionId) {
  const editor = normalizeEditor(focusEntry && focusEntry.editor);
  const pids = Array.isArray(focusEntry && focusEntry.pidChain)
    ? focusEntry.pidChain.filter((pid) => Number.isFinite(pid) && pid > 0)
    : [];
  if (focusEntry && Number.isFinite(focusEntry.sourcePid) && focusEntry.sourcePid > 0 && !pids.includes(focusEntry.sourcePid)) {
    pids.push(focusEntry.sourcePid);
  }
  const body = {
    editor,
    cwd: focusEntry && typeof focusEntry.cwd === "string" ? focusEntry.cwd : "",
    pids,
    sessionId: String(sessionId || (focusEntry && focusEntry.id) || ""),
  };
  const attempts = [];
  for (let port = EDITOR_FOCUS_PORT_BASE; port < EDITOR_FOCUS_PORT_BASE + EDITOR_FOCUS_PORT_RANGE; port++) {
    attempts.push(postEditorFocusRequest(port, "/focus-codex", body));
  }
  const results = await Promise.all(attempts);
  const success = results.find((result) => result && result.ok);
  if (success) {
    return {
      ok: true,
      match: success.body && success.body.match ? success.body.match : "unknown",
      command: success.body && success.body.command ? success.body.command : null,
    };
  }
  const bestFailure = results.find((result) => result && result.statusCode >= 400 && result.statusCode < 500 && result.statusCode !== 404)
    || results.find((result) => result && result.statusCode >= 500)
    || null;
  return {
    ok: false,
    statusCode: bestFailure ? bestFailure.statusCode : 0,
    reason: bestFailure && bestFailure.body && typeof bestFailure.body.reason === "string"
      ? bestFailure.body.reason
      : (bestFailure && bestFailure.error ? sanitizeFocusError(bestFailure.error) : "not-found"),
  };
}

function focusCodexThreadTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  if (!url || !shell || typeof shell.openExternal !== "function") return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=codex-thread`);
  return shell.openExternal(url)
    .then(() => {
      focusLog(`focus result branch=codex-thread reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=codex-thread reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      if (!focusTerminalSession(focusEntry, id, requestSource)) {
        focusLog(`focus result branch=none reason=codex-thread-fallback-no-source-pid source=${requestSource} sid=${id}`);
      }
    });
}

function focusCodexEditorTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  focusLog = () => {},
  requestEditorFocus = requestCodexEditorFocus,
  requestEditorUriFocus = requestCodexEditorUriFocus,
  focusEditorSessionWindow = () => false,
  focusTerminalSession = () => false,
}) {
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  const editor = normalizeEditor(focusEntry && focusEntry.editor);
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=codex-editor editor=${editor || "-"}`);
  return Promise.resolve(requestEditorFocus(focusEntry, id))
    .then((result) => {
      if (result && result.ok) {
        focusLog(`focus result branch=codex-editor reason=opened source=${requestSource} sid=${id} match=${result.match || "unknown"} command=${result.command || "-"}`);
        if (!focusEditorSessionWindow(focusEntry, id, requestSource) && !focusTerminalSession(focusEntry, id, requestSource)) {
          focusLog(`focus result branch=none reason=codex-editor-window-focus-missing source=${requestSource} sid=${id}`);
        }
        return true;
      }
      focusLog(`focus result branch=codex-editor reason=bridge-miss source=${requestSource} sid=${id} detail=${sanitizeFocusError(result && result.reason)}`);
      return Promise.resolve(requestEditorUriFocus(shell, focusEntry, id))
        .then((uriResult) => {
          if (uriResult && uriResult.ok) {
            focusLog(`focus result branch=codex-editor reason=uri-opened source=${requestSource} sid=${id} scheme=${uriResult.scheme || "-"}`);
            if (!focusEditorSessionWindow(focusEntry, id, requestSource) && !focusTerminalSession(focusEntry, id, requestSource)) {
              focusLog(`focus result branch=none reason=codex-editor-window-focus-missing source=${requestSource} sid=${id}`);
            }
            return false;
          }
          if (!focusTerminalSession(focusEntry, id, requestSource)) {
            focusLog(`focus result branch=none reason=codex-editor-fallback-no-source-pid source=${requestSource} sid=${id}`);
          }
          return false;
        });
    })
    .catch((err) => {
      focusLog(`focus result branch=codex-editor reason=bridge-error source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      if (!focusTerminalSession(focusEntry, id, requestSource)) {
        focusLog(`focus result branch=none reason=codex-editor-fallback-no-source-pid source=${requestSource} sid=${id}`);
      }
      return false;
    });
}

module.exports = {
  focusCodexEditorTarget,
  focusCodexThreadTarget,
  requestCodexEditorFocus,
  sanitizeFocusError,
};
