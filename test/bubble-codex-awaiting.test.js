"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "bubble-renderer.js"),
  "utf8"
);
const CSS_SRC = fs.readFileSync(
  path.join(__dirname, "..", "src", "bubble.css"),
  "utf8"
);

describe("Codex awaiting-user bubble renderer", () => {
  it("renders a dedicated Codex awaiting-user branch with terminal focus action", () => {
    assert.match(RENDERER_SRC, /data\.toolName === "CodexAwaitingUserAction"/);
    assert.match(RENDERER_SRC, /headerTitle\.textContent = bubbleText\(data\.lang, "codexNeedsInput"\);/);
    assert.match(RENDERER_SRC, /btnDeny\.textContent = bubbleText\(data\.lang, "goToTerminal"\);/);
    assert.match(RENDERER_SRC, /passiveDenyBehavior = "deny-and-focus";/);
  });

  it("keeps normal Deny semantics as the default button behavior", () => {
    assert.match(RENDERER_SRC, /let passiveDenyBehavior = "deny";/);
    assert.match(RENDERER_SRC, /passiveDenyBehavior = "deny";[\s\S]*suggestionsContainer\.innerHTML = "";/);
    assert.match(RENDERER_SRC, /window\.bubbleAPI\.decide\(passiveDenyBehavior\);/);
  });

  it("uses the existing Codex pill styling for awaiting-user notifications", () => {
    assert.match(CSS_SRC, /\.tool-pill\[data-tool="CodexAwaitingUserAction"\]/);
  });
});
