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
    const pathname = parseRequestPathname(request.url);
    if (pathname === undefined) {
      writeHttpError(response, 400, "preview_invalid_request_url");
      return;
    }
    sanitizeForwardingHeaders(request.headers);
    proxy.web(request, response, {
      agent,
      target: selectProductionPreviewTarget(pathname, targets),
    }).catch((error) => handleProxyError(error, request, response));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const pathname = parseRequestPathname(request.url);
    if (pathname === undefined) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sanitizeForwardingHeaders(request.headers);
    proxy.ws(request, socket, head, {
      agent,
      target: selectProductionPreviewTarget(pathname, targets),
    }).catch((error) => handleProxyError(error, request, socket));
  });
  proxy.on("error", handleProxyError);

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
        proxy.close();
        agent.destroy();
      });
      return closing;
    },
  };
}

function parseRequestPathname(value) {
  try {
    return new URL(value || "/", "http://open-agent.local").pathname;
  } catch {
    return undefined;
  }
}

function sanitizeForwardingHeaders(headers) {
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-forwarded-server",
    "x-real-ip",
  ]) {
    delete headers[name];
  }
}

function handleProxyError(error, _request, responseOrSocket) {
  if (!responseOrSocket || responseOrSocket.destroyed) return;
  if ("writeHead" in responseOrSocket && !responseOrSocket.headersSent) {
    writeHttpError(responseOrSocket, 502, "preview_upstream_unavailable");
    return;
  }
  responseOrSocket.destroy(error);
}

function writeHttpError(response, status, code) {
  const body = JSON.stringify({ code, ok: false });
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
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
