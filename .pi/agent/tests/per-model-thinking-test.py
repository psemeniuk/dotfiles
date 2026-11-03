#!/usr/bin/env python3
"""Integration tests against the installed Pi RPC runtime; no provider calls are made."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

EXTENSION = Path(__file__).resolve().parents[1] / "extensions/per-model-thinking.ts"


class Pi:
    def __init__(self, agent, *args, before=None):
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent)}
        self.process = subprocess.Popen(
            ["pi", "--offline", "--no-session", "--mode", "rpc", "-ne",
             *(["-e", str(before)] if before else []), "-e", str(EXTENSION), *args],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.serial = 0

    def call(self, command, **fields):
        self.serial += 1
        identity = str(self.serial)
        self.process.stdin.write(json.dumps({"id": identity, "type": command, **fields}) + "\n")
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise AssertionError(f"Pi exited: {self.process.stderr.read()}")
            result = json.loads(line)
            if result.get("id") == identity and result.get("type") == "response":
                if not result["success"]:
                    raise AssertionError(result)
                # Pi emits thinking events asynchronously; allow them to finish.
                time.sleep(0.02)
                return result.get("data")

    def level(self):
        return self.call("get_state")["thinkingLevel"]

    def switch(self, model):
        self.call("set_model", provider="test", modelId=model)

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=10)
        errors = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        if self.process.returncode or errors:
            raise AssertionError(f"Pi exited {self.process.returncode}: {errors}")


class ThinkingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.agent = Path(self.temp.name)
        (self.agent / "settings.json").write_text(json.dumps({
            "defaultProvider": "test", "defaultModel": "model-a", "defaultThinkingLevel": "medium",
            "enabledModels": ["test/model-a", "test/model-b", "test/no-reasoning"],
        }))
        (self.agent / "models.json").write_text(json.dumps({"providers": {"test": {
            "baseUrl": "http://localhost:1234/v1", "api": "openai-completions", "apiKey": "test",
            "models": [{"id": "model-a", "reasoning": True}, {"id": "model-b", "reasoning": True},
                       {"id": "no-reasoning", "reasoning": False}],
        }}}))
        self.pi = Pi(self.agent)

    def tearDown(self):
        self.pi.close()
        self.temp.cleanup()

    def test_switch_restart_and_nonreasoning(self):
        self.pi.call("set_thinking_level", level="high")
        self.pi.switch("model-b")
        self.pi.call("set_thinking_level", level="low")
        self.pi.switch("model-a")
        self.assertEqual(self.pi.level(), "high")
        self.pi.switch("no-reasoning")
        self.assertEqual(self.pi.level(), "off")
        self.pi.switch("model-b")
        self.assertEqual(self.pi.level(), "low")
        self.pi.close()
        self.pi = Pi(self.agent)
        self.assertEqual(self.pi.level(), "high")
        self.pi.switch("model-b")
        self.assertEqual(self.pi.level(), "low")

    def test_explicit_startup_and_cycle(self):
        self.pi.call("set_thinking_level", level="high")
        self.pi.close()
        self.pi = Pi(self.agent, "--thinking", "low")
        self.assertEqual(self.pi.level(), "low")
        self.pi.call("cycle_model")
        self.pi.call("cycle_model")
        self.pi.call("cycle_model")
        self.assertEqual(self.pi.level(), "high")

    def test_off_is_remembered(self):
        self.pi.call("set_thinking_level", level="off")
        self.pi.switch("model-b")
        self.pi.call("set_thinking_level", level="high")
        self.pi.switch("model-a")
        self.assertEqual(self.pi.level(), "off")
        self.pi.close()
        self.pi = Pi(self.agent)
        self.assertEqual(self.pi.level(), "off")

    def test_remember_unchanged_level(self):
        self.pi.call("prompt", message="/remember-thinking")
        saved = [json.loads(path.read_text()) for path in (self.agent / "per-model-thinking").glob("*.json")]
        self.assertEqual(saved, [{"provider": "test", "model": "model-a", "level": "medium"}])

    def test_scoped_override(self):
        self.pi.call("set_thinking_level", level="high")
        self.pi.close()
        self.pi = Pi(self.agent, "--models", "test/model-a:low,test/model-b")
        self.assertEqual(self.pi.level(), "low")
        self.pi.call("cycle_model")
        self.pi.call("cycle_model")
        self.assertEqual(self.pi.level(), "low")
        self.pi.switch("model-b")
        self.pi.switch("model-a")
        self.assertEqual(self.pi.level(), "high")

    def test_delayed_thinking_event(self):
        self.pi.call("set_thinking_level", level="high")
        self.pi.switch("model-b")
        self.pi.call("set_thinking_level", level="low")
        self.pi.close()
        delay = self.agent / "delay.ts"
        delay.write_text('export default function(pi) { pi.on("thinking_level_select", async () => { await new Promise(r => setTimeout(r, 10)); }); }')
        self.pi = Pi(self.agent, before=delay)
        self.pi.switch("model-b")
        self.assertEqual(self.pi.level(), "low")
        self.pi.switch("model-a")
        self.assertEqual(self.pi.level(), "high")
        self.pi.switch("model-b")
        self.assertEqual(self.pi.level(), "low")

    def test_delayed_scoped_override_is_not_saved(self):
        self.pi.call("set_thinking_level", level="high")
        self.pi.close()
        delay = self.agent / "delay.ts"
        delay.write_text('export default function(pi) { pi.on("thinking_level_select", async () => { await new Promise(r => setTimeout(r, 10)); }); }')
        self.pi = Pi(self.agent, "--models", "test/model-a:low,test/model-b", before=delay)
        self.pi.call("cycle_model")
        self.pi.call("cycle_model")
        self.assertEqual(self.pi.level(), "low")
        self.pi.switch("model-b")
        self.pi.switch("model-a")
        self.assertEqual(self.pi.level(), "high")


if __name__ == "__main__":
    unittest.main()
