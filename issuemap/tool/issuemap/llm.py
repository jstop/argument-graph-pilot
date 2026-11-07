"""Minimal Anthropic Messages API client (standard library only).

Anything with a `.json(system, user)` method works as a model, which is how
the tests run the whole pipeline without network access.
"""
import json
import os
import re
import time
import urllib.request
import urllib.error

DEFAULT_MODEL = os.environ.get("ISSUEMAP_MODEL", "claude-sonnet-5-5")


class Claude:
    def __init__(self, model=DEFAULT_MODEL, api_key=None, max_tokens=16000):
        self.model = model
        self.api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        if not self.api_key:
            raise SystemExit("Set ANTHROPIC_API_KEY to run the pipeline.")
        self.max_tokens = max_tokens
        self.calls = 0
        self.usage = {"input_tokens": 0, "output_tokens": 0}

    def text(self, system, user):
        payload = json.dumps({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }).encode()
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages", data=payload, headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            })
        for attempt in range(6):
            try:
                with urllib.request.urlopen(req, timeout=600) as r:
                    data = json.load(r)
                break
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 529) and attempt < 5:
                    time.sleep(min(60, 2 ** attempt * 3))
                    continue
                raise SystemExit(f"Anthropic API error {e.code}: {e.read()[:500]!r}")
        self.calls += 1
        for k in self.usage:
            self.usage[k] += data.get("usage", {}).get(k, 0)
        return "".join(b.get("text", "") for b in data["content"] if b["type"] == "text")

    def json(self, system, user):
        raw = self.text(system + "\n\nReply with JSON only, no prose, no code fences.", user)
        return parse_json(raw)


def parse_json(raw):
    raw = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if fence:
        raw = fence.group(1).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = min([i for i in (raw.find("{"), raw.find("[")) if i >= 0], default=-1)
        if start < 0:
            raise
        end = max(raw.rfind("}"), raw.rfind("]"))
        return json.loads(raw[start:end + 1])
