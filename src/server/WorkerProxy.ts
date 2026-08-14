import http from "http";
import type { IncomingMessage, ServerResponse } from "http";
import type { NextFunction, Request, Response } from "express";
import type { Duplex } from "stream";

export interface WorkerPath {
  workerId: number;
  restPath: string;
}

export function parseWorkerPath(pathname: string): WorkerPath | null {
  const match = pathname.match(/^\/w(\d+)(\/.*)?$/);
  if (!match) return null;
  return { workerId: parseInt(match[1], 10), restPath: match[2] ?? "" };
}

export function workerPortFor(workerId: number): number {
  return 3001 + workerId;
}

export function randomWorkerPort(
  numWorkers: number,
  random: () => number = Math.random,
): number {
  return 3001 + Math.floor(random() * numWorkers);
}

export function proxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  targetPath: string,
): void {
  const proxyReq = http.request({
    host: "localhost",
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: req.headers,
  });

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({ error: "worker proxy error", message: error.message }),
    );
  });

  proxyReq.on("response", (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  req.pipe(proxyReq);
}

export function proxyWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
  targetPath: string,
): void {
  const proxyReq = http.request({
    host: "localhost",
    port: targetPort,
    path: targetPath,
    method: "GET",
    headers: { ...req.headers, Connection: "Upgrade", Upgrade: "websocket" },
  });

  proxyReq.on("error", () => {
    socket.destroy();
  });

  proxyReq.on("response", () => {
    // The target answered with a plain HTTP response instead of an upgrade;
    // there is nothing to hand off, so tear down the client connection.
    socket.destroy();
  });

  proxyReq.on("upgrade", (upRes, upSocket, upHead) => {
    socket.write(
      `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? ""}\r\n`,
    );
    for (const [name, value] of Object.entries(upRes.headers)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        socket.write(`${name}: ${v}\r\n`);
      }
    }
    socket.write("\r\n");

    if (upHead.length > 0) {
      upSocket.unshift(upHead);
    }

    const teardown = () => {
      socket.destroy();
      upSocket.destroy();
    };
    socket.on("error", teardown);
    upSocket.on("error", teardown);
    socket.on("close", () => upSocket.destroy());
    upSocket.on("close", () => socket.destroy());

    socket.pipe(upSocket);
    upSocket.pipe(socket);
  });

  proxyReq.end();
}

export function createWorkerProxyMiddleware(numWorkers: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const pathname = req.url.split("?")[0];
    const workerPath = parseWorkerPath(pathname);
    if (workerPath) {
      proxyHttpRequest(req, res, workerPortFor(workerPath.workerId), req.url);
      return;
    }
    if (
      req.method === "POST" &&
      (pathname === "/api/create_game" ||
        pathname === "/api/adminbot/create_game")
    ) {
      proxyHttpRequest(req, res, randomWorkerPort(numWorkers), req.url);
      return;
    }
    next();
  };
}

export function installWorkerUpgradeProxy(
  server: http.Server,
  numWorkers: number,
): void {
  server.on("upgrade", (req, socket, head) => {
    const pathname = (req.url ?? "").split("?")[0];
    const workerPath = parseWorkerPath(pathname);
    if (workerPath) {
      proxyWebSocketUpgrade(
        req,
        socket,
        head,
        workerPortFor(workerPath.workerId),
        req.url ?? "/",
      );
    } else {
      socket.destroy();
    }
  });
}
