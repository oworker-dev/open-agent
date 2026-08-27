import { createRequire } from "node:module";
import { Agent as HttpAgent, createServer } from "node:http";

const require = createRequire(import.meta.url);
const { createProxyServer } = require("next/dist/compiled/httpxy");

export const DEFAULT_PREVIEW_PROXY_MAX_SOCKETS = 16_384;
export const MAX_PREVIEW_PROXY_MAX_SOCKETS = 32_768;

/** @param {Readonly<Record<string, string | undefined>>} [environment] */
export function readPreviewProxyMaxSockets(environment = process.env) {
  const raw = environment.OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS?.trim();
  if (!raw) return DEFAULT_PREVIEW_PROXY_MAX_SOCKETS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 256 || value > MAX_PREVIEW_PROXY_MAX_SOCKETS) {
    throw new Error(
      `OPEN_AGENT_PREVIEW_PROXY_MAX_SOCKETS must be an integer from 256 to ${MAX_PREVIEW_PROXY_MAX_SOCKETS}.`,
    );
  }
  return value;
}

export function selectProductionPreviewTarget(pathname, targets) {
  if (
    pathname === "/eve" || pathname.startsWith("/eve/") ||
    pathname === "/.well-known/workflow" || pathname.startsWith("/.well-known/workflow/")
  ) {
    return targets.eve;
  }
  return targets.web;
}

export async function startProductionPreviewGateway(options) {
  const maxSockets = options.maxSockets ?? readPreviewProxyMaxSockets();
  const agent = new HttpAgent({ keepAlive: true, maxFreeSockets: 256, maxSockets });
  const proxy = createProxyServer({ changeOrigin: false, xfwd: true });
  const sockets = new Set();
  const targets = {
    eve: normalizeOrigin(options.eveOrigin, "eveOrigin"),
    web: normalizeOrigin(options.webOrigin, "webOrigin"),
  };

  const server = createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://open-agent.local").pathname;
    proxy.web(request, response, {
      agent,
      target: selectProductionPreviewTarget(pathname, targets),
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://open-agent.local").pathname;
    proxy.ws(request, socket, head, {
      agent,
      target: selectProductionPreviewTarget(pathname, targets),
    });
  });
  proxy.on("error", (error, _request, responseOrSocket) => {
    if (responseOrSocket && "writeHead" in responseOrSocket && !responseOrSocket.headersSent) {
      responseOrSocket.writeHead(502, { "content-type": "application/json" });
      responseOrSocket.end(JSON.stringify({ code: "preview_upstream_unavailable", ok: false }));
      return;
    }
    responseOrSocket?.destroy?.(error);
  });

  await new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  let closing;
  return {
    address: server.address(),
    maxSockets,
    close() {
      closing ??= new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeIdleConnections?.();
        for (const socket of sockets) socket.destroy();
        agent.destroy();
      });
      return closing;
    },
  };
}

function normalizeOrigin(value, name) {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error(`${name} must use loopback HTTP.`);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`${name} must use a loopback hostname.`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment.`);
  }
  return url.origin;
}
