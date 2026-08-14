import { describe, expect, test } from "vitest";
import http from "http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AddressInfo } from "net";
import {
  parseWorkerPath,
  workerPortFor,
  randomWorkerPort,
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  createWorkerProxyMiddleware,
  installWorkerUpgradeProxy,
} from "../../src/server/WorkerProxy";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function onceMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners();
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);
    ws.on("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("parseWorkerPath", () => {
  test('/w1/api/game/x returns {workerId:1, restPath:"/api/game/x"}', () => {
    expect(parseWorkerPath("/w1/api/game/x")).toEqual({
      workerId: 1,
      restPath: "/api/game/x",
    });
  });

  test('/w0 returns {workerId:0, restPath:""}', () => {
    expect(parseWorkerPath("/w0")).toEqual({ workerId: 0, restPath: "" });
  });

  test('/w0/lobbies returns {workerId:0, restPath:"/lobbies"}', () => {
    expect(parseWorkerPath("/w0/lobbies")).toEqual({
      workerId: 0,
      restPath: "/lobbies",
    });
  });

  test("/lobbies returns null", () => {
    expect(parseWorkerPath("/lobbies")).toBeNull();
  });

  test("/api/health returns null", () => {
    expect(parseWorkerPath("/api/health")).toBeNull();
  });

  test("/assets/index.js returns null", () => {
    expect(parseWorkerPath("/assets/index.js")).toBeNull();
  });
});

describe("workerPortFor", () => {
  test("worker 0 returns 3001", () => {
    expect(workerPortFor(0)).toBe(3001);
  });

  test("worker 3 returns 3004", () => {
    expect(workerPortFor(3)).toBe(3004);
  });
});

describe("randomWorkerPort", () => {
  test("random() returning 0 gives the first worker port 3001", () => {
    expect(randomWorkerPort(2, () => 0)).toBe(3001);
  });

  test("random() returning 0.999 gives the last worker port 3002", () => {
    expect(randomWorkerPort(2, () => 0.999)).toBe(3002);
  });

  test("port always stays within [3001, 3001+n)", () => {
    for (let i = 0; i < 100; i++) {
      const port = randomWorkerPort(5, Math.random);
      expect(port).toBeGreaterThanOrEqual(3001);
      expect(port).toBeLessThan(3006);
    }
  });
});

describe("proxyHttpRequest", () => {
  test("forwards request and returns the worker's JSON response", async () => {
    const targetServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "worker", path: req.url }));
    });
    const targetPort = await listen(targetServer);

    const proxyServer = http.createServer((req, res) => {
      proxyHttpRequest(req, res, targetPort, req.url ?? "/");
    });
    const proxyPort = await listen(proxyServer);

    try {
      const response = await fetch(
        `http://localhost:${proxyPort}/w0/api/game/test`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        from: "worker",
        path: "/w0/api/game/test",
      });
    } finally {
      await closeServer(proxyServer);
      await closeServer(targetServer);
    }
  });

  test("returns a 502 JSON response when the worker is unreachable", async () => {
    const proxyServer = http.createServer((req, res) => {
      // Port 1 is never listening.
      proxyHttpRequest(req, res, 1, "/");
    });
    const proxyPort = await listen(proxyServer);

    try {
      const response = await fetch(`http://localhost:${proxyPort}/test`);
      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data).toEqual(
        expect.objectContaining({ error: "worker proxy error" }),
      );
    } finally {
      await closeServer(proxyServer);
    }
  });
});

describe("createWorkerProxyMiddleware", () => {
  test("calls next() for non-worker paths like /api/health", async () => {
    const app = express();
    app.use(createWorkerProxyMiddleware(2));
    let nextCalled = false;
    app.use((_req, res) => {
      nextCalled = true;
      res.json({ next: true });
    });
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ next: true });
      expect(nextCalled).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  test("forwards /w{id}/... requests to the matching worker", async () => {
    const targetServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ from: "worker", path: req.url }));
    });
    const targetPort = await listen(targetServer);

    const app = express();
    app.use(createWorkerProxyMiddleware(2));
    app.use((_req, res) => {
      res.status(404).json({ error: "should never be reached" });
    });
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      // Pick a worker id whose port matches the ephemeral target port.
      const workerId = targetPort - 3001;
      const targetPath = `/w${workerId}/api/game/test`;
      const response = await fetch(`http://localhost:${port}${targetPath}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        from: "worker",
        path: targetPath,
      });
    } finally {
      await closeServer(server);
      await closeServer(targetServer);
    }
  });

  test("proxies POST /api/create_game to a worker instead of falling through", async () => {
    const app = express();
    // Single worker => always dispatched to port 3001, which nothing listens on.
    app.use(createWorkerProxyMiddleware(1));
    let nextCalled = false;
    app.use((_req, res) => {
      nextCalled = true;
      res.status(200).json({ next: true });
    });
    const server = http.createServer(app);
    const port = await listen(server);

    try {
      const response = await fetch(`http://localhost:${port}/api/create_game`, {
        method: "POST",
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual(
        expect.objectContaining({ error: "worker proxy error" }),
      );
      // It was routed to a worker, so the SPA fallback was never reached.
      expect(nextCalled).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

describe("proxyWebSocketUpgrade", () => {
  test("relays messages between the client and the target WebSocket server", async () => {
    const wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wsServer.once("listening", resolve));
    const wsPort = (wsServer.address() as AddressInfo).port;
    wsServer.on("connection", (ws) => {
      ws.send("pong");
    });

    const proxyServer = http.createServer();
    proxyServer.on("upgrade", (req, socket, head) => {
      proxyWebSocketUpgrade(req, socket, head, wsPort, req.url ?? "/");
    });
    const proxyPort = await listen(proxyServer);

    try {
      const ws = new WebSocket(`ws://localhost:${proxyPort}/w0/lobbies`);
      expect(await onceMessage(ws)).toBe("pong");
      ws.terminate();
    } finally {
      await closeServer(proxyServer);
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    }
  });
});

describe("installWorkerUpgradeProxy", () => {
  test("forwards WebSocket upgrades matching /w{id} and destroys others", async () => {
    const wsServer = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wsServer.once("listening", resolve));
    const wsPort = (wsServer.address() as AddressInfo).port;
    wsServer.on("connection", (ws) => {
      ws.send("pong");
    });

    const proxyServer = http.createServer();
    installWorkerUpgradeProxy(proxyServer, 1);
    const proxyPort = await listen(proxyServer);

    try {
      const workerId = wsPort - 3001;
      const ws = new WebSocket(`ws://localhost:${proxyPort}/w${workerId}/lobbies`);
      expect(await onceMessage(ws)).toBe("pong");
      ws.terminate();
    } finally {
      await closeServer(proxyServer);
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    }
  });
});
