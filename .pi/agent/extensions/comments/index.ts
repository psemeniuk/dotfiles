import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addComment, buildPrompt, editComment, emptyState, ENTRY_TYPE, messageText, nextId, reconcile, restore, sources } from "./model.ts";
import type { Comment, SourceMessage } from "./model.ts";
import { AnswerView, CommentEditor, CommentsView } from "./view.ts";
import { commentsAutocomplete } from "./autocomplete.ts";

export default function commentsExtension(pi: ExtensionAPI) {
  let state = emptyState();
  let answering = false;
  let open = false;
  const status = (ctx: ExtensionContext) => {
    const drafts = state.comments.filter(c => !c.batchId).length;
    ctx.ui.setStatus("response-comments", state.comments.length ? `Comments: ${drafts} drafts · ${state.comments.length - drafts} sent · /comments` : undefined);
  };
  const save = (ctx: ExtensionContext) => {
    pi.appendEntry(ENTRY_TYPE, structuredClone(state));
    status(ctx);
  };
  const refresh = (ctx: ExtensionContext, persist = false) => {
    const entries = ctx.sessionManager.getBranch();
    const before = JSON.stringify(state);
    state = restore(entries);
    reconcile(state, entries);
    if (persist && JSON.stringify(state) !== before) save(ctx);
    else status(ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    answering = false; open = false; refresh(ctx);
    if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider(current => commentsAutocomplete(current, () => ({
      drafts: state.comments.some(c => !c.batchId), comments: state.comments.length > 0,
    })));
  });
  pi.on("session_tree", (_event, ctx) => { answering = false; refresh(ctx); });
  pi.on("before_agent_start", (event, ctx) => {
    refresh(ctx);
    answering = event.messageType === "user" && state.batches.some(b => b.prompt === event.prompt);
  });
  // Enforce the answer-only contract even if a model ignores the prompt.
  pi.on("tool_call", () => answering ? { block: true, reason: "This turn answers submitted comments only. Do not use tools or make changes; answer each comment in text." } : undefined);
  pi.on("agent_end", (_event, ctx) => refresh(ctx, true));
  pi.on("agent_settled", () => { answering = false; });
  pi.on("session_shutdown", () => { answering = false; open = false; });

  pi.registerCommand("comments", {
    description: "Annotate assistant responses in a mouse-enabled overlay ([ / ] changes response)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("/comments requires the interactive terminal UI.", "error"); return; }
      if (!ctx.isIdle()) { ctx.ui.notify("Wait for the agent to finish before commenting.", "warning"); return; }
      if (open) return;
      refresh(ctx);
      const messages = sources(ctx.sessionManager.getBranch());
      if (!messages.length) { ctx.ui.notify("No assistant responses to comment on yet.", "info"); return; }
      open = true;
      const edit = async (source: SourceMessage, start: number, end: number, existing?: Comment) => {
        if (existing?.batchId) {
          let body = `Quoted passage:\n${existing.quote}\n\nYour comment:\n${existing.text}\n\n`;
          if (existing.answer) body += `Answer:\n${existing.answer}`;
          else if (existing.answerMessageId) {
            const entry = ctx.sessionManager.getBranch().find(e => e.id === existing.answerMessageId);
            body += "No unambiguous section for this comment was found. Full response (not assigned to this comment):\n\n";
            if (entry?.type === "message") body += messageText(entry.message);
          } else body += "No completed answer yet (the run may have been interrupted). See the submitted prompt in the chat. This comment is read-only.";
          await ctx.ui.custom<void>((tui, theme, _kb, done) => new AnswerView(tui, theme, `${existing.id} · submitted · read-only`, body, done),
            { overlay: true, overlayOptions: { width: "80%", anchor: "center" } });
          return;
        }
        const result = await ctx.ui.custom<{ text: string } | { delete: true } | undefined>((tui, theme, _kb, done) =>
          new CommentEditor(tui, theme, existing ? `${existing.id} · edit draft` : "New comment · draft", existing?.text ?? "", done, !!existing),
          { overlay: true, overlayOptions: { width: "70%", anchor: "center" } });
        if (!result) return;
        if ("delete" in result) state.comments = state.comments.filter(c => c.id !== existing?.id);
        else if (existing) editComment(existing, result.text);
        else addComment(state, source, start, end, result.text, nextId(ctx.sessionManager.getEntries(), state));
        save(ctx);
      };
      try {
        await ctx.ui.custom<void>((tui, theme, _kb, done) => new CommentsView(tui, theme, messages, () => state.comments, edit, done,
          error => ctx.ui.notify(String(error), "error")), { overlay: true, overlayOptions: { width: "95%", anchor: "center" } });
      } finally { open = false; }
    },
  });

  pi.registerCommand("cancel-comments", {
    description: "Discard active comments and clear their highlights (chat history is unchanged)",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || open) { ctx.ui.notify("Close the comments overlay and wait until the agent is idle before cancelling.", "warning"); return; }
      refresh(ctx);
      if (!state.comments.length) { ctx.ui.notify("No active comments to cancel.", "info"); return; }
      state = emptyState();
      save(ctx);
      ctx.ui.notify("Comments cancelled. Chat history is unchanged.", "info");
    },
  });

  pi.registerCommand("submit-comments", {
    description: "Send all draft comments as an answer-only user prompt; lock submitted comments",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle() || open) { ctx.ui.notify("Close the comments overlay and wait until the agent is idle.", "warning"); return; }
      refresh(ctx);
      const drafts = state.comments.filter(c => !c.batchId);
      if (!drafts.length) { ctx.ui.notify("No draft comments to submit. Use /comments first.", "info"); return; }
      const previous = structuredClone(state);
      const prompt = buildPrompt(drafts);
      const id = drafts.map(c => c.id).join("+");
      state.batches.push({ id, ids: drafts.map(c => c.id), prompt });
      for (const c of drafts) c.batchId = id;
      save(ctx);
      try { pi.sendUserMessage(prompt); }
      catch (error) { state = previous; save(ctx); throw error; }
    },
  });
}
