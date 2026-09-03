#!/usr/bin/env python3
"""Static file server for the System Design Simulator.

Serves the *repository root* (not the simulator folder) so that the "read the
chapter" links from the Doctor can resolve into ../system-design-book/.
Caching is disabled so edits show up on reload.

    python3 system-design-simulator/serve.py [port]
    -> http://127.0.0.1:8123/system-design-simulator/
"""
import functools
import http.server
import os
import socketserver
import sys
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "200" not in (args[1] if len(args) > 1 else ""):
            super().log_message(fmt, *args)


class Server(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    url = f"http://127.0.0.1:{PORT}/system-design-simulator/"
    with Server(("127.0.0.1", PORT), handler) as httpd:
        print(f"System Design Simulator -> {url}")
        print("Ctrl-C to stop.")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
