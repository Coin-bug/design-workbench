import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


if __name__ == "__main__":
    preferred_port = int(os.environ.get("PORT", "4173"))
    server = None
    port = preferred_port
    for candidate in range(preferred_port, preferred_port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", candidate), SimpleHTTPRequestHandler)
            port = candidate
            break
        except OSError:
            continue
    if server is None:
        raise RuntimeError("No available local port found.")
    print(f"Serving on http://127.0.0.1:{port}")
    server.serve_forever()
