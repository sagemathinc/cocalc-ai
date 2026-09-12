import csv
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import math
import os
from pathlib import Path
import statistics
from urllib.parse import urlsplit

DATA = Path(__file__).with_name("measurements.csv")

class Dashboard(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/health":
            content = b"ok\n"
            content_type = "text/plain; charset=utf-8"
        elif route == "/":
            try:
                with DATA.open(encoding="utf-8", newline="") as source:
                    values = [float(row["value"]) for row in csv.DictReader(source)]
                if not all(math.isfinite(value) for value in values):
                    raise ValueError("Measurements must be finite")
                mean = statistics.mean(values)
            except (OSError, ValueError, KeyError, statistics.StatisticsError):
                self.send_error(503, "Measurement data is unavailable or invalid")
                return
            rows = "".join(f"<li>{html.escape(str(value))}</li>" for value in values)
            content = (
                "<!doctype html><html lang='en'><meta charset='utf-8'>"
                "<meta name='viewport' content='width=device-width, initial-scale=1'>"
                "<title>Research measurements</title>"
                "<main><h1>Research measurements</h1>"
                f"<p>Count: {len(values)}; mean: {mean}</p><ul>{rows}</ul>"
                "<p>Refresh after updating measurements.csv.</p></main></html>"
            ).encode("utf-8")
            content_type = "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

host = os.environ.get("HOST", "127.0.0.1")
port = int(os.environ.get("PORT", "8765"))
print(f"Dashboard listening on {host}:{port}", flush=True)
ThreadingHTTPServer((host, port), Dashboard).serve_forever()
