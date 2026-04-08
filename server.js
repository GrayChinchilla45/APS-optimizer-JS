import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { solveLayout } from "./solver-service.js";
import { getSatBackendStatus } from "./sat-runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const root = normalize(__dirname);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const solverRevision = "solver-2026-04-08-github-ready";
let activeSolve = null;
let lastSolve = null;

function predictSolveRoute(payload) {
  const shapeNames = (payload.enabledShapes ?? []).map((shape) => shape.name);
  const minSize = Math.min(Number(payload.width) || 0, Number(payload.height) || 0);
  if (shapeNames.length === 1 && shapeNames[0] === "4-Clip") {
    return "fourclip-periodic";
  }
  if (shapeNames.length === 1 && shapeNames[0] === "3-Clip") {
    if (minSize >= 26) {
      return "threeclip-periodic";
    }
    if (payload.symmetry === "None" && !payload.hardSymmetry) {
      return "threeclip-exact";
    }
    return "generic-sat";
  }
  return "legacy-search";
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

createServer(async (request, response) => {
  const requestedPath = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (request.method === "POST" && requestedPath === "/api/solve") {
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      activeSolve = {
        startedAt: new Date().toISOString(),
        width: payload.width,
        height: payload.height,
        symmetry: payload.symmetry,
        shapeNames: (payload.enabledShapes ?? []).map((shape) => shape.name),
        quality: payload.solveQuality,
        expectedRoute: predictSolveRoute(payload),
      };
      const result = await solveLayout(payload);
      result.serverRevision = solverRevision;
      lastSolve = {
        startedAt: activeSolve?.startedAt ?? null,
        finishedAt: new Date().toISOString(),
        width: payload.width,
        height: payload.height,
        symmetry: payload.symmetry,
        shapeNames: (payload.enabledShapes ?? []).map((shape) => shape.name),
        quality: payload.solveQuality,
        solverBackend: result.solverBackend,
        solverRoute: result.solverRoute,
        durationMs: result.durationMs,
      };
      activeSolve = null;
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result));
    } catch (error) {
      lastSolve = {
        ...(activeSolve ?? {}),
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown solve error",
      };
      activeSolve = null;
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown solve error",
        }),
      );
    }
    return;
  }

  if (request.method === "GET" && requestedPath === "/api/status") {
    try {
      const status = await getSatBackendStatus();
      status.revision = solverRevision;
      status.activeSolve = activeSolve;
      status.lastSolve = lastSolve;
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(status));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown status error",
        }),
      );
    }
    return;
  }

  const relativePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = normalize(join(root, relativePath));

  if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}).listen(port, host, () => {
  console.log(`APS Optimizer Web running at http://${host}:${port}`);
});
