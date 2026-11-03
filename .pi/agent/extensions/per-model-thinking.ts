/** Remember the last explicitly changed thinking level for each provider/model. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ModelId = { provider: string; id: string };
type Change = { key: string; previousLevel: Level; level: Level };

const levels = new Set<Level>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const keyOf = (model: ModelId) => JSON.stringify([model.provider, model.id]);
const directory = join(getAgentDir(), "per-model-thinking");
const fileFor = (model: ModelId) =>
  join(directory, `${createHash("sha256").update(keyOf(model)).digest("hex")}.json`);

function readLevel(model: ModelId): Level | undefined {
  try {
    const data = JSON.parse(readFileSync(fileFor(model), "utf8"));
    if (data.provider === model.provider && data.model === model.id && levels.has(data.level)) return data.level;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  return undefined;
}

function saveLevel(model: ModelId, level: Level) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = fileFor(model);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ provider: model.provider, model: model.id, level }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
}

// Explicit command-line thinking choices take priority on initial startup.
function hasExplicitStartupLevel(): boolean {
  const args = process.argv.slice(2);
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  if (options.some((arg) => arg === "--thinking" || arg.startsWith("--thinking="))) return true;
  const modelIndex = options.indexOf("--model");
  const modelArg = modelIndex >= 0 ? options[modelIndex + 1] : options.find((arg) => arg.startsWith("--model="))?.slice(8);
  return !!modelArg && /:(off|minimal|low|medium|high|xhigh|max)$/.test(modelArg);
}

export default function (pi: ExtensionAPI) {
  let activeKey: string | undefined;
  let activeLevel: Level | undefined;
  let firstStart = true;
  let applying = false;
  let ownEventSeen = false;
  let ignored: Change[] = [];
  let earlySwitchChanges: Change[] = [];

  // Events from Pi's model switch or our own restore are not user changes.
  // Pi does not await thinking events; another extension may delay their delivery.
  function ignore(change: Change) {
    ignored.push(change);
    setTimeout(() => { ignored = ignored.filter((item) => item !== change); }, 30_000).unref();
  }

  function sameChange(a: Change, b: Change) {
    return a.key === b.key && a.previousLevel === b.previousLevel && a.level === b.level;
  }

  function restore(model: ModelId) {
    const saved = readLevel(model);
    if (!saved || saved === pi.getThinkingLevel()) return;
    const previousLevel = pi.getThinkingLevel() as Level;
    ownEventSeen = false;
    applying = true;
    try { pi.setThinkingLevel(saved); } finally { applying = false; }
    const effective = pi.getThinkingLevel() as Level;
    if (effective !== previousLevel && !ownEventSeen) ignore({ key: keyOf(model), previousLevel, level: effective });
  }

  pi.on("session_start", (_event, ctx) => {
    const model = ctx.model;
    activeKey = model ? keyOf(model) : undefined;
    activeLevel = pi.getThinkingLevel() as Level;
    const explicitScope = model && ctx.scopedModels.some((item) =>
      keyOf(item.model) === activeKey && item.thinkingLevel !== undefined,
    );
    const explicitStartup = firstStart && hasExplicitStartupLevel();
    firstStart = false;
    if (model && !explicitStartup && !explicitScope) restore(model);
    activeLevel = pi.getThinkingLevel() as Level;
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    const key = keyOf(model);
    const change = { key, previousLevel: event.previousLevel, level: event.level };
    const index = ignored.findIndex((item) => sameChange(item, change));
    if (index >= 0) { ignored.splice(index, 1); return; }
    if (applying) { ownEventSeen = true; return; }
    if (key !== activeKey) {
      earlySwitchChanges.push(change);
      setTimeout(() => { earlySwitchChanges = earlySwitchChanges.filter((item) => item !== change); }, 30_000).unref();
      return;
    }
    // A delayed event must not overwrite a more recent choice.
    if (event.level !== pi.getThinkingLevel()) return;
    activeLevel = event.level;
    saveLevel(model, event.level);
  });

  pi.on("model_select", (event, ctx) => {
    const key = keyOf(event.model);
    const switchedLevel = pi.getThinkingLevel() as Level;
    if (activeLevel !== undefined && activeLevel !== switchedLevel) {
      const change = { key, previousLevel: activeLevel, level: switchedLevel };
      const index = earlySwitchChanges.findIndex((item) => sameChange(item, change));
      if (index >= 0) earlySwitchChanges.splice(index, 1);
      else ignore(change);
    }
    activeKey = key;
    // An explicit scoped level is an intentional choice and wins when cycling.
    const explicitScope = event.source === "cycle" && ctx.scopedModels.some((item) =>
      keyOf(item.model) === key && item.thinkingLevel !== undefined,
    );
    if (!explicitScope) restore(event.model);
    activeLevel = pi.getThinkingLevel() as Level;
  });

  // Pi emits no thinking event when the selected level is already active.
  pi.registerCommand("remember-thinking", {
    description: "Remember the current thinking level for this model",
    handler: async (_args, ctx) => {
      if (!ctx.model) {
        if (ctx.hasUI) ctx.ui.notify("No model selected", "warning");
        return;
      }
      const level = pi.getThinkingLevel() as Level;
      saveLevel(ctx.model, level);
      if (ctx.hasUI) ctx.ui.notify(`Remembered ${level} for ${ctx.model.provider}/${ctx.model.id}`, "info");
    },
  });
}
