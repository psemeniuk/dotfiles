import { join } from "node:path";

export type Env = Record<string, string | undefined>;
export type Run = (command: string, args: string[]) => Promise<string>;
export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const apple = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r") + '"';

export function detectTerminal(env: Env, platform = process.platform) {
  if (env.REX_BLOCK && env.REX_SERVER) return "rex";
  if (env.HC_TERMINAL_ID || env.__CFBundleIdentifier === "dev.herdr.app") return "herdr";
  if (env.TERM_PROGRAM === "ghostty" && platform === "darwin") return "ghostty";
  throw new Error("Nie wykryto obsługiwanego terminala (Herdr, Rex lub Ghostty na macOS).");
}

// Resolve the anchor before creating any session or pane. Never target another
// focused tab when an explicit terminal identity cannot be found.
export async function preparePane(env: Env, run: Run, platform = process.platform) {
  const kind = detectTerminal(env, platform);
  if (kind === "herdr") {
    if (!env.HC_TERMINAL_ID) throw new Error("Brak HC_TERMINAL_ID dla Herdr.");
    const layout = JSON.parse(await run("herdr-app", ["ls"]));
    const matches = (layout.spaces ?? []).filter((s: any) => !s.machine)
      .flatMap((s: any) => s.tabs ?? []).flatMap((t: any) => t.terminals ?? [])
      .filter((t: any) => t.terminal === env.HC_TERMINAL_ID);
    if (matches.length !== 1 || !matches[0].pane) throw new Error("Nie znaleziono jednoznacznie bieżącego panelu Herdr.");
    return { kind, open: (argv: string[], cwd: string) => run("herdr-app", ["do", "pane.split", JSON.stringify({
      pane: matches[0].pane, direction: "right",
      argv: ["/bin/sh", "-c", `cd ${quote(cwd)} && exec ${argv.map(quote).join(" ")}`],
    })]) };
  }
  if (kind === "rex") {
    const executable = env.REX_BIN_DIR ? join(env.REX_BIN_DIR, "rex") : "rex";
    return { kind, open: (argv: string[], cwd: string) => run(executable, [
      "-S", env.REX_SERVER!, "split", "-b", env.REX_BLOCK!, "--split=right", "--cwd", cwd,
      "--shell=none", "--", ...argv,
    ]) };
  }
  // Capture the focused terminal once; subsequent focus changes must not retarget the split.
  const id = env.GHOSTTY_SURFACE_ID || (await run("osascript", ["-e",
    'tell application "Ghostty" to get id of focused terminal of selected tab of front window',
  ])).trim();
  if (!id) throw new Error("Ghostty nie zwrócił identyfikatora terminala.");
  return { kind, open: (argv: string[], cwd: string) => run("osascript", ["-e", `tell application "Ghostty"
set anchor to first terminal whose id is ${apple(id)}
set cfg to new surface configuration
set initial working directory of cfg to ${apple(cwd)}
set command of cfg to ${apple(argv.map(quote).join(" "))}
split anchor direction right with configuration cfg
end tell`]) };
}
