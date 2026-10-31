"""Test-only loopback transport for exercising Python against the real JS API."""
import http.client
import importlib.util
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location("collector", Path(__file__).resolve().parents[1] / "misub_collector.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
fixture = json.load(sys.stdin)
if fixture.get("clockOffsetSeconds"):
    real_time = collector.time.time
    collector.time.time = lambda: real_time() + fixture["clockOffsetSeconds"]


class FixtureTransport:
    def request(self, url, method="GET", headers=None, body=None, timeout=10, limit=collector.MAX_BYTES):
        parts = urlsplit(url)
        path = parts.path if parts.hostname == "misub.example" else "/fixture-airport"
        connection = http.client.HTTPConnection("127.0.0.1", fixture["port"], timeout=timeout)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read(limit + 1)
            if len(data) > limit:
                raise collector.CollectorError("response-too-large")
            return response.status, {key.lower(): value for key, value in response.getheaders()}, data
        finally:
            connection.close()


try:
    print(json.dumps(collector.run_once(fixture["config"], fixture["stateDir"], FixtureTransport())))
except collector.CollectorError as error:
    print(json.dumps({"error": str(error)}), file=sys.stderr)
    sys.exit(1)
