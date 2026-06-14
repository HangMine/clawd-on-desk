const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Port range for Clawd terminal-focus extension instances.
// Each editor window gets its own extension host → each needs a unique port.
// main.js broadcasts to all ports; only the one with the matching PID responds 200.
const PORT_BASE = 23456;
const PORT_RANGE = 5; // support up to 5 concurrent editor windows

let server = null;
let boundPort = null;
const LOG_PATH = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "clawd-on-desk", "vscode-focus.log");

function log(message) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function normalizeEditor(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text === "code" || text === "cursor" ? text : "";
}

function normalizeFsPath(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let normalized = path.normalize(value.trim());
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "");
}

function normalizeCodexConversationId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.startsWith("codex:") ? text.slice("codex:".length) : text;
}

function pathContains(parentPath, childPath) {
  if (!parentPath || !childPath) return false;
  if (parentPath === childPath) return true;
  const parentWithSep = `${parentPath}${path.sep}`;
  return childPath.startsWith(parentWithSep);
}

async function focusTerminalByPids(pids) {
  for (const terminal of vscode.window.terminals) {
    const termPid = await terminal.processId;
    if (termPid && pids.includes(termPid)) {
      terminal.show(false);
      return true;
    }
  }
  return false;
}

async function matchTerminalByPids(pids) {
  for (const terminal of vscode.window.terminals) {
    const termPid = await terminal.processId;
    if (termPid && pids.includes(termPid)) {
      return { terminal, termPid };
    }
  }
  return null;
}

function windowOwnsCwd(cwd) {
  const normalizedCwd = normalizeFsPath(cwd);
  if (!normalizedCwd) return false;
  const folders = Array.isArray(vscode.workspace.workspaceFolders)
    ? vscode.workspace.workspaceFolders
    : [];
  return folders.some((folder) => {
    const folderPath = normalizeFsPath(folder && folder.uri && folder.uri.fsPath);
    return pathContains(folderPath, normalizedCwd) || pathContains(normalizedCwd, folderPath);
  });
}

async function openCodexSidebar() {
  const commands = await vscode.commands.getCommands(true);
  const exactCandidates = [
    "chatgpt.openSidebar",
    "workbench.view.extension.codexSecondaryViewContainer",
    "workbench.view.extension.codexViewContainer",
    "workbench.view.extension.chatgpt-sidebar",
    "workbench.view.extension.openai",
  ];
  let command = exactCandidates.find((candidate) => commands.includes(candidate)) || null;
  const hasSecondarySidebar = commands.includes("workbench.view.extension.codexSecondaryViewContainer");
  if (!command) {
    command = commands.find((candidate) => (
      candidate.startsWith("workbench.view.extension.")
        && /(codex|chatgpt|openai)/i.test(candidate)
    )) || null;
  }
  if (!command) return { ok: false, reason: "codex-command-missing" };
  await vscode.commands.executeCommand(command);
  if (hasSecondarySidebar && commands.includes("workbench.action.focusAuxiliaryBar")) {
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
    return { ok: true, command, focusCommand: "workbench.action.focusAuxiliaryBar" };
  }
  if (commands.includes("workbench.action.focusSideBar")) {
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    return { ok: true, command, focusCommand: "workbench.action.focusSideBar" };
  }
  return { ok: true, command, focusCommand: null };
}

async function openCodexConversation(sessionId) {
  const conversationId = normalizeCodexConversationId(sessionId);
  if (!conversationId) return { ok: false, reason: "conversation-id-missing" };

  const encodedId = encodeURIComponent(conversationId);
  const preferredSchemes = /insiders/i.test(vscode.env.appName || "")
    ? ["vscode-insiders", "vscode"]
    : ["vscode", "vscode-insiders"];
  for (const scheme of preferredSchemes) {
    const target = `${scheme}://openai.chatgpt/local/${encodedId}`;
    try {
      const handled = await vscode.env.openExternal(vscode.Uri.parse(target));
      if (handled !== false) {
        return { ok: true, target, conversationId };
      }
    } catch {}
  }
  return { ok: false, reason: "deeplink-open-failed", conversationId };
}

async function focusCodexInWindow(data) {
  const pids = Array.isArray(data && data.pids) ? data.pids.filter(Number.isFinite) : [];
  const terminalMatch = pids.length ? await matchTerminalByPids(pids) : null;
  const cwdMatch = !terminalMatch && windowOwnsCwd(data && data.cwd);
  log(`focus-codex request session=${data && data.sessionId ? data.sessionId : "-"} editor=${normalizeEditor(data && data.editor) || "-"} pids=${pids.join(",") || "-"} cwd=${normalizeFsPath(data && data.cwd) || "-"} terminalMatch=${terminalMatch ? terminalMatch.termPid : "-"} cwdMatch=${cwdMatch ? 1 : 0}`);
  if (!terminalMatch && !cwdMatch) {
    log("focus-codex result reason=window-not-matched");
    return { ok: false, statusCode: 404, reason: "window-not-matched" };
  }

  if (terminalMatch) terminalMatch.terminal.show(false);
  const sidebarResult = await openCodexSidebar();
  if (!sidebarResult.ok) {
    log(`focus-codex result reason=${sidebarResult.reason}`);
    return { ok: false, statusCode: 503, reason: sidebarResult.reason };
  }
  const deeplinkResult = await openCodexConversation(data && data.sessionId);
  if (deeplinkResult.ok) {
    log(`focus-codex deeplink result=opened target=${deeplinkResult.target}`);
  } else if (deeplinkResult.reason !== "conversation-id-missing") {
    log(`focus-codex deeplink result=${deeplinkResult.reason} conversation=${deeplinkResult.conversationId || "-"}`);
  }
  log(`focus-codex result reason=opened match=${terminalMatch ? "pid" : "cwd"} command=${sidebarResult.command || "-"} focus=${sidebarResult.focusCommand || "-"} deeplink=${deeplinkResult.ok ? "opened" : deeplinkResult.reason}`);
  return {
    ok: true,
    statusCode: 200,
    match: terminalMatch ? "pid" : "cwd",
    command: sidebarResult.command,
    focusCommand: sidebarResult.focusCommand,
    deeplink: deeplinkResult.ok ? "opened" : deeplinkResult.reason,
    editor: normalizeEditor(data && data.editor) || null,
  };
}

function tryListen(port, maxPort) {
  if (port > maxPort) {
    console.log("Clawd terminal-focus: all ports in use, HTTP server disabled");
    return;
  }

  server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/focus-tab" || req.url === "/focus-codex")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          if (req.url === "/focus-tab") {
            const pids = Array.isArray(data.pids) ? data.pids.filter(Number.isFinite) : [];
            if (pids.length) {
              focusTerminalByPids(pids).then((found) => {
                res.writeHead(found ? 200 : 404);
                res.end(found ? "ok" : "not found");
              });
            } else {
              res.writeHead(400);
              res.end("no pids");
            }
            return;
          }
          const result = await focusCodexInWindow(data);
          res.writeHead(result.statusCode || (result.ok ? 200 : 500), { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400);
          res.end("bad json");
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      server = null;
      tryListen(port + 1, maxPort);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    boundPort = port;
    console.log(`Clawd terminal-focus: listening on 127.0.0.1:${port}`);
  });
}

function activate(context) {
  tryListen(PORT_BASE, PORT_BASE + PORT_RANGE - 1);
  log(`activate port=${boundPort || "-"}`);

  // URI handler kept as fallback for manual testing:
  // vscode://clawd.clawd-terminal-focus?pids=1234,5678
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        const params = new URLSearchParams(uri.query);
        if (params.get("action") === "focus-codex") {
          log(`uri action=focus-codex raw=${uri.toString()}`);
          await focusCodexInWindow({
            editor: params.get("editor") || "",
            cwd: params.get("cwd") || "",
            pids: (params.get("pids") || "").split(",").map(Number).filter(Boolean),
            sessionId: params.get("sessionId") || "",
          });
          return;
        }
        const raw = params.get("pids") || params.get("pid") || "";
        const pids = raw.split(",").map(Number).filter(Boolean);
        log(`uri action=focus-tab pids=${pids.join(",") || "-"}`);
        if (pids.length) focusTerminalByPids(pids);
      },
    })
  );
}

function deactivate() {
  if (server) {
    server.close();
    server = null;
  }
}

module.exports = {
  activate,
  deactivate,
  __test: {
    normalizeFsPath,
    pathContains,
    normalizeEditor,
    normalizeCodexConversationId,
  },
};
