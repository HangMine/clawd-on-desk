"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { __test } = require("../hooks/codex-remote-monitor");

const ROLLOUT_NAME =
  "rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl";

function tempRollout(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-remote-"));
  const filePath = path.join(dir, ROLLOUT_NAME);
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, filePath };
}

function appendLines(filePath, lines) {
  fs.appendFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const META = { type: "session_meta", payload: { cwd: "/repo" } };
const STARTED = { type: "event_msg", payload: { type: "task_started" } };
const COMPLETE = { type: "event_msg", payload: { type: "task_complete" } };
const FUNC = { type: "response_item", payload: { type: "function_call" } };

describe("Codex remote monitor", () => {
  it("builds root state bodies with headless false", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "attention",
      "event_msg:task_complete",
      "/repo",
      false,
      "remote-box"
    ));

    assert.strictEqual(body.agent_id, "codex");
    assert.strictEqual(body.state, "attention");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.host, "remote-box");
    assert.strictEqual(body.headless, false);
  });

  it("builds state bodies with assistant output when provided", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "attention",
      "event_msg:task_complete",
      "/repo",
      false,
      "remote-box",
      { assistantLastOutput: "Done from remote Codex.", assistantLastOutputTruncated: true }
    ));

    assert.strictEqual(body.assistant_last_output, "Done from remote Codex.");
    assert.strictEqual(body.assistant_last_output_truncated, true);
  });

  it("builds state bodies with awaiting-user details when provided", () => {
    const body = JSON.parse(__test.buildPostStateBody(
      "codex:s1",
      "notification",
      "CodexAwaitingUserAction",
      "/repo",
      false,
      "remote-box",
      {
        awaitingUserAction: {
          reason: "plan-review",
          text: "Please review the plan.",
        },
      }
    ));

    assert.strictEqual(body.awaiting_user_reason, "plan-review");
    assert.strictEqual(body.awaiting_user_message, "Please review the plan.");
  });

  it("carries assistant output on remote task_complete posts", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Remote Codex answer" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.strictEqual(complete.state, "attention");
    assert.strictEqual(complete.assistant_last_output, "Remote Codex answer");
  });

  it("posts notification/CodexAwaitingUserAction for remote plan review waits", () => {
    const planText = "<proposed_plan>\n# Plan\n1. Change monitor.\n2. Add tests.\n</proposed_plan>";
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "plan" } },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: planText },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    const waiting = posted.find((body) => body.event === "CodexAwaitingUserAction");
    assert.ok(waiting);
    assert.strictEqual(waiting.state, "notification");
    assert.strictEqual(waiting.awaiting_user_reason, "plan-review");
    assert.strictEqual(waiting.awaiting_user_message, planText);
  });

  it("does not post remote waiting for ordinary plan-mode confirmation replies", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "plan" } },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Good, the waiting-state flow is working now." },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted.some((body) => body.event === "CodexAwaitingUserAction"), false);
    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.ok(complete);
    assert.strictEqual(complete.state, "attention");
    assert.strictEqual(complete.assistant_last_output, "Good, the waiting-state flow is working now.");
  });

  it("does not post remote waiting when ordinary plan-mode text mentions the proposed plan open tag", () => {
    const text = "Docs may mention <proposed_plan> inline without starting a plan block.";
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "plan" } },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: text },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted.some((body) => body.event === "CodexAwaitingUserAction"), false);
    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.ok(complete);
    assert.strictEqual(complete.state, "attention");
    assert.strictEqual(complete.assistant_last_output, text);
  });

  it("does not post remote waiting when ordinary plan-mode text mentions both proposed plan tags inline", () => {
    const text = "Docs may mention <proposed_plan> and </proposed_plan> inline without starting a plan block.";
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "plan" } },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: text },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted.some((body) => body.event === "CodexAwaitingUserAction"), false);
    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.ok(complete);
    assert.strictEqual(complete.state, "attention");
    assert.strictEqual(complete.assistant_last_output, text);
  });

  it("posts notification/CodexAwaitingUserAction for remote request_user_input calls", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_wait",
        arguments: JSON.stringify({ questions: [{ question: "Pick one." }] }),
      },
    }), entry, { postState });

    const waiting = posted.find((body) => body.event === "CodexAwaitingUserAction");
    assert.ok(waiting);
    assert.strictEqual(waiting.state, "notification");
    assert.strictEqual(waiting.awaiting_user_reason, "request-user-input");
    assert.strictEqual(waiting.awaiting_user_message, "Pick one.");
    assert.strictEqual(posted.some((body) => body.state === "working"), false);
  });

  it("posts notification/CodexAwaitingUserAction for remote Chinese confirmation cues", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "\u8bf7\u786e\u8ba4\u662f\u5426\u7ee7\u7eed\u3002" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    const waiting = posted.find((body) => body.event === "CodexAwaitingUserAction");
    assert.ok(waiting);
    assert.strictEqual(waiting.state, "notification");
    assert.strictEqual(waiting.awaiting_user_reason, "assistant-question");
  });

  it("clears remote request_user_input waiting when the tool output arrives", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_wait",
        arguments: JSON.stringify({ questions: [{ question: "Pick one." }] }),
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_wait",
        output: JSON.stringify({ choice: "确认" }),
      },
    }), entry, { postState });

    assert.deepStrictEqual(posted.map((body) => body.state), ["notification", "working"]);
    assert.strictEqual(posted[1].event, "response_item:function_call_output");
  });

  it("does not reopen remote waiting for a plain plan-mode reply after request_user_input resolves", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "plan" } },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_wait",
        arguments: JSON.stringify({ questions: [{ question: "Can you see this choice?" }] }),
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_wait",
        output: JSON.stringify({ choice: "yes" }),
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Good, this flow is working now." },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    const waitingEvents = posted.filter((body) => body.event === "CodexAwaitingUserAction");
    assert.strictEqual(waitingEvents.length, 1);
    assert.deepStrictEqual(posted.map((body) => body.state), ["thinking", "notification", "working", "attention"]);
    const complete = posted.at(-1);
    assert.strictEqual(complete.event, "event_msg:task_complete");
    assert.strictEqual(complete.assistant_last_output, "Good, this flow is working now.");
  });

  it("clears remote request_user_input waiting as idle when the user aborts", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_wait",
        arguments: JSON.stringify({ questions: [{ question: "Pick one." }] }),
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_wait",
        output: "aborted by user after 38.8s",
      },
    }), entry, { postState });

    assert.deepStrictEqual(posted.map((body) => body.state), ["notification", "idle"]);
    assert.strictEqual(posted[1].event, "response_item:function_call_output");
  });

  it("does not treat assistant progress before later tool work as a final question", () => {
    const entry = {
      sessionId: "codex:root",
      cwd: "/repo",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent, extra) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box",
        extra
      )));
    };

    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_message", message: "Please confirm which option to use before I continue." },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "shell_command", arguments: "{\"command\":\"npm test\"}" },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted.some((body) => body.event === "CodexAwaitingUserAction"), false);
    const complete = posted.find((body) => body.event === "event_msg:task_complete");
    assert.ok(complete);
    assert.strictEqual(complete.state, "attention");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(complete, "assistant_last_output"), false);
  });

  it("marks subagent bodies headless and maps task_complete to idle", () => {
    const entry = {
      sessionId: "codex:sub",
      cwd: "",
      isSubagent: false,
      lastEventTime: 0,
      lastState: null,
    };
    const posted = [];
    const postState = (sessionId, state, event, cwd, isSubagent) => {
      posted.push(JSON.parse(__test.buildPostStateBody(
        sessionId,
        state,
        event,
        cwd,
        isSubagent,
        "remote-box"
      )));
    };

    __test.processLine(JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/repo/sub",
        source: { subagent: { thread_spawn: { parent_thread_id: "root", agent_role: "worker" } } },
        agent_role: "worker",
      },
    }), entry, { postState });
    __test.processLine(JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete" },
    }), entry, { postState });

    assert.strictEqual(posted[0].state, "idle");
    assert.strictEqual(posted[0].headless, true);
    assert.strictEqual(posted[1].state, "idle");
    assert.strictEqual(posted[1].event, "event_msg:task_complete");
    assert.strictEqual(posted[1].headless, true);
  });
});

describe("Codex remote monitor — stale-cleanup re-read dedup", () => {
  const tmpDirs = [];
  afterEach(() => {
    __test.tracked.clear();
    while (tmpDirs.length) {
      try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
    }
  });

  function track(lines) {
    const { dir, filePath } = tempRollout(lines);
    tmpDirs.push(dir);
    return filePath;
  }

  function spy() {
    const posted = [];
    return {
      posted,
      postState: (sessionId, state, event) => posted.push({ sessionId, state, event }),
    };
  }

  it("does not re-emit historical task_complete after a stale window + resume", () => {
    const filePath = track([META, STARTED, COMPLETE]);
    const s = spy();

    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const completes1 = s.posted.filter((p) => p.event === "event_msg:task_complete");
    assert.strictEqual(completes1.length, 1, "first completion fires once");

    // Idle past the stale threshold: posts sleeping once, KEEPS the entry+offset.
    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });
    assert.strictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup").length, 1,
      "sleeping posted once on going stale"
    );

    // Resume appends a brand-new line. The retained offset means only this new
    // line is processed — the old task_complete is never re-read.
    appendLines(filePath, [STARTED]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 1,
      "historical task_complete must not re-fire on resume"
    );
  });

  it("still fires a genuinely new completion after resume", () => {
    const filePath = track([META, STARTED, COMPLETE]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });

    // The resumed turn completes again — a real second completion.
    appendLines(filePath, [STARTED, COMPLETE]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 2,
      "a real new completion after resume still fires"
    );
  });

  it("posts sleeping only once while a session stays idle", () => {
    const filePath = track([META, STARTED]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    const future = () => Date.now() + __test.STALE_MS + 1;
    __test.cleanStaleFiles({ postState: s.postState, now: future });
    __test.cleanStaleFiles({ postState: s.postState, now: future });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "stale-cleanup").length, 1,
      "stale-cleanup must not re-post sleeping every tick"
    );
  });

  it("re-reads from 0 when the rollout file is truncated/rotated", () => {
    const filePath = track([META, STARTED]); // idle, thinking
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(s.posted.filter((p) => p.event === "event_msg:task_complete").length, 0);

    // Recreate the file smaller than the retained offset (rotation/truncation).
    fs.writeFileSync(filePath, JSON.stringify(COMPLETE) + "\n");
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.event === "event_msg:task_complete").length, 1,
      "truncated file must restart at offset 0 instead of skipping new content"
    );
  });

  it("wakes a stale session on the next working event", () => {
    const filePath = track([META, FUNC]); // idle, working
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    const workingBefore = s.posted.filter((p) => p.state === "working").length;
    assert.strictEqual(workingBefore, 1);

    __test.cleanStaleFiles({ postState: s.postState, now: () => Date.now() + __test.STALE_MS + 1 });
    assert.strictEqual(__test.tracked.get(filePath).stale, true);

    // Same working-mapped event after going stale must wake the pet, not be
    // swallowed by the same-state dedup.
    appendLines(filePath, [FUNC]);
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });

    assert.strictEqual(
      s.posted.filter((p) => p.state === "working").length, 2,
      "next working event after stale must re-post working"
    );
    assert.strictEqual(__test.tracked.get(filePath).stale, false, "stale cleared on wake");
  });

  it("prunes tracked entries whose directory left the scan window", () => {
    const filePath = track([META, STARTED]);
    const s = spy();
    __test.pollFile(filePath, ROLLOUT_NAME, { postState: s.postState });
    assert.strictEqual(__test.tracked.has(filePath), true);

    // Simulate the day rolling over: the file's dir is no longer in-window.
    __test.pruneTrackedOutOfWindow({ getSessionDirs: () => ["/some/other/window/dir"] });
    assert.strictEqual(__test.tracked.has(filePath), false, "out-of-window entry pruned");
  });
});
