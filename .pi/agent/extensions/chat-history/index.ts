import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const ABORTED = "chat-history-aborted";
const RETRY = "chat-history-retry";
const ANCHOR = "chat-history-anchor";

export function canRetry(branch: readonly SessionEntry[]): boolean {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type === "custom" && entry.customType === ABORTED) return true;
    if (entry.type === "custom_message") return false;
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") return false;
    if (entry.message.role === "assistant") {
      return entry.message.stopReason === "aborted" || entry.message.stopReason === "error";
    }
  }
  return false;
}

type Position = { target: string; from: string | null; editor: string };

export default function chatHistory(pi: ExtensionAPI) {
  let redo: Position[] = [];
  let navigating = false;
  let locked = false;
  const clear = () => { redo = []; };
  pi.on("session_start", clear);
  pi.on("before_agent_start", clear);
  pi.on("session_tree", () => { if (!navigating) clear(); });
  pi.on("agent_settled", (event) => {
    // Covers Escape during tool execution, not only an aborted provider response.
    if (event.aborted) pi.appendEntry(ABORTED, {});
  });

  function register(name: string, description: string, run: (ctx: ExtensionCommandContext) => Promise<void>) {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        if (args.trim()) { ctx.ui.notify(`Usage: /${name}`, "warning"); return; }
        if (locked || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("Stop the agent or wait for it to finish, and clear any queued messages first.", "warning");
          return;
        }
        locked = true;
        try { await run(ctx); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
        finally { locked = false; }
      },
    });
  }

  async function navigate(ctx: ExtensionCommandContext, target: string) {
    navigating = true;
    try { return await ctx.navigateTree(target, { summarize: false }); }
    finally { navigating = false; }
  }

  register("undo", "Undo the last chat turn (without changing files)", async (ctx) => {
    const sm = ctx.sessionManager;
    const user = sm.getBranch().findLast(e => e.type === "message" && e.message.role === "user");
    if (!user) { ctx.ui.notify("No turn to undo.", "info"); return; }
    let target = sm.getLeafId();
    if (!target) return;
    const leaf = sm.getEntry(target);
    // Pi selects user/custom messages BEFORE the entry. A metadata anchor lets
    // redo restore exactly this position and avoids navigateTree's same-leaf no-op.
    if (leaf?.type === "custom_message" || (leaf?.type === "message" && leaf.message.role === "user")) {
      pi.appendEntry(ANCHOR, {});
      target = sm.getLeafId()!;
    }
    const editor = ctx.ui.getEditorText();
    if ((await navigate(ctx, user.id)).cancelled) return;
    redo.push({ target, from: sm.getLeafId(), editor });
  });

  register("redo", "Restore a turn reverted by /undo (without changing files)", async (ctx) => {
    const next = redo.at(-1);
    if (!next) { ctx.ui.notify("No turn to redo.", "info"); return; }
    if (ctx.sessionManager.getLeafId() !== next.from) {
      clear();
      ctx.ui.notify("The branch has changed; redo history has been cleared.", "warning");
      return;
    }
    if ((await navigate(ctx, next.target)).cancelled) return;
    redo.pop();
    ctx.ui.setEditorText(next.editor);
  });

  register("retry", "Resume only after an interruption or provider error", async (ctx) => {
    if (!canRetry(ctx.sessionManager.getBranch())) {
      ctx.ui.notify("/retry is only available after an agent interruption or provider error.", "warning");
      return;
    }
    clear();
    // Public extension API has no bare continue(). A hidden custom message starts
    // another turn without resubmitting the original user prompt or dropping tools.
    pi.sendMessage({
      customType: RETRY,
      content: "Resume the interrupted agent run and complete the latest user request. Preserve completed work and existing tool results; do not repeat completed actions unnecessarily. If an interrupted action has uncertain side effects, inspect its state before retrying it.",
      display: false,
    }, { triggerTurn: true });
  });
}
