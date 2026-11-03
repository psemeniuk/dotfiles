#!/usr/bin/env python3
"""Exercise the local extension through Pi RPC and a loopback-only fake provider."""
import base64
from compression import zstd
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import tempfile
import threading
import unittest

EXTENSION = Path(__file__).resolve().parents[1] / "index.ts"


def token():
    payload = {"https://api.openai.com/auth": {"chatgpt_account_id": "test-account"}}
    middle = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"header.{middle}.signature"


class Provider(BaseHTTPRequestHandler):
    def do_GET(self):
        # Minimal WebSocket server for one real Codex transport request.
        try:
            key = self.headers["Sec-WebSocket-Key"]
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            header = self.rfile.read(2)
            size = header[1] & 127
            if size == 126:
                size = struct.unpack("!H", self.rfile.read(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.rfile.read(8))[0]
            mask = self.rfile.read(4) if header[1] & 128 else None
            data = self.rfile.read(size)
            if mask:
                data = bytes(byte ^ mask[i % 4] for i, byte in enumerate(data))
            self.server.ws_requests.put(json.loads(data))
            item = {"type": "message", "id": "msg_test", "role": "assistant",
                    "content": [{"type": "output_text", "text": "ok", "annotations": []}]}
            events = [
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": {"id": "resp_test", "status": "completed", "output": [item]}},
            ]
            for event in events:
                payload = json.dumps(event).encode()
                prefix = bytes([0x81, len(payload)]) if len(payload) < 126 else b"\x81\x7e" + struct.pack("!H", len(payload))
                self.wfile.write(prefix + payload)
                self.wfile.flush()
        except Exception as error:
            self.server.ws_requests.put(error)
            raise

    def do_POST(self):
        try:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "zstd":
                body = zstd.decompress(body)
            self.server.requests.put(json.loads(body))
            self.server.headers.put(dict(self.headers))
            if self.headers.get("anthropic-version"):
                events = [
                    {"type": "message_start", "message": {"id": "msg_test", "type": "message", "role": "assistant",
                     "model": "claude-opus-5", "content": [], "stop_reason": None, "stop_sequence": None,
                     "usage": {"input_tokens": 1, "output_tokens": 0}}},
                    {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "ok"}},
                    {"type": "content_block_stop", "index": 0},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                     "usage": {"output_tokens": 1}},
                    {"type": "message_stop"},
                ]
                response = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode()
            else:
                item = {"type": "message", "id": "msg_test", "role": "assistant",
                        "content": [{"type": "output_text", "text": "ok", "annotations": []}]}
                events = [
                    {"type": "response.output_item.done", "output_index": 0, "item": item},
                    {"type": "response.completed", "response": {"id": "resp_test", "status": "completed",
                     "output": [item], "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}},
                ]
                response = "".join(f"data: {json.dumps(event)}\n\n" for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        except Exception as error:
            self.server.requests.put(error)
            raise

    def log_message(self, *args):
        pass


class Pi:
    def __init__(self, agent, *args, before=None):
        env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent)}
        self.process = subprocess.Popen(
            ["pi", "--offline", "--no-session", "--mode", "rpc", "-ne", "-ns", "-nc",
             *( ["-e", str(before)] if before else [] ), "-e", str(EXTENSION), *args],
            cwd=agent, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        self.lines = queue.Queue()
        self.events = []
        self.serial = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def next(self):
        try:
            line = self.lines.get(timeout=15)
        except queue.Empty:
            raise AssertionError("Timed out waiting for Pi RPC") from None
        if line is None:
            raise AssertionError(f"Pi exited: {self.process.stderr.read()}")
        result = json.loads(line)
        self.events.append(result)
        return result

    def call(self, command, **fields):
        self.serial += 1
        identity = str(self.serial)
        self.process.stdin.write(json.dumps({"id": identity, "type": command, **fields}) + "\n")
        self.process.stdin.flush()
        while True:
            result = self.next()
            if result.get("id") == identity and result.get("type") == "response":
                if not result["success"]:
                    raise AssertionError(result)
                return result.get("data")

    def switch(self, model, provider="openai-codex"):
        return self.call("set_model", provider=provider, modelId=model)

    def command(self, command):
        start = len(self.events)
        self.call("prompt", message=command)
        return self.events[start:]

    def request(self, requests):
        state = self.call("get_state")
        if not state["model"]["baseUrl"].startswith("http://127.0.0.1:"):
            raise AssertionError("Refusing a non-loopback provider request")
        start = len(self.events)
        self.call("prompt", message="hello")
        while not any(event.get("type") == "agent_settled" for event in self.events[start:]):
            self.next()
        messages = [event["message"] for event in self.events[start:]
                    if event.get("type") == "message_end" and event.get("message", {}).get("role") == "assistant"]
        if not messages or messages[-1].get("stopReason") == "error":
            raise AssertionError(f"Provider call failed: {messages}")
        result = requests.get(timeout=5)
        if isinstance(result, Exception):
            raise result
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=10)
        errors = self.process.stderr.read()
        self.process.stdout.close()
        self.process.stderr.close()
        if self.process.returncode or errors:
            raise AssertionError(f"Pi exited {self.process.returncode}: {errors}")


class FastTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.agent = Path(self.temp.name)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        self.server.requests = queue.Queue()
        self.server.headers = queue.Queue()
        self.server.ws_requests = queue.Queue()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{self.server.server_port}/v1"
        (self.agent / "settings.json").write_text(json.dumps({
            "defaultProvider": "openai-codex", "defaultModel": "gpt-6.1-terra", "transport": "sse",
            "enabledModels": ["openai-codex/gpt-6.1-terra", "openai-codex/gpt-6.1-sol",
                              "openai-codex/gpt-6-astra", "openai-codex/unsupported",
                              "openai/gpt-6.1-sol", "anthropic/claude-opus-5"],
        }))
        def models(*ids):
            return [{"id": name, "name": name, "reasoning": False} for name in ids]
        (self.agent / "models.json").write_text(json.dumps({"providers": {
            "openai-codex": {"baseUrl": url, "api": "openai-codex-responses",
                             "models": models("gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra", "unsupported")},
            "openai": {"baseUrl": url, "api": "openai-responses", "apiKey": "test-key",
                       "models": models("gpt-6.1-sol", "gpt-6-astra")},
            "anthropic": {"baseUrl": url, "api": "anthropic-messages", "apiKey": "test-key",
                          "models": models("claude-opus-5")},
        }}))
        (self.agent / "auth.json").write_text(json.dumps({
            "openai-codex": {"type": "oauth", "access": token(), "refresh": "unused",
                             "expires": 4102444800000, "accountId": "test-account"},
            "openai": {"type": "api_key", "key": "test-key"},
            "anthropic": {"type": "api_key", "key": "test-key"},
        }))
        self.processes = []
        self.pi = self.start()

    def start(self, *args, **kwargs):
        process = Pi(self.agent, *args, **kwargs)
        self.processes.append(process)
        return process

    def tearDown(self):
        for process in self.processes:
            process.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def request(self, process=None):
        return (process or self.pi).request(self.server.requests)

    def preferences(self):
        return {(data["provider"], data["model"]): data["enabled"]
                for path in (self.agent / "per-model-fast").glob("*.json")
                for data in [json.loads(path.read_text())]}

    def test_terra_switch_restart_and_tier(self):
        self.assertNotIn("service_tier", self.request())
        events = self.pi.command("/fast")
        self.assertTrue(any(e.get("statusText") == "fast" for e in events))
        self.assertEqual(self.request()["service_tier"], "priority")

        self.pi.switch("gpt-6.1-sol")
        self.assertNotIn("service_tier", self.request())
        self.pi.command("/fast")
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.switch("gpt-6.1-terra")
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.command("/fast")
        self.assertNotIn("service_tier", self.request())

        self.pi.switch("gpt-6.1-sol", "openai")
        self.assertNotIn("service_tier", self.request())
        self.pi.command("/fast")
        self.assertEqual(self.request()["service_tier"], "fast")
        self.pi.call("new_session")
        self.assertNotIn("service_tier", self.request())  # A new session selects the default Terra model.
        self.pi.switch("gpt-6.1-sol", "openai")
        self.assertEqual(self.request()["service_tier"], "fast")

        self.pi.close()
        self.processes.remove(self.pi)
        self.pi = self.start()
        self.assertNotIn("service_tier", self.request())  # Terra was explicitly disabled.
        self.pi.switch("gpt-6.1-sol")
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.switch("gpt-6.1-sol", "openai")
        self.assertEqual(self.request()["service_tier"], "fast")
        self.assertEqual(self.preferences(), {
            ("openai-codex", "gpt-6.1-terra"): False,
            ("openai-codex", "gpt-6.1-sol"): True,
            ("openai", "gpt-6.1-sol"): True,
        })

    def test_unsupported_does_not_save_or_leak(self):
        self.pi.command("/fast")
        self.pi.switch("unsupported")
        self.assertNotIn("service_tier", self.request())
        events = self.pi.command("/fast")
        self.assertTrue(any("Cannot enable Fast mode" in e.get("message", "") for e in events))
        self.assertEqual(self.preferences(), {("openai-codex", "gpt-6.1-terra"): True})
        self.pi.switch("gpt-6.1-terra")
        self.assertEqual(self.request()["service_tier"], "priority")

    def test_anthropic_retains_its_own_fast_preference(self):
        self.pi.switch("claude-opus-5", "anthropic")
        self.assertNotIn("speed", self.request())
        self.server.headers.get(timeout=5)
        self.pi.command("/fast")
        self.assertEqual(self.request()["speed"], "fast")
        headers = {key.lower(): value for key, value in self.server.headers.get(timeout=5).items()}
        self.assertIn("fast-mode-2026-02-01", headers.get("anthropic-beta", ""))
        self.pi.switch("gpt-6.1-terra")
        self.assertNotIn("service_tier", self.request())
        self.pi.switch("claude-opus-5", "anthropic")
        self.assertEqual(self.request()["speed"], "fast")

    def test_astra_fast_status_has_red_background(self):
        self.pi.switch("gpt-6-astra")
        events = self.pi.command("/fast")
        label = next(e["statusText"] for e in events if e.get("method") == "setStatus" and e.get("statusText"))
        self.assertIn("fast", label)
        self.assertRegex(label, r"\x1b\[(?:48;2;204;0;0|48;5;160)m")
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.switch("gpt-6.1-terra")
        events = self.pi.command("/fast")
        self.assertTrue(any(e.get("statusText") == "fast" for e in events))
        start = len(self.pi.events)
        self.pi.switch("gpt-6-astra")
        self.assertTrue(any("\x1b[" in e.get("statusText", "") for e in self.pi.events[start:]))
        events = self.pi.command("/fast")
        self.assertTrue(any(e.get("method") == "setStatus" and not e.get("statusText") for e in events))
        self.pi.switch("gpt-6-astra", "openai")
        events = self.pi.command("/fast")
        label = next(e["statusText"] for e in events if e.get("method") == "setStatus" and e.get("statusText"))
        self.assertRegex(label, r"\x1b\[(?:48;2;204;0;0|48;5;160)m")
        self.assertEqual(self.request()["service_tier"], "fast")

    def test_codex_websocket_carries_priority(self):
        self.pi.close()
        self.processes.remove(self.pi)
        path = self.agent / "settings.json"
        settings = json.loads(path.read_text())
        settings["transport"] = "websocket"
        path.write_text(json.dumps(settings))
        self.pi = self.start()
        self.pi.command("/fast")
        payload = self.pi.request(self.server.ws_requests)
        self.assertEqual(payload["model"], "gpt-6.1-terra")
        self.assertEqual(payload["service_tier"], "priority")
        self.assertTrue(self.server.requests.empty(), "WebSocket test fell back to SSE")

    def test_existing_service_tier_is_not_overwritten(self):
        self.pi.close()
        self.processes.remove(self.pi)
        before = self.agent / "existing-tier.ts"
        before.write_text('export default function(pi) { pi.on("before_provider_request", e => ({...e.payload, service_tier: "flex"})); }')
        self.pi = self.start(before=before)
        self.pi.command("/fast")
        self.assertEqual(self.request()["service_tier"], "flex")

    def test_separate_processes_do_not_clobber_different_models(self):
        other = self.start()
        self.pi.command("/fast")
        other.switch("gpt-6.1-sol")
        other.command("/fast")
        self.assertEqual(self.preferences(), {
            ("openai-codex", "gpt-6.1-terra"): True,
            ("openai-codex", "gpt-6.1-sol"): True,
        })
        self.assertEqual(self.request(self.pi)["service_tier"], "priority")
        self.assertEqual(self.request(other)["service_tier"], "priority")
        other.command("/fast")
        self.pi.switch("gpt-6.1-sol")
        self.assertNotIn("service_tier", self.request(self.pi))
        self.pi.switch("gpt-6.1-terra")
        self.assertEqual(self.request(self.pi)["service_tier"], "priority")

    def test_turning_off_an_ineligible_saved_model(self):
        self.pi.command("/fast")
        self.pi.close()
        self.processes.remove(self.pi)
        path = self.agent / "models.json"
        data = json.loads(path.read_text())
        terra = next(model for model in data["providers"]["openai-codex"]["models"] if model["id"] == "gpt-6.1-terra")
        terra["api"] = "openai-responses"
        path.write_text(json.dumps(data))
        self.pi = self.start()
        self.pi.command("/fast")  # A saved on state can be disabled after the API changes.
        self.assertEqual(self.preferences()[("openai-codex", "gpt-6.1-terra")], False)
        events = self.pi.command("/fast")
        self.assertTrue(any("not openai-codex-responses" in e.get("message", "") for e in events))
        self.assertEqual(self.preferences()[("openai-codex", "gpt-6.1-terra")], False)

    def test_ultrafast_does_not_change_other_models(self):
        self.pi.close()
        self.processes.remove(self.pi)
        path = self.agent / "models.json"
        data = json.loads(path.read_text())
        astra = next(model for model in data["providers"]["openai"]["models"] if model["id"] == "gpt-6-astra")
        astra["baseUrl"] = "https://api.openai.com/v1"
        path.write_text(json.dumps(data))
        self.pi = self.start()
        self.pi.command("/fast")  # Terra stays on when Ultrafast is disabled on a different model.
        self.pi.switch("gpt-6-astra", "openai")
        self.pi.command("/fast")
        self.assertEqual(self.preferences()[("openai", "gpt-6-astra")], True)
        events = self.pi.command("/ultrafast")
        self.assertTrue(any(e.get("statusText") == "ultrafast" for e in events))
        self.assertEqual(self.preferences()[("openai", "gpt-6-astra")], False)
        self.pi.switch("gpt-6.1-terra")
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.switch("gpt-6-astra", "openai")
        self.assertEqual(self.preferences()[("openai", "gpt-6-astra")], False)
        self.pi.command("/fast")
        self.assertEqual(self.preferences()[("openai", "gpt-6-astra")], True)

    def test_config_default_and_saved_off(self):
        self.pi.close()
        self.processes.remove(self.pi)
        (self.agent / "extensions").mkdir()
        (self.agent / "extensions" / "fast.json").write_text('{"enabled": true}')
        self.pi = self.start()
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.command("/fast")
        self.assertNotIn("service_tier", self.request())
        self.pi.switch("gpt-6.1-sol")
        self.assertEqual(self.request()["service_tier"], "priority")
        self.pi.close()
        self.processes.remove(self.pi)
        self.pi = self.start()
        self.assertNotIn("service_tier", self.request())


if __name__ == "__main__":
    unittest.main()
