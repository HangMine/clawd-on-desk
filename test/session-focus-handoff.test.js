"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  focusCodexEditorTarget,
  focusCodexThreadTarget,
  sanitizeFocusError,
} = require("../src/session-focus-handoff");

describe("session focus handoff", () => {
  it("asks the editor bridge to open Codex and then focuses the editor window", async () => {
    const logs = [];
    const editorWindowCalls = [];
    const terminalCalls = [];
    const focusEntry = {
      id: "codex:thread",
      agentId: "codex",
      sourcePid: 123,
      editor: "code",
    };

    const result = await focusCodexEditorTarget({
      focusEntry,
      sessionId: "codex:thread",
      requestSource: "hud",
      focusLog: (line) => logs.push(line),
      requestEditorFocus: async () => ({ ok: true, match: "pid", command: "chatgpt.openSidebar" }),
      focusEditorSessionWindow: (...args) => {
        editorWindowCalls.push(args);
        return true;
      },
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.strictEqual(result, true);
    assert.deepStrictEqual(editorWindowCalls, [[focusEntry, "codex:thread", "hud"]]);
    assert.deepStrictEqual(terminalCalls, []);
    assert.ok(logs.some((line) => line.includes("target=codex-editor")));
    assert.ok(logs.some((line) => line.includes("reason=opened")));
  });

  it("falls back to terminal focus when the editor bridge misses", async () => {
    const logs = [];
    const terminalCalls = [];
    const openedUris = [];
    const focusEntry = {
      id: "codex:thread",
      agentId: "codex",
      sourcePid: 123,
      editor: "code",
    };

    const result = await focusCodexEditorTarget({
      focusEntry,
      sessionId: "codex:thread",
      requestSource: "hud",
      focusLog: (line) => logs.push(line),
      requestEditorFocus: async () => ({ ok: false, reason: "window-not-matched" }),
      requestEditorUriFocus: async (shellArg) => {
        await shellArg.openExternal("vscode-insiders://clawd.clawd-terminal-focus?action=focus-codex");
        return { ok: true, scheme: "vscode-insiders" };
      },
      shell: {
        openExternal: async (url) => openedUris.push(url),
      },
      focusEditorSessionWindow: () => false,
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.strictEqual(result, false);
    assert.deepStrictEqual(openedUris, ["vscode-insiders://clawd.clawd-terminal-focus?action=focus-codex"]);
    assert.deepStrictEqual(terminalCalls, [[focusEntry, "codex:thread", "hud"]]);
    assert.ok(logs.some((line) => line.includes("reason=bridge-miss")));
    assert.ok(logs.some((line) => line.includes("window-not-matched")));
    assert.ok(logs.some((line) => line.includes("reason=uri-opened")));
  });

  it("opens Codex Desktop thread URLs and logs success", async () => {
    const opened = [];
    const logs = [];

    await focusCodexThreadTarget({
      shell: {
        openExternal: async (url) => opened.push(url),
      },
      focusEntry: { id: "codex:thread", agentId: "codex" },
      sessionId: "codex:thread",
      requestSource: "dashboard",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
    });

    assert.deepStrictEqual(opened, ["codex://threads/thread"]);
    assert.ok(logs.some((line) => line.includes("target=codex-thread")));
    assert.ok(logs.some((line) => line.includes("reason=opened")));
  });

  it("falls back to terminal focus when Codex Desktop deep link fails", async () => {
    const logs = [];
    const terminalCalls = [];
    const focusEntry = { id: "codex:thread", agentId: "codex", sourcePid: 123 };

    await focusCodexThreadTarget({
      shell: {
        openExternal: async () => {
          throw new Error("protocol failed\nwith tab");
        },
      },
      focusEntry,
      sessionId: "codex:thread",
      requestSource: "hud",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
      focusTerminalSession: (...args) => {
        terminalCalls.push(args);
        return true;
      },
    });

    assert.deepStrictEqual(terminalCalls, [[focusEntry, "codex:thread", "hud"]]);
    assert.ok(logs.some((line) =>
      line.includes("reason=open-failed") && line.includes("protocol failed with tab")
    ));
    assert.ok(!logs.some((line) => line.includes("codex-thread-fallback-no-source-pid")));
  });

  it("logs when Codex Desktop deep link fallback has no terminal source pid", async () => {
    const logs = [];

    await focusCodexThreadTarget({
      shell: {
        openExternal: async () => {
          throw new Error("no app");
        },
      },
      focusEntry: { id: "codex:thread", agentId: "codex" },
      sessionId: "codex:thread",
      url: "codex://threads/thread",
      focusLog: (line) => logs.push(line),
      focusTerminalSession: () => false,
    });

    assert.ok(logs.some((line) => line.includes("reason=open-failed")));
    assert.ok(logs.some((line) => line.includes("reason=codex-thread-fallback-no-source-pid")));
  });

  it("sanitizes focus errors for single-line logs", () => {
    assert.strictEqual(sanitizeFocusError(new Error("a\r\nb\tc")), "a b c");
    assert.strictEqual(sanitizeFocusError("x\r\ny\tz"), "x y z");
    assert.strictEqual(sanitizeFocusError(null), "unknown");
  });
});
