import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export function hasExternalSatSolver() {
  return Boolean(resolveSolverBin());
}

export async function getSatBackendStatus() {
  const configuredBin = getConfiguredSolverBin();
  const resolvedBin = resolveSolverBin();
  if (!resolvedBin) {
    return {
      backend: "js-fallback",
      available: false,
      configuredBin,
      resolvedBin: "",
      detail: "JS fallback active",
      rawDetail: "CryptoMiniSat not configured. Using JS fallback.",
    };
  }

  try {
    const probeArgs = resolvedBin.includes("cryptominisat")
      ? ["--version"]
      : ["--help"];
    const { code, stdout, stderr } = await spawnWithTimeout(resolvedBin, probeArgs, 5000);
    return {
      backend: "cryptominisat",
      available: code === 0,
      configuredBin,
      resolvedBin,
      detail: formatCryptoMiniSatSummary(resolvedBin, stdout || stderr),
      rawDetail: (stdout || stderr || "CryptoMiniSat detected.").trim(),
    };
  } catch (error) {
    return {
      backend: "js-fallback",
      available: false,
      configuredBin,
      resolvedBin: "",
      detail: "JS fallback active",
      rawDetail: error instanceof Error ? error.message : "CryptoMiniSat probe failed.",
    };
  }
}

export async function runExternalSat(dimacs, timeoutMs = 30000) {
  const solverBin = resolveSolverBin();
  if (!solverBin) {
    throw new Error("CRYPTOMINISAT_BIN is not configured.");
  }

  const solverArgs = getSolverArgs()
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);

  const tempDir = await mkdtemp(join(tmpdir(), "aps-sat-"));
  const inputPath = join(tempDir, "problem.cnf");

  try {
    await writeFile(inputPath, dimacs, "utf8");
    const args = [...solverArgs, inputPath];
    const { code, stdout, stderr } = await spawnWithTimeout(solverBin, args, timeoutMs);

    if (code !== 0 && code !== 10 && code !== 20) {
      throw new Error(`SAT solver exited with code ${code}: ${stderr.trim()}`);
    }

    return parseSatOutput(stdout);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function getConfiguredSolverBin() {
  return process.env.CRYPTOMINISAT_BIN || process.env.SAT_SOLVER_BIN || "";
}

function resolveSolverBin() {
  const configuredBin = getConfiguredSolverBin();
  if (configuredBin) {
    return configuredBin;
  }

  const probe = spawnSync("which", ["cryptominisat5"], { encoding: "utf8" });
  if (probe.status === 0) {
    return probe.stdout.trim();
  }

  return "";
}

function getSolverArgs() {
  if (process.env.CRYPTOMINISAT_ARGS) {
    return process.env.CRYPTOMINISAT_ARGS;
  }

  if (process.env.SAT_SOLVER_ARGS) {
    return process.env.SAT_SOLVER_ARGS;
  }

  const threads = process.env.CRYPTOMINISAT_THREADS || String(getDefaultThreadCount());
  return `--verb 0 --threads ${threads}`;
}

function getDefaultThreadCount() {
  try {
    if (typeof availableParallelism === "function") {
      return Math.max(1, availableParallelism());
    }
  } catch {
    // Fall back to cpu count below.
  }

  try {
    return Math.max(1, cpus().length);
  } catch {
    return 1;
  }
}

function spawnWithTimeout(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`SAT solver timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseSatOutput(rawOutput) {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let satisfiable = null;
  const model = [];

  for (const line of lines) {
    if (line.startsWith("s ")) {
      if (line.includes("UNSATISFIABLE")) {
        satisfiable = false;
      } else if (line.includes("SATISFIABLE")) {
        satisfiable = true;
      }
      continue;
    }

    if (line.startsWith("v ")) {
      const values = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((value) => value !== 0);
      model.push(...values);
    }
  }

  return { satisfiable: Boolean(satisfiable), model };
}

function formatCryptoMiniSatSummary(resolvedBin, rawText) {
  const versionLine = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes("CryptoMiniSat version"));

  if (versionLine) {
    const version = versionLine.replace(/^c\s*/, "");
    return `${version} at ${resolvedBin}`;
  }

  return `CryptoMiniSat detected at ${resolvedBin}`;
}
