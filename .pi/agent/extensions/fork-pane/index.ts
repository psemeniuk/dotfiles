import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { preparePane } from "./terminal.ts";

const PREFILL = "fork-pane-prefill";

export function createFork(source: string, sessionDir: string, entryId: string, position: "before" | "at") {
  const copy = SessionManager.open(source, sessionDir);
  const selected = copy.getEntry(entryId);
  if (!selected) throw new Error("Nie znaleziono punktu forkowania.");
  if (position === "before" && (selected.type !== "message" || selected.message.role !== "user")) {
    throw new Error("Fork wymaga wiadomości użytkownika.");
  }
  const leaf = position === "at" ? selected.id : selected.parentId;
  if (leaf) copy.createBranchedSession(leaf);
  else copy.newSession({ parentSession: source });
  if (position === "before" && selected.type === "message") {
    const content = selected.message.content;
    const text = typeof content === "string" ? content : content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    copy.appendCustomEntry(PREFILL, { text });
  }
  const path = copy.getSessionFile();
  if (!path || path === source) throw new Error("Nie udało się utworzyć niezależnej sesji.");
  // Pi defers persistence for branches without conversation messages.
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, [copy.getHeader(), ...copy.getEntries()].map(e => JSON.stringify(e)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  }
  chmodSync(path, 0o600);
  return path;
}

export default function forkPane(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const last = ctx.sessionManager.getBranch().at(-1);
    if (last?.type === "custom" && last.customType === PREFILL) {
      const text = (last.data as { text?: string })?.text;
      if (typeof text === "string") ctx.ui.setEditorText(text);
      pi.appendEntry("fork-pane-prefill-consumed", {});
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    // RPC and print retain native Pi semantics. /clone (position=at) is unchanged.
    if (ctx.mode !== "tui" || event.position !== "before") return;
    let forkPath: string | undefined;
    try {
      if (!ctx.isIdle()) throw new Error("Poczekaj na zakończenie odpowiedzi przed forkowaniem.");
      const source = ctx.sessionManager.getSessionFile();
      if (!source || !existsSync(source)) throw new Error("Najpierw zapisz sesję (wyślij wiadomość).");
      const run = async (command: string, args: string[]) => {
        const result = await pi.exec(command, args, { timeout: 15000 });
        if (result.code !== 0 || result.killed) throw new Error(`${command}: ${result.stderr || result.stdout || "błąd lub timeout"}`);
        return result.stdout;
      };
      const pane = await preparePane(process.env, run);
      forkPath = createFork(source, ctx.sessionManager.getSessionDir(), event.entryId, event.position);
      const argv = [process.execPath, process.argv[1], "--session", forkPath];
      if (ctx.model) argv.push("--provider", ctx.model.provider, "--model", ctx.model.id);
      argv.push("--thinking", pi.getThinkingLevel());
      await pane.open(argv, ctx.cwd);
      ctx.ui.notify(`Fork otwarty w prawym panelu (${pane.kind}).`, "info");
    } catch (error) {
      // Do not retry pane creation: a timed-out request may have succeeded.
      ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}${forkPath ? `\nKopia sesji: ${forkPath}` : ""}`, "error");
    }
    // Never let a failure replace the current session as a fallback.
    return { cancel: true };
  });
}
