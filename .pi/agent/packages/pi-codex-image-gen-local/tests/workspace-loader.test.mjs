import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("global settings load only the local image plugin even if the npm copy remains on disk", async t => {
  const root = await mkdtemp(join(tmpdir(), "image-local-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const installed = join(agentDir, "npm", "node_modules", "pi-codex-image-gen");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(installed, "skills", "imagegen"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
  await writeFile(join(installed, "package.json"), JSON.stringify({
    name: "pi-codex-image-gen", version: "0.3.0", type: "module",
    pi: { extensions: ["./index.ts"], skills: ["./skills"] },
  }));
  await writeFile(join(installed, "index.ts"), 'throw new Error("Unconfigured npm fixture must not load");\n');
  await writeFile(join(installed, "skills", "imagegen", "SKILL.md"),
    '---\nname: imagegen\ndescription: Unconfigured npm fixture\n---\n');

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const owners = result.extensions.filter(extension => extension.tools.has("codex_generate_image"));
  assert.equal(owners.length, 1);
  assert.equal(await realpath(owners[0].resolvedPath), await realpath(join(packageRoot, "index.ts")));
  assert.deepEqual(owners[0].tools.get("codex_generate_image").definition.parameters.properties.background.enum,
    ["auto", "opaque", "transparent"]);
  const skills = loader.getSkills().skills.filter(skill => skill.name === "imagegen");
  assert.equal(skills.length, 1);
  assert.equal(await realpath(skills[0].filePath), await realpath(join(packageRoot, "skills", "imagegen", "SKILL.md")));
});
