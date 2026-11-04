import test from 'node:test';
import assert from 'node:assert/strict';
import extension, { canRetry } from '../extensions/chat-history/index.ts';

function harness() {
  const commands = {}, events = {}, entries = [], notices = [], sent = [], calls = [];
  let leaf = null, editor = '', idle = true, pending = false, cancel = false;
  function append(entry) {
    const id = String(entries.length + 1);
    entries.push({ ...entry, id, parentId: leaf }); leaf = id; return id;
  }
  const sm = {
    getLeafId: () => leaf,
    getEntry: id => entries.find(e => e.id === id),
    getBranch: () => {
      const branch = [];
      for (let id = leaf; id;) { const e = sm.getEntry(id); branch.unshift(e); id = e.parentId; }
      return branch;
    },
  };
  const ctx = {
    sessionManager: sm, isIdle: () => idle, hasPendingMessages: () => pending,
    ui: { notify: (...args) => notices.push(args), getEditorText: () => editor, setEditorText: value => { editor = value; } },
    navigateTree: async (target, options) => {
      calls.push({ target, options });
      if (cancel) return { cancelled: true };
      if (target === leaf) return { cancelled: false };
      const e = sm.getEntry(target);
      if (e.type === 'custom_message' || (e.type === 'message' && e.message.role === 'user')) {
        leaf = e.parentId; editor = e.message?.content ?? e.content;
      } else { leaf = target; editor = ''; }
      await events.session_tree({}, ctx);
      return { cancelled: false };
    },
  };
  extension({
    on: (name, handler) => { events[name] = handler; },
    registerCommand: (name, cmd) => { commands[name] = cmd.handler; },
    appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
    sendMessage: (message, options) => { sent.push({ message, options }); append({ type: 'custom_message', ...message }); },
  });
  return { sm, ctx, events, entries, notices, sent, calls,
    run: (name, args = '') => commands[name](args, ctx),
    user: content => append({ type: 'message', message: { role: 'user', content } }),
    assistant: stopReason => append({ type: 'message', message: { role: 'assistant', stopReason } }),
    tool: () => append({ type: 'message', message: { role: 'toolResult', isError: true } }),
    idle: value => { idle = value; }, pending: value => { pending = value; }, cancel: value => { cancel = value; },
  };
}

test('multiple undo/redo includes root, restores draft, preserves all entries', async () => {
  const h = harness(); h.user('one'); const a = h.assistant('stop'); h.user('two'); const b = h.assistant('stop');
  h.ctx.ui.setEditorText('draft');
  await h.run('undo'); assert.equal(h.sm.getLeafId(), a); assert.equal(h.ctx.ui.getEditorText(), 'two');
  await h.run('undo'); assert.equal(h.sm.getLeafId(), null);
  await h.run('redo'); assert.equal(h.sm.getLeafId(), a); assert.equal(h.ctx.ui.getEditorText(), 'two');
  await h.run('redo'); assert.equal(h.sm.getLeafId(), b); assert.equal(h.ctx.ui.getEditorText(), 'draft');
  assert.equal(h.entries.length, 4);
  assert.ok(h.calls.every(c => c.options.summarize === false));
});

test('user leaf uses metadata anchor rather than same-leaf no-op', async () => {
  const h = harness(); h.user('pending prompt');
  await h.run('undo'); assert.equal(h.sm.getLeafId(), null);
  await h.run('redo'); assert.equal(h.sm.getBranch()[0].message.content, 'pending prompt');
  assert.equal(h.sm.getBranch().at(-1).customType, 'chat-history-anchor');
});

test('cancelled navigation does not consume undo or redo', async () => {
  const h = harness(); h.user('one'); const a = h.assistant('stop');
  h.cancel(true); await h.run('undo'); assert.equal(h.sm.getLeafId(), a);
  h.cancel(false); await h.run('undo');
  h.cancel(true); await h.run('redo'); assert.equal(h.sm.getLeafId(), null);
  h.cancel(false); await h.run('redo'); assert.equal(h.sm.getLeafId(), a);
});

for (const event of ['session_start', 'session_tree', 'before_agent_start']) {
  test(`${event} invalidates redo`, async () => {
    const h = harness(); h.user('one'); h.assistant('stop'); await h.run('undo');
    await h.events[event]({}, h.ctx); await h.run('redo'); assert.equal(h.sm.getLeafId(), null);
  });
}

for (const reason of ['error', 'aborted']) {
  test(`retry allowed after ${reason}, preserves tool results and rejects duplicate`, async () => {
    const h = harness(); h.user('one'); h.assistant('toolUse'); h.tool(); h.assistant(reason);
    await h.run('retry'); assert.equal(h.sent.length, 1); assert.equal(h.entries.length, 5);
    assert.equal(h.sent[0].message.display, false); assert.equal(h.sent[0].options.triggerTurn, true);
    await h.run('retry'); assert.equal(h.sent.length, 1);
  });
}

test('abort during tool execution is eligible; successful settlement is not', async () => {
  const h = harness(); h.user('one'); h.assistant('toolUse'); h.tool();
  assert.equal(canRetry(h.sm.getBranch()), false);
  await h.events.agent_settled({ aborted: true }, h.ctx);
  assert.equal(canRetry(h.sm.getBranch()), true);
  await h.run('retry'); h.assistant('stop'); await h.events.agent_settled({ aborted: false }, h.ctx);
  await h.run('retry'); assert.equal(h.sent.length, 1);
});

test('new user prompt supersedes old failure; empty and successful branches reject retry', async () => {
  const h = harness(); await h.run('retry'); h.user('one'); h.assistant('error'); h.user('two');
  await h.run('retry'); h.assistant('stop'); await h.run('retry'); assert.equal(h.sent.length, 0);
});

test('busy, queued and argument-bearing commands do nothing', async () => {
  const h = harness(); h.user('one'); h.assistant('error');
  for (const name of ['undo', 'redo', 'retry']) {
    h.idle(false); await h.run(name); h.idle(true);
    h.pending(true); await h.run(name); h.pending(false);
    await h.run(name, 'unexpected');
  }
  assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0); assert.equal(h.notices.length, 9);
});
