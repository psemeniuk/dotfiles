import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const host = process.env.PI_PACKAGE ?? join(dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()))), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const { createJiti } = await import(pathToFileURL(join(host, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(host, "dist/index.js") } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/fork-pane");
const { detectTerminal, preparePane, quote } = await jiti.import(join(root, "terminal.ts"));
const { default: extension, createFork } = await jiti.import(join(root, "index.ts"));
const { SessionManager } = await import(pathToFileURL(join(host, "dist/index.js")));

test("detection prioritizes Rex and Herdr over embedded Ghostty", () => {
  assert.equal(detectTerminal({ TERM_PROGRAM: "ghostty", HC_TERMINAL_ID: "t22" }), "herdr");
  assert.equal(detectTerminal({ TERM_PROGRAM: "ghostty", HC_TERMINAL_ID: "t22", REX_BLOCK: "b", REX_SERVER: "s" }), "rex");
  assert.equal(detectTerminal({ TERM_PROGRAM: "ghostty" }, "darwin"), "ghostty");
  assert.throws(() => detectTerminal({}, "darwin"));
  assert.throws(() => detectTerminal({ TERM_PROGRAM: "ghostty" }, "linux"));
});

test("Herdr resolves own pane, not focused pane; arguments are shell-safe", async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return JSON.stringify({ spaces: [{ machine: null, tabs: [{ terminals: [{ terminal: "t22", pane: "p22" }] }] }] }); };
  const pane = await preparePane({ HC_TERMINAL_ID: "t22" }, run);
  await pane.open(["pi", "--session", "/tmp/it's $(unsafe)"], "/tmp/a b");
  const payload = JSON.parse(calls[1][1][2]);
  assert.equal(payload.pane, "p22");
  assert.equal(payload.direction, "right");
  assert.equal(payload.argv[2], `cd ${quote("/tmp/a b")} && exec 'pi' '--session' ${quote("/tmp/it's $(unsafe)")}`);
  await assert.rejects(preparePane({ HC_TERMINAL_ID: "missing" }, run));
});

test("Rex uses server, block and matching executable with direct argv", async () => {
  const calls = [];
  const pane = await preparePane({ REX_BLOCK: "block:x", REX_SERVER: "server", REX_BIN_DIR: "/bin rex" }, async (...args) => { calls.push(args); return ""; });
  await pane.open(["pi", "--session", "a b"], "/work");
  assert.deepEqual(calls, [["/bin rex/rex", ["-S", "server", "split", "-b", "block:x", "--split=right", "--cwd", "/work", "--shell=none", "--", "pi", "--session", "a b"]]]);
});

test("Ghostty captures anchor and starts command through surface configuration", async () => {
  const calls = [];
  const pane = await preparePane({ TERM_PROGRAM: "ghostty" }, async (...args) => { calls.push(args); return "surface-1\n"; }, "darwin");
  await pane.open(["pi", "--session", "quoted\"path"], "/work");
  assert.equal(calls.length, 2);
  assert.match(calls[1][1][1], /first terminal whose id is "surface-1"/);
  assert.match(calls[1][1][1], /split anchor direction right with configuration cfg/);
  assert.doesNotMatch(calls[1][1][1], /input text|send key/);
});

test("fork copies only preceding branch, preserves parent file and prefill; supports first message", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-fork-test-"));
  try {
    const sm = SessionManager.create(dir, dir);
    const first = sm.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
    const second = sm.appendMessage({ role: "user", content: "second", timestamp: Date.now() });
    const source = sm.getSessionFile();
    const before = readFileSync(source, "utf8");
    for (const [id, text, count] of [[first, "first", 0], [second, "second", 1]]) {
      const path = createFork(source, dir, id, "before");
      assert.notEqual(path, source);
      const fork = SessionManager.open(path, dir);
      assert.equal(fork.getHeader().parentSession, source);
      assert.equal(fork.getEntries().filter(e => e.type === "message").length, count);
      assert.equal(fork.getBranch().at(-1).data.text, text);
      assert.notEqual(fork.getSessionId(), sm.getSessionId());
    }
    assert.equal(readFileSync(source, "utf8"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hook preserves native clone/RPC and cancels failed TUI fork", async () => {
  const hooks = {};
  extension({ on: (name, fn) => hooks[name] = fn });
  assert.equal(await hooks.session_before_fork({ position: "at" }, { mode: "tui" }), undefined);
  assert.equal(await hooks.session_before_fork({ position: "before" }, { mode: "rpc" }), undefined);
  const notices = [];
  const result = await hooks.session_before_fork({ position: "before" }, { mode: "tui", isIdle: () => false, ui: { notify: (...args) => notices.push(args) } });
  assert.deepEqual(result, { cancel: true });
  assert.equal(notices[0][1], "error");
});
