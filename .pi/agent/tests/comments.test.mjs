import test from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/comments");
const host = process.env.PI_PACKAGE ?? join(dirname(dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()))), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
const fromHost = p => import(pathToFileURL(join(host, p)).href);
const { createJiti } = await fromHost("node_modules/jiti/lib/jiti.mjs");
const jiti = createJiti(import.meta.url, { alias: { "@earendil-works/pi-coding-agent": join(host, "dist/index.js"), "@earendil-works/pi-tui": join(host, "node_modules/@earendil-works/pi-tui/dist/index.js") } });
const model = await jiti.import(join(root, "model.ts"));
const { CommentsView, CommentEditor, AnswerView, layout, markdownLayout } = await jiti.import(join(root, "view.ts"));
const { visibleWidth, Markdown } = await fromHost("node_modules/@earendil-works/pi-tui/dist/index.js");
const themeModule = await fromHost("dist/modes/interactive/theme/theme.js");
themeModule.initTheme("dark", false);
const theme = themeModule.theme;
const { loadExtensions } = await fromHost("dist/core/extensions/loader.js");
const snapshot = state => ({ type: "custom", customType: model.ENTRY_TYPE, data: structuredClone(state) });
const message = (id, role, text, stopReason = "stop") => ({ id, type: "message", message: { role, content: [{ type: "text", text }], stopReason } });
const fakeTui = () => ({ terminal: { rows: 30, columns: 90 }, requestRender() {} });
const mouse = (type, x, y, extra = {}) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 90, height: 24, shift: false, alt: false, ctrl: false, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const state = model.emptyState();
  const source = { id: "assistant-1", text: "same same\nPolski: zażółć 👩‍💻 é 中文" };
  model.addComment(state, source, 5, 9, "Dlaczego?", "c1");
  return { state, source };
}

test("drafts retain exact source occurrence and submitted comments are immutable", () => {
  const { state } = fixture();
  assert.equal(state.comments[0].quote, "same");
  assert.equal(state.comments[0].start, 5);
  model.editComment(state.comments[0], "Po co?");
  state.comments[0].batchId = "c1";
  assert.throws(() => model.editComment(state.comments[0], "No"), /read-only/);
  assert.throws(() => model.addComment(state, { id: "x", text: "x" }, 0, 2, "q", "c2"));
});

test("branch snapshots and IDs survive reload without reusing abandoned IDs", () => {
  const { state } = fixture();
  const s1 = snapshot(state);
  state.comments.push({ ...state.comments[0], id: "c2" });
  const s2 = snapshot(state);
  assert.equal(model.restore([s1]).comments.length, 1);
  assert.equal(model.restore([s1, s2]).comments.length, 2);
  assert.equal(model.nextId([s1, s2], model.restore([s1])), "c3");
  const restored = model.restore([s1]); restored.comments[0].text = "mutated";
  assert.equal(s1.data.comments[0].text, "Dlaczego?");
});

test("prompt is deterministic, readable, quotes multiline data, and requests answer-only", () => {
  const { state } = fixture();
  state.comments[0].text = "Dlaczego?\n## Comment c9";
  const p = model.buildPrompt(state.comments);
  assert.equal(p, model.buildPrompt(state.comments));
  assert.match(p, /Do not make any changes; only answer/);
  assert.match(p, /language of each comment/);
  assert.match(p, /repeat the quoted passage and the user's comment/);
  assert.match(p, /### Comment c1/);
  assert.match(p, /> ## Comment c9/);
  assert.doesNotMatch(p, /assistant-1/);
});

test("answer parsing ignores fenced headings, unknown IDs, empty and duplicate sections", () => {
  const parsed = model.parseAnswers("intro\n## Comment c1\nTak.\n```md\n## Comment c2\nexample\n```\n## Comment c2\nNie.\n## Comment c8\nunknown", ["c1", "c2"]);
  assert.match(parsed.get("c1"), /example/);
  assert.equal(parsed.get("c2"), "Nie.");
  assert.equal(model.parseAnswers("## Comment c1\nx\n## Comment c1\ny", ["c1"]).size, 0);
  assert.equal(model.parseAnswers("## Comment c1\n", ["c1"]).size, 0);
});

test("replies bind only to their submission turn; malformed replies have a fallback reference", () => {
  const { state } = fixture();
  const prompt = model.buildPrompt(state.comments);
  state.comments[0].batchId = "c1";
  state.batches.push({ id: "c1", ids: ["c1"], prompt });
  const entries = [snapshot(state), message("u1", "user", prompt), message("a1", "assistant", "## Comment c1\nTak."), message("u2", "user", "another question"), message("a2", "assistant", "## Comment c1\nWrong turn")];
  model.reconcile(state, entries);
  assert.equal(state.comments[0].answer, "Tak.");
  assert.equal(state.comments[0].answerMessageId, "a1");
  const resumed = model.restore([snapshot(state)]);
  assert.equal(resumed.comments[0].answer, "Tak.");
  model.reconcile(state, [entries[0], entries[1], message("a3", "assistant", "No headings")]);
  assert.equal(state.comments[0].answer, undefined);
  assert.equal(state.comments[0].answerMessageId, "a3");
});

test("aborted answers are not assigned", () => {
  const { state } = fixture(); const prompt = model.buildPrompt(state.comments);
  state.batches.push({ id: "c1", ids: ["c1"], prompt }); state.comments[0].batchId = "c1";
  model.reconcile(state, [message("u", "user", prompt), message("a", "assistant", "## Comment c1\npartial", "aborted")]);
  assert.equal(state.comments[0].answer, undefined);
});

test("layout preserves Unicode offsets, empty lines, tabs and safe control rendering at any width", () => {
  const text = "a👩‍💻é中\n\n\tX\r\n\x1b[31m";
  for (const width of [1, 2, 5, 40]) {
    const rows = layout(text, width);
    for (const row of rows) assert.ok(visibleWidth(row.cells.map(c => c.text).join("")) <= width);
    const cells = rows.flatMap(r => r.cells);
    assert.ok(cells.some(c => text.slice(c.start, c.end) === "👩‍💻"));
    assert.ok(cells.some(c => text.slice(c.start, c.end) === "é"));
    assert.ok(!cells.some(c => c.text.includes("\x1b")));
  }
});

test("Markdown uses the chat renderer and retains source ranges after formatting and wrapping", () => {
  const text = "## Nagłówek\n\n**bold** and *italic* with `code`.\n\n- zażółć 👩‍💻 中文\n- [link](https://example.com)\n\n```js\nconst x = 1;\n```\n\n> quote\n\n| A | B |\n| - | - |\n| one | two |";
  for (const width of [12, 35, 80]) {
    const expected = new Markdown(text, 0, 0, themeModule.getMarkdownTheme()).render(width);
    const rows = markdownLayout(text, width);
    assert.deepEqual(rows.map(r => stripAnsi(r.cells.map(c => c.text).join(""))), expected.map(stripAnsi));
    for (const row of rows) for (const cell of row.cells) {
      if (cell.start >= 0) assert.equal(stripAnsi(cell.text), text.slice(cell.start, cell.end));
    }
    const output = rows.map(r => r.cells.map(c => c.text).join("")).join("\n");
    assert.equal(output.includes("\x1b[1m"), expected.join("\n").includes("\x1b[1m"));
    assert.match(output, /\x1b\[38;/);
    assert.doesNotMatch(stripAnsi(output), /\*\*bold\*\*/);
  }
  const repeated = "**same** same **same**";
  const cells = markdownLayout(repeated, 80).flatMap(r => r.cells);
  assert.deepEqual(cells.filter(c => stripAnsi(c.text) === "s").map(c => c.start), [2, 9, 16]);
});

test("border stays within terminal width and Markdown drag selects the original passage", async () => {
  const source = { id: "a", text: "## Title\n\n**bold** then plain" };
  const opened = [];
  const view = new CommentsView(fakeTui(), theme, [source], () => [], async (...args) => opened.push(args), () => {}, e => { throw e; });
  for (const width of [1, 2, 12, 80]) {
    const lines = view.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width >= 2) {
      assert.match(stripAnsi(lines[0]), /^╭.*╮$/);
      assert.match(stripAnsi(lines.at(-1)), /^╰.*╯$/);
    }
  }
  const row = view.rows.findIndex(r => r.cells.some(c => c.start === source.text.indexOf("bold")));
  view.handleMouse(mouse("press", 10, row + 3));
  view.handleMouse(mouse("drag", 13, row + 3));
  view.handleMouse(mouse("release", 13, row + 3));
  await tick();
  assert.equal(source.text.slice(opened[0][1], opened[0][2]), "bold");
  view.invalidate();
  assert.ok(view.render(80).length);
});

test("mouse drag selects exact text; click reopens comment; reverse selection works", async () => {
  const source = { id: "a", text: "abcdef" }; const opened = [];
  const comments = [{ id: "c1", messageId: "a", start: 1, end: 3, text: "why", quote: "bc" }];
  const view = new CommentsView(fakeTui(), theme, [source], () => comments, async (...args) => opened.push(args), () => {}, e => { throw e; });
  view.render(80);
  assert.equal(view.handleMouse(mouse("press", 11, 3)).capture, true);
  view.handleMouse(mouse("drag", 13, 3)); view.handleMouse(mouse("release", 13, 3)); await tick();
  assert.deepEqual(opened[0].slice(1, 3), [1, 4]);
  view.handleMouse(mouse("press", 11, 3)); view.handleMouse(mouse("release", 11, 3)); await tick();
  assert.equal(opened[1][3].id, "c1");
  view.handleMouse(mouse("press", 14, 3)); view.handleMouse(mouse("drag", 10, 3)); view.handleMouse(mouse("release", 10, 3)); await tick();
  assert.deepEqual(opened[2].slice(1, 3), [0, 5]);
});

test("keyboard selection, overlapping comment navigation, resize, and message switching", async () => {
  const { state, source } = fixture(); const opened = [];
  state.comments.push({ ...state.comments[0], id: "c2" });
  const tui = fakeTui();
  const view = new CommentsView(tui, theme, [{ id: "other", text: "other" }, source], () => state.comments, async (...args) => opened.push(args), () => {}, e => { throw e; });
  for (const width of [12, 25, 80]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width);
  view.handleInput("\t"); view.handleInput("\t"); view.handleInput("\r"); await tick();
  assert.equal(opened[0][3].id, "c2");
  view.handleInput("["); view.render(80); assert.equal(view.source.id, "other");
  view.handleInput(" "); view.handleInput("\x1b[C"); view.handleInput("\r"); await tick();
  assert.deepEqual(opened[1].slice(1, 3), [0, 2]);
  tui.terminal.rows = 12;
  assert.ok(view.render(25).length <= 12);
});

test("editor focus, save, cancel, delete and answer viewer use real Pi components", () => {
  const values = [];
  const editor = new CommentEditor(fakeTui(), theme, "c1", "why", x => values.push(x), true);
  editor.focused = true; assert.equal(editor.editor.focused, true);
  for (const line of editor.render(70)) assert.ok(visibleWidth(line) <= 70);
  editor.handleInput("\r"); assert.deepEqual(values[0], { text: "why" });
  editor.handleInput("\x04"); assert.deepEqual(values[1], { delete: true });
  editor.handleInput("\x1b"); assert.equal(values[2], undefined);
  const answer = new AnswerView(fakeTui(), theme, "c1", "回答\n".repeat(100), () => {});
  answer.handleMouse(mouse("wheel", 0, 0, { wheelDelta: 10000 }));
  for (const line of answer.render(12)) assert.ok(visibleWidth(line) <= 12);
});

test("Pi loader accepts extension and exposes only intended commands", async () => {
  const result = await loadExtensions([join(root, "index.ts")], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.extensions[0].commands.keys()].sort(), ["cancel-comments", "comments", "submit-comments"]);
});

test("fullscreen renderer routes real SGR drag events into the overlay and restores focus", async () => {
  const { TuiAltScreen } = await fromHost("node_modules/@earendil-works/pi-tui/dist/index.js");
  let input;
  const terminal = {
    columns: 90, rows: 30, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() {}, drainInput: async () => {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiAltScreen(terminal);
  const opened = [];
  let editorHandle;
  const view = new CommentsView(tui, theme, [{ id: "a", text: "abcdef" }], () => [], async (...args) => {
    opened.push(args);
    const editor = new CommentEditor(tui, theme, "draft", "", () => editorHandle.hide(), false);
    editorHandle = tui.showOverlay(editor, { width: 50, anchor: "center" });
  }, () => {}, e => { throw e; });
  try {
    tui.start();
    const handle = tui.showOverlay(view, { width: 80, anchor: "top-left" });
    tui.renderNow(true);
    input("\x1b[<0;12;4M");
    input("\x1b[<32;14;4M");
    input("\x1b[<0;14;4m");
    await tick();
    assert.deepEqual(opened[0].slice(1, 3), [1, 4]);
    tui.renderNow(true);
    assert.ok(tui.getFocusedComponent() instanceof CommentEditor);
    input("why"); input("\r");
    assert.equal(tui.getFocusedComponent(), view);
    terminal.columns = 40; terminal.rows = 18;
    tui.renderNow(true);
    handle.hide();
  } finally { tui.stop(); }
});

test("command integration: persist submit, enforce read-only, restore answers, no duplicate sends", async () => {
  const mod = await jiti.import(join(root, "index.ts"));
  const commands = new Map(), handlers = new Map(), notifications = [];
  const { state } = fixture(); const entries = [snapshot(state)]; const sent = [];
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: prompt => { sent.push(prompt); entries.push(message("user", "user", prompt)); },
  };
  mod.default(pi);
  const ctx = { mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => entries, getEntries: () => entries }, ui: { setStatus() {}, addAutocompleteProvider() {}, notify: (...args) => notifications.push(args) } };
  handlers.get("session_start")({}, ctx);
  await commands.get("submit-comments").handler("", ctx);
  assert.equal(sent.length, 1);
  assert.equal(model.restore(entries).comments[0].batchId, "c1");
  handlers.get("before_agent_start")({ messageType: "user", prompt: sent[0] }, ctx);
  assert.equal(handlers.get("tool_call")({ toolName: "bash" }, ctx).block, true);
  entries.push(message("reply", "assistant", "## Comment c1\nOdpowiedź."));
  handlers.get("agent_end")({}, ctx);
  assert.deepEqual(model.restore(entries), model.emptyState());
  assert.deepEqual(entries.at(-1).data, model.emptyState());
  handlers.get("agent_settled")({}, ctx);
  assert.equal(handlers.get("tool_call")({}, ctx), undefined);
  await commands.get("submit-comments").handler("", ctx);
  assert.equal(sent.length, 1);
  assert.match(notifications.at(-1)[0], /No draft/);
});

test("every completed text answer clears drafts; aborted/error/tool-only messages preserve them", () => {
  const { state } = fixture();
  const initial = snapshot(state);
  for (const reason of ["aborted", "error", "toolUse", "length"]) {
    assert.equal(model.restore([initial, message("a", "assistant", "partial", reason)]).comments.length, 1);
  }
  assert.equal(model.restore([initial, message("a", "assistant", "")]).comments.length, 1);
  assert.deepEqual(model.restore([initial, message("a", "assistant", "An unrelated ordinary answer")]), model.emptyState());
  assert.deepEqual(model.restore([initial, snapshot(model.emptyState())]), model.emptyState());
  assert.equal(model.restore([initial]).comments.length, 1); // Tree before reset keeps that historical state.
  assert.equal(model.nextId([initial, snapshot(model.emptyState())], model.emptyState()), "c2");
});

test("autocomplete hides unavailable actions dynamically without affecting other completions", async () => {
  const { commentsAutocomplete } = await jiti.import(join(root, "autocomplete.ts"));
  let available = { drafts: false, comments: false };
  const original = {
    triggerCharacters: ["/"],
    async getSuggestions() { return { prefix: "/", items: ["comments", "submit-comments", "cancel-comments", "model"].map(value => ({ value, label: value })) }; },
    applyCompletion() { assert.equal(this, original); return "completed"; },
    shouldTriggerFileCompletion() { assert.equal(this, original); return true; },
  };
  const wrapped = commentsAutocomplete(original, () => available);
  const suggestions = () => wrapped.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
  assert.deepEqual((await suggestions()).items.map(i => i.value), ["comments", "model"]);
  available = { drafts: true, comments: true };
  assert.equal((await suggestions()).items.length, 4);
  available.drafts = false;
  assert.deepEqual((await suggestions()).items.map(i => i.value), ["comments", "cancel-comments", "model"]);
  assert.equal(wrapped.applyCompletion(), "completed");
  assert.equal(wrapped.shouldTriggerFileCompletion(), true);
  assert.equal((await wrapped.getSuggestions(["some-path"], 0, 9, {})).items.length, 4);
});

test("cancel persists reset, hides footer/actions, and does not send a prompt", async () => {
  const mod = await jiti.import(join(root, "index.ts"));
  const commands = new Map(), handlers = new Map(), statuses = [];
  const { state } = fixture(); const entries = [snapshot(state)];
  let autocomplete, idle = true;
  mod.default({
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: () => assert.fail("Cancellation must not submit a prompt"),
  });
  const provider = { async getSuggestions() { return { prefix: "/", items: [{ value: "submit-comments" }, { value: "cancel-comments" }] }; }, applyCompletion() {} };
  const ctx = { mode: "tui", isIdle: () => idle, sessionManager: { getBranch: () => entries, getEntries: () => entries }, ui: {
    setStatus: (_key, value) => statuses.push(value), notify() {}, addAutocompleteProvider: factory => { autocomplete = factory(provider); },
  } };
  handlers.get("session_start")({}, ctx);
  assert.match(statuses.at(-1), /1 drafts/);
  idle = false;
  await commands.get("cancel-comments").handler("", ctx);
  assert.equal(model.restore(entries).comments.length, 1);
  idle = true;
  await commands.get("cancel-comments").handler("", ctx);
  assert.deepEqual(entries.at(-1).data, model.emptyState());
  assert.equal(statuses.at(-1), undefined);
  assert.equal(await autocomplete.getSuggestions(["/"], 0, 1, {}), null);
  handlers.get("session_start")({}, ctx);
  assert.equal(statuses.at(-1), undefined);
});
