import { buildDimacs, encodeAtLeastK } from "./sat-encoding.js";
import { hasExternalSatSolver, runExternalSat } from "./sat-runner.js";
import { generateTemplateBlockedCells } from "./circle-template.js";

const CELL_META = {
  empty: { canOverlap: false },
  blocked: { canOverlap: false },
  loader: { canOverlap: false },
  clipN: { canOverlap: false },
  clipE: { canOverlap: false },
  clipS: { canOverlap: false },
  clipW: { canOverlap: false },
  cooler: { canOverlap: true },
};

const FOUR_CLIP_PERIOD = 5;
const THREE_CLIP_PERIOD_SPECS = [
  { height: 4, width: 4 },
  { height: 4, width: 5 },
  { height: 5, width: 4 },
  { height: 5, width: 5 },
  { height: 5, width: 6 },
  { height: 6, width: 5 },
  { height: 6, width: 6 },
];
let cachedFourClipPeriodicPatterns = null;
let cachedThreeClipPeriodicMotifs = null;
const SOLVE_TIMEOUT_MS = 15000;
const SOLVE_TIMEOUT_LABEL = "15 seconds";
const DEFAULT_BUNDLE_LIMIT = 9000;
const DEFAULT_SEED_ATTEMPTS = 18;

export async function solveLayout(request, onProgress = () => {}) {
  const solveStart = performance.now();
  request.solveQuality = SOLVE_TIMEOUT_LABEL;
  request.enabledShapes = (request.enabledShapes ?? []).filter(
    (shape) => shape.name === "3-Clip" || shape.name === "4-Clip",
  );
  if (!request.enabledShapes.length) {
    throw new Error("No supported shape selected. Choose 3-Clip or 4-Clip.");
  }
  request.blockedCells = [...new Set(request.blockedCells ?? [])];
  if (shouldForceRotational90(request)) {
    request.symmetry = "Rotational (90°)";
  }
  const bundleLimit = DEFAULT_BUNDLE_LIMIT;
  const seedAttempts = DEFAULT_SEED_ATTEMPTS;
  const deadline = solveStart + SOLVE_TIMEOUT_MS;
  const freeCellCount = request.width * request.height - request.blockedCells.length;
  request.blockedLookup = new Set(request.blockedCells);
  request.threeClipOnlyMode =
    request.enabledShapes.length === 1 && request.enabledShapes[0].name === "3-Clip";
  request.fourClipOnlyMode =
    request.enabledShapes.length === 1 && request.enabledShapes[0].name === "4-Clip";
  request.exactThreeClipMode =
    request.threeClipOnlyMode && request.symmetry === "None" && !request.hardSymmetry;
  request.periodicThreeClipMode =
    request.threeClipOnlyMode &&
    Math.min(request.width, request.height) >= 26;
  request.exactFourClipRot90Mode = false;
  request.exactFourClipMode =
    request.fourClipOnlyMode && request.symmetry === "None" && !request.hardSymmetry;
  request.weightedSatSymmetryMode = false;
  request.useOriginalSatMode =
    hasExternalSatSolver() &&
    !request.fourClipOnlyMode &&
    !request.periodicThreeClipMode &&
    !(request.threeClipOnlyMode && request.symmetry !== "None");
  request.useGenericSatMode =
    hasExternalSatSolver() &&
    !request.useOriginalSatMode &&
    !request.exactFourClipMode &&
    !request.exactThreeClipMode &&
    !request.weightedSatSymmetryMode;
  request.solveDiagnostics = {
    backend: "js-fallback",
    fallbackReason: "",
    route: "legacy-search",
    request: buildSolveRequestDiagnostics(request),
  };
  request.componentBoundCache = new Map();
  const shapeAreas = request.enabledShapes.map((shape) => getShapeArea(shape.matrix));
  const knapsack = buildReachabilityTable(shapeAreas, freeCellCount);
  let lastProgress = -Infinity;

  const sendProgress = (status, bestCandidate = null, force = false) => {
    const now = performance.now();
    if (!force && now - lastProgress < 120) {
      return;
    }
    lastProgress = now;
    onProgress({
      status,
      durationMs: now - solveStart,
      best: bestCandidate,
    });
  };

  sendProgress("Generating placements...", null, true);
  await yieldToEventLoop();

  if (request.useOriginalSatMode) {
    try {
      request.solveDiagnostics.backend = "cryptominisat";
      request.solveDiagnostics.route = "original-sat";
      sendProgress("Preparing exact SAT model...", null, true);
      await yieldToEventLoop();
      return await solveOriginalSatModel(request, solveStart, deadline, sendProgress);
    } catch (error) {
      request.solveDiagnostics.backend = "js-fallback";
      request.solveDiagnostics.fallbackReason = describeSatFallback(
        error,
        request.solveQuality,
        "exact SAT optimization",
      );
      sendProgress("Exact SAT model failed, falling back to legacy search...", null, true);
      await yieldToEventLoop();
    }
  }

  if (request.fourClipOnlyMode) {
    request.solveDiagnostics.route = "fourclip-periodic";
    return solveDedicatedFourClip(request, solveStart, deadline, sendProgress);
  }

  if (request.periodicThreeClipMode) {
    request.solveDiagnostics.route = "threeclip-periodic";
    return solveDedicatedThreeClipPeriodic(
      request,
      solveStart,
      deadline,
      sendProgress,
      bundleLimit,
    );
  }

  const bundles = await generateCandidateBundles(
    request,
    bundleLimit,
    deadline,
    (count) => sendProgress(`Generating placements... ${count} candidates`, null, true),
  );
  const cellToBundles = buildCellToBundlesMap(bundles);

  if (!bundles.length) {
    return {
      width: request.width,
      height: request.height,
      template: request.template,
      symmetry: request.symmetry,
      hardSymmetry: request.hardSymmetry,
      blockedCells: request.blockedCells,
      fillCells: 0,
      totalFreeCells: freeCellCount,
      fillRatio: 0,
      durationMs: performance.now() - solveStart,
      passes: 0,
      shapeCounts: {},
      selectedBundles: [],
      grid: [],
      quality: request.solveQuality,
      solverBackend: request.solveDiagnostics.backend,
      solverNote: request.solveDiagnostics.fallbackReason,
      solveRequest: request.solveDiagnostics.request,
    };
  }

  if (request.exactThreeClipMode) {
    request.solveDiagnostics.route = "threeclip-exact";
    sendProgress("Optimizing 3-clip placements...", null, true);
    await yieldToEventLoop();
    return solveExactThreeClipBundles(request, bundles, solveStart, deadline, sendProgress);
  }

  if (request.useGenericSatMode) {
    try {
      request.solveDiagnostics.backend = "cryptominisat";
      request.solveDiagnostics.route = "generic-sat";
      sendProgress("Optimizing with CryptoMiniSat...", null, true);
      const satResult = await solveGenericWithSat(request, bundles, solveStart, deadline, sendProgress);
      if (satResult) {
        return satResult;
      }
    } catch (error) {
      request.solveDiagnostics.backend = "js-fallback";
      request.solveDiagnostics.fallbackReason = describeSatFallback(
        error,
        request.solveQuality,
        "generic optimization",
      );
      sendProgress("CryptoMiniSat failed, falling back to JS search...", null, true);
      await yieldToEventLoop();
    }
  }

  let best = buildInitialSeed(request, bundles, freeCellCount, cellToBundles, seedAttempts);
  let visitedStates = 0;
  const seenStates = new Map();
  const occupied = new Map();
  const skipped = new Set();
  const selected = [];
  const shapeCounts = {};
  sendProgress(
    "Seeding initial layout...",
    payloadFromCandidate(request, best, bundles, performance.now() - solveStart, visitedStates),
    true,
  );
  await yieldToEventLoop();
  let lastYieldState = 0;

  const search = async () => {
    if (performance.now() >= deadline) {
      return;
    }

    visitedStates += 1;
    if (visitedStates - lastYieldState >= 250) {
      lastYieldState = visitedStates;
      sendProgress(
        "Searching",
        payloadFromCandidate(request, best, bundles, performance.now() - solveStart, visitedStates),
        true,
      );
      await yieldToEventLoop();
    }

    const stateKey = buildStateKey(occupied, skipped);
    if (seenStates.has(stateKey)) {
      return;
    }
    seenStates.set(stateKey, occupied.size);

    const possibleUpperBound =
      occupied.size + estimateRemainingFill(request, occupied, skipped, shapeAreas, knapsack);
    if (possibleUpperBound <= best.score) {
      return;
    }

    if (occupied.size > best.score) {
      best = snapshotCandidate(occupied, selected, shapeCounts);
      sendProgress(
        "Improving",
        payloadFromCandidate(request, best, bundles, performance.now() - solveStart, visitedStates),
      );
      if (best.score === freeCellCount) {
        return;
      }
    }

    sendProgress(
      "Searching",
      payloadFromCandidate(request, best, bundles, performance.now() - solveStart, visitedStates),
    );

    const targetInfo = findNextTargetCell(request, occupied, skipped, cellToBundles);
    if (!targetInfo) {
      return;
    }

    if (targetInfo.fittingBundles.length === 0) {
      skipped.add(targetInfo.key);
      await search();
      skipped.delete(targetInfo.key);
      return;
    }

    const rankedBundles = [...targetInfo.fittingBundles].sort((left, right) => {
      const leftEval = evaluateBundle(left, occupied, skipped);
      const rightEval = evaluateBundle(right, occupied, skipped);
      return rightEval.newCells - leftEval.newCells || right.coverage.size - left.coverage.size;
    });

    for (const bundle of rankedBundles) {
      if (performance.now() >= deadline) {
        return;
      }

      const appliedKeys = applyBundleTracked(bundle, occupied);
      selected.push(bundle.id);
      shapeCounts[bundle.shapeName] = (shapeCounts[bundle.shapeName] ?? 0) + 1;

      await search();

      shapeCounts[bundle.shapeName] -= 1;
      if (shapeCounts[bundle.shapeName] === 0) {
        delete shapeCounts[bundle.shapeName];
      }
      selected.pop();
      undoBundle(appliedKeys, occupied);

      if (best.score === freeCellCount) {
        return;
      }
    }

    skipped.add(targetInfo.key);
    await search();
    skipped.delete(targetInfo.key);
  };

  sendProgress(
    "Searching",
    payloadFromCandidate(request, best, bundles, performance.now() - solveStart, visitedStates),
    true,
  );
  await search();

  return payloadFromCandidate(request, best, bundles, performance.now() - solveStart, visitedStates);
}

async function solveOriginalSatModel(request, solveStart, deadline, sendProgress) {
  sendProgress("Generating raw placements...", null, true);
  const rawPlacements = await generateRawPlacements(
    request,
    deadline,
    (count) => sendProgress(`Generating raw placements... ${count}`, null, true),
  );

  if (!rawPlacements.length) {
    return buildEmptyPayload(request, performance.now() - solveStart);
  }

  sendProgress("Applying symmetry...", null, true);
  await yieldToEventLoop();
  const grouped = applySymmetryAndGroupOriginal(rawPlacements, request);
  if (!grouped.elements.length) {
    return buildEmptyPayload(request, performance.now() - solveStart);
  }

  sendProgress("Analyzing conflicts...", null, true);
  await yieldToEventLoop();
  const satModel = buildOriginalSatModel(grouped.elements, request);
  const decrementStep = calculateOriginalDecrementStep(request.enabledShapes);
  const totalAvailableCells = request.width * request.height - request.blockedCells.length;
  let requiredCells = Math.floor(totalAvailableCells / decrementStep) * decrementStep;
  let iterationCounter = 0;

  while (requiredCells >= 0) {
    if (performance.now() >= deadline) {
      throw new Error("SAT solver timed out while searching exact fill targets.");
    }

    iterationCounter += 1;
    sendProgress(`Optimization attempt #${iterationCounter}: target ${requiredCells} cells`, null, true);

    const cnf = buildOriginalSolveCnf(satModel, requiredCells);
    const remainingMs = getRemainingSatBudgetMs(deadline);
    const result = await runExternalSat(cnf.dimacs, remainingMs);

    if (result.satisfiable && result.model.length) {
      const placements = mapOriginalSatResult(result.model, grouped.variableToElementMap);
      request.solveDiagnostics.fallbackReason = "";
      return buildOriginalSatPayload(
        request,
        placements,
        performance.now() - solveStart,
        iterationCounter,
      );
    }

    if (requiredCells === 0) {
      break;
    }
    requiredCells = Math.max(0, requiredCells - decrementStep);
  }

  return buildEmptyPayload(request, performance.now() - solveStart);
}

async function solveGenericWithSat(request, bundles, solveStart, deadline, sendProgress) {
  const occupied = new Map();
  const selected = [];
  const shapeCounts = {};
  const components = splitBundleInteractionComponents(bundles);
  let satCalls = 0;

  for (let index = 0; index < components.length; index += 1) {
    if (performance.now() >= deadline) {
      throw new Error("SAT solver timed out while optimizing bundle components.");
    }

    if (components[index].bundles.length === 1) {
      const [bundle] = components[index].bundles;
      applyBundle(bundle, occupied);
      selected.push(bundle.id);
      shapeCounts[bundle.shapeName] = (shapeCounts[bundle.shapeName] ?? 0) + 1;
      satCalls += 1;
      continue;
    }

    sendProgress(
      `CryptoMiniSat component ${index + 1}/${components.length}`,
      null,
      true,
    );
    const solved = await solveGenericBundleComponentWithSat(
      request,
      components[index],
      deadline,
      (calls, target) =>
        sendProgress(
          `CryptoMiniSat component ${index + 1}/${components.length}, pass ${calls}: target ${target} cells`,
          null,
          true,
        ),
    );
    satCalls += solved.satCalls;

    for (const bundle of solved.selectedBundles) {
      applyBundle(bundle, occupied);
      selected.push(bundle.id);
      shapeCounts[bundle.shapeName] = (shapeCounts[bundle.shapeName] ?? 0) + 1;
    }
  }

  return payloadFromCandidate(
    request,
    {
      score: occupied.size,
      occupied,
      selected,
      shapeCounts,
    },
    bundles,
    performance.now() - solveStart,
    satCalls,
  );
}

async function solveExactThreeClipBundles(request, bundles, solveStart, deadline, sendProgress) {
  try {
    return await solveExactThreeClipBundlesCore(request, bundles, solveStart, deadline, sendProgress);
  } catch (error) {
    request.solveDiagnostics.backend = hasExternalSatSolver() ? "cryptominisat" : "js-fallback";
    request.solveDiagnostics.fallbackReason = describeSatFallback(
      error,
      request.solveQuality,
      "3-clip exact placement solve",
    );
    sendProgress("3-clip exact solve timed out, falling back to generic SAT...", null, true);
    return solveGenericWithSat(request, bundles, solveStart, deadline, sendProgress);
  }
}

async function solveExactThreeClipBundlesCore(request, bundles, solveStart, deadline, sendProgress) {
  const occupied = new Map();
  const selected = [];
  const shapeCounts = {};
  const components = splitBundleInteractionComponents(bundles);
  let totalPasses = 0;

  for (let index = 0; index < components.length; index += 1) {
    if (performance.now() >= deadline) {
      break;
    }

    sendProgress(`Optimizing 3-clip component ${index + 1}/${components.length}`, null, true);
    const solved = await solveThreeClipBundleComponent(components[index], deadline);
    totalPasses += solved.passes;

    for (const bundle of solved.selectedBundles) {
      applyBundle(bundle, occupied);
      selected.push(bundle.id);
      shapeCounts[bundle.shapeName] = (shapeCounts[bundle.shapeName] ?? 0) + 1;
    }
  }

  request.solveDiagnostics.backend = hasExternalSatSolver() ? "cryptominisat" : "js-fallback";
  request.solveDiagnostics.fallbackReason = "";

  return payloadFromCandidate(
    request,
    {
      score: occupied.size,
      occupied,
      selected,
      shapeCounts,
    },
    bundles,
    performance.now() - solveStart,
    totalPasses,
  );
}

async function solveThreeClipBundleComponent(component, deadline) {
  const reduced = preprocessBundleComponent(component);
  const workingComponent = reduced.component;
  const greedySeed = buildGenericComponentGreedySeed(workingComponent.bundles);

  if (!hasExternalSatSolver()) {
    return {
      selectedBundles: greedySeed.selectedBundles,
      passes: 1,
    };
  }

  const bundleVarById = new Map();
  const bundlesByVar = new Map();
  let nextVar = 1;
  for (const bundle of workingComponent.bundles) {
    bundleVarById.set(bundle.id, nextVar);
    bundlesByVar.set(nextVar, bundle);
    nextVar += 1;
  }

  const clauses = buildBundleConflictClauses(
    workingComponent.bundles,
    bundleVarById,
    reduced.conflictPairs,
  );
  const greedyCount = greedySeed.selectedBundles.length;
  const upperBound = Math.min(
    workingComponent.bundles.length,
    Math.floor(workingComponent.cells.length / 4),
  );

  const result = await optimizeTargetProgressively({
    lowerBound: greedyCount,
    upperBound,
    deadline,
    solveTarget: async (target) => {
      const workingClauses = clauses.map((clause) => [...clause]);
      const ref = { value: nextVar };
      const { clauses: atLeastClauses, variableCount } = encodeAtLeastK(
        Array.from({ length: workingComponent.bundles.length }, (_, index) => index + 1),
        target,
        ref,
      );
      appendClauses(workingClauses, atLeastClauses);
      return runExternalSat(buildDimacs(workingClauses, variableCount), getRemainingSatBudgetMs(deadline));
    },
  });

  if (!result.bestModel.length) {
    return {
      selectedBundles: greedySeed.selectedBundles,
      passes: Math.max(1, result.attempts),
    };
  }

  const selectedBundles = [];
  const modelSet = new Set(result.bestModel.filter((value) => value > 0));
  for (const [bundleVar, bundle] of bundlesByVar.entries()) {
    if (modelSet.has(bundleVar)) {
      selectedBundles.push(bundle);
    }
  }

  return {
    selectedBundles,
    passes: Math.max(1, result.attempts),
  };
}

async function solveDedicatedFourClip(request, solveStart, deadline, sendProgress) {
  sendProgress("Evaluating periodic 4-clip cutouts...", null, true);
  await yieldToEventLoop();
  const solved = await solveFourClipPeriodicCutout(request, solveStart, deadline, sendProgress);
  request.solveDiagnostics.backend = "periodic-cutout";
  request.solveDiagnostics.fallbackReason = "";
  return buildCenterSolverPayload(
    request,
    solved.occupied,
    solved.placements,
    performance.now() - solveStart,
    solved.evaluatedCandidates,
  );
}

async function solveDedicatedThreeClipPeriodic(request, solveStart, deadline, sendProgress, bundleLimit) {
  sendProgress("Evaluating periodic 3-clip motifs...", null, true);
  await yieldToEventLoop();

  const motifs = getThreeClipPeriodicMotifs(request.enabledShapes[0]).filter((motif) => {
    if (request.symmetry === "Rotational (90°)") {
      return motif.width === motif.height;
    }
    return true;
  });
  let best = {
    score: -1,
    occupied: new Map(),
    selectedBundles: [],
    evaluatedCandidates: 0,
  };

  for (const motif of motifs) {
    for (let rowOffset = 0; rowOffset < motif.height; rowOffset += 1) {
      for (let colOffset = 0; colOffset < motif.width; colOffset += 1) {
        if (performance.now() >= deadline) {
          return buildThreeClipPeriodicPayload(
            request,
            best.score >= 0 ? best : { score: 0, occupied: new Map(), selectedBundles: [] },
            performance.now() - solveStart,
            best.evaluatedCandidates,
          );
        }

        const candidate = buildThreeClipPeriodicCandidate(request, motif, rowOffset, colOffset);
        candidate.evaluatedCandidates = best.evaluatedCandidates + 1;
        if (candidate.score > best.score) {
          best = candidate;
          sendProgress(
            `Evaluating periodic 3-clip motifs... ${candidate.evaluatedCandidates}`,
            buildThreeClipPeriodicPayload(
              request,
              candidate,
              performance.now() - solveStart,
              candidate.evaluatedCandidates,
            ),
            true,
          );
          await yieldToEventLoop();
        } else {
          best.evaluatedCandidates = candidate.evaluatedCandidates;
        }
      }
    }
  }

  if (performance.now() < deadline && best.selectedBundles.length) {
    sendProgress("Repairing periodic 3-clip edges...", null, true);
    await yieldToEventLoop();
    best = await repairThreeClipPeriodicCandidate(
      request,
      best,
      deadline,
      bundleLimit,
      sendProgress,
      solveStart,
    );
  }

  if (
    request.symmetry !== "None" &&
    hasExternalSatSolver() &&
    best.selectedBundles.length &&
    performance.now() < deadline - 750
  ) {
    try {
      sendProgress("Refining periodic 3-clip symmetry seams...", null, true);
      await yieldToEventLoop();
      best = await refineThreeClipSymmetrySeams(
        request,
        best,
        deadline,
        sendProgress,
        solveStart,
        bundleLimit,
      );
    } catch (error) {
      request.solveDiagnostics.fallbackReason = describeSatFallback(
        error,
        request.solveQuality,
        "symmetry seam refinement",
      );
    }
  }

  if (
    request.symmetry === "None" &&
    hasExternalSatSolver() &&
    best.selectedBundles.length &&
    Math.max(request.width, request.height) <= 27 &&
    performance.now() < deadline - 1500
  ) {
    try {
      sendProgress("Refining periodic 3-clip boundary orientations...", null, true);
      await yieldToEventLoop();
      best = await refineThreeClipNoSymmetryBoundary(
        request,
        best,
        deadline,
        sendProgress,
        solveStart,
        bundleLimit,
      );
    } catch (error) {
      request.solveDiagnostics.fallbackReason = describeSatFallback(
        error,
        request.solveQuality,
        "boundary orientation refinement",
      );
    }
  }

  request.solveDiagnostics.backend = "periodic-cutout";
  request.solveDiagnostics.fallbackReason = "";
  return buildThreeClipPeriodicPayload(
    request,
    best.score >= 0 ? best : { score: 0, occupied: new Map(), selectedBundles: [] },
    performance.now() - solveStart,
    best.evaluatedCandidates,
  );
}

function buildThreeClipPeriodicPayload(request, candidate, durationMs, passes) {
  const totalFree = request.width * request.height - request.blockedCells.length;
  const fillCells = candidate.occupied.size;
  return {
    width: request.width,
    height: request.height,
    template: request.template,
    symmetry: request.symmetry,
    hardSymmetry: request.hardSymmetry,
    blockedCells: request.blockedCells,
    fillCells,
    totalFreeCells: totalFree,
    fillRatio: totalFree === 0 ? 0 : fillCells / totalFree,
    durationMs,
    passes,
    shapeCounts: candidate.selectedBundles.length ? { "3-Clip": candidate.selectedBundles.length } : {},
    selectedBundles: candidate.selectedBundles.map((bundle) => ({
      id: bundle.id,
      shape: bundle.shapeName,
      members: bundle.members.map((member) =>
        member.cells.map((cell) => ({ row: cell.row, col: cell.col, token: cell.token })),
      ),
    })),
    grid: [...candidate.occupied.entries()].map(([key, token]) => ({ key, token })),
    quality: request.solveQuality,
    solverBackend: request.solveDiagnostics.backend,
    solverRoute: request.solveDiagnostics.route,
    solverNote: request.solveDiagnostics.fallbackReason,
    solveRequest: request.solveDiagnostics.request,
  };
}

function buildThreeClipPeriodicCandidate(request, motif, rowOffset, colOffset) {
  const candidateBundles = [];
  const seen = new Set();

  for (const motifPlacement of motif.placements) {
    const tileRowStart = -1;
    const tileRowEnd = Math.ceil(request.height / motif.height) + 1;
    const tileColStart = -1;
    const tileColEnd = Math.ceil(request.width / motif.width) + 1;

    for (let tileRow = tileRowStart; tileRow <= tileRowEnd; tileRow += 1) {
      for (let tileCol = tileColStart; tileCol <= tileColEnd; tileCol += 1) {
        const placement = buildPeriodicPlacement(
          motifPlacement,
          rowOffset + tileRow * motif.height,
          colOffset + tileCol * motif.width,
        );
        if (!placementFitsTemplate(request, placement)) {
          continue;
        }

        let bundle;
        if (request.symmetry === "None") {
          bundle = buildSinglePlacementBundle(placement, "3-Clip");
        } else {
          bundle = buildSymmetryBundle(request, placement, "3-Clip");
        }

        if (!bundle || seen.has(bundle.signature)) {
          continue;
        }
        seen.add(bundle.signature);
        candidateBundles.push({
          ...bundle,
          id: `p3-${motif.height}x${motif.width}-${rowOffset}-${colOffset}-${candidateBundles.length + 1}`,
          shapeName: "3-Clip",
        });
      }
    }
  }

  candidateBundles.sort((left, right) => right.coverage.size - left.coverage.size);

  const occupied = new Map();
  const selectedBundles = [];
  for (const bundle of candidateBundles) {
    const evaluation = evaluateBundle(bundle, occupied, new Set());
    if (!evaluation.fits || evaluation.newCells === 0) {
      continue;
    }
    applyBundle(bundle, occupied);
    selectedBundles.push(bundle);
  }

  return {
    score: occupied.size,
    occupied,
    selectedBundles,
    evaluatedCandidates: 0,
  };
}

async function repairThreeClipPeriodicCandidate(
  request,
  candidate,
  deadline,
  bundleLimit,
  sendProgress,
  solveStart,
) {
  const occupied = cloneOccupiedMap(candidate.occupied);
  const selectedBundles = [...candidate.selectedBundles];
  const selectedSignatures = new Set(selectedBundles.map((bundle) => bundle.signature));
  const residualComponents = extractOpenComponents(request, occupied, new Set()).sort(
    (left, right) => left.length - right.length,
  );
  const satEligibleCellLimit = 96;
  const maxBundlesPerComponent = Math.max(120, Math.min(480, Math.round(bundleLimit / 18)));
  let added = 0;

  for (let index = 0; index < residualComponents.length; index += 1) {
    if (performance.now() >= deadline) {
      break;
    }

    const componentKeys = residualComponents[index];
    if (!componentKeys.length) {
      continue;
    }

    sendProgress(
      `Repairing periodic 3-clip edges... component ${index + 1}/${residualComponents.length}`,
      buildThreeClipPeriodicPayload(
        request,
        { score: occupied.size, occupied, selectedBundles },
        performance.now() - solveStart,
        candidate.evaluatedCandidates,
      ),
      true,
    );
    await yieldToEventLoop();

    const componentBundles = await generateThreeClipRepairBundlesForComponent(
      request,
      componentKeys,
      occupied,
      selectedSignatures,
      deadline,
      maxBundlesPerComponent,
    );
    if (!componentBundles.length) {
      continue;
    }

    if (
      hasExternalSatSolver() &&
      componentKeys.length <= satEligibleCellLimit &&
      getRemainingSatBudgetMs(deadline, 0) >= 250
    ) {
      const solved = await repairThreeClipPeriodicWithSat(
        request,
        componentKeys,
        componentBundles,
        deadline,
        sendProgress,
        solveStart,
        candidate.evaluatedCandidates,
      );
      for (const bundle of solved.selectedBundles) {
        if (selectedSignatures.has(bundle.signature)) {
          continue;
        }
        const evaluation = evaluateBundle(bundle, occupied, new Set());
        if (!evaluation.fits || evaluation.newCells === 0) {
          continue;
        }
        applyBundle(bundle, occupied);
        selectedBundles.push(bundle);
        selectedSignatures.add(bundle.signature);
        added += 1;
      }
      continue;
    }

    while (performance.now() < deadline) {
      let bestBundle = null;
      let bestNewCells = 0;

      for (const bundle of componentBundles) {
        if (selectedSignatures.has(bundle.signature)) {
          continue;
        }
        const evaluation = evaluateBundle(bundle, occupied, new Set());
        if (!evaluation.fits || evaluation.newCells === 0) {
          continue;
        }
        if (evaluation.newCells > bestNewCells) {
          bestNewCells = evaluation.newCells;
          bestBundle = bundle;
        }
      }

      if (!bestBundle) {
        break;
      }

      applyBundle(bestBundle, occupied);
      selectedBundles.push(bestBundle);
      selectedSignatures.add(bestBundle.signature);
      added += 1;
    }
  }

  return {
    score: occupied.size,
    occupied,
    selectedBundles,
    evaluatedCandidates: candidate.evaluatedCandidates,
  };
}

async function repairThreeClipPeriodicWithSat(
  request,
  componentKeys,
  repairBundles,
  deadline,
  sendProgress,
  solveStart,
  passes,
) {
  if (!repairBundles.length || performance.now() >= deadline) {
    return { selectedBundles: [] };
  }

  sendProgress(
    "Repairing periodic 3-clip edges with SAT...",
    buildThreeClipPeriodicPayload(
      request,
      { score: 0, occupied: new Map(), selectedBundles: [] },
      performance.now() - solveStart,
      passes,
    ),
    true,
  );
  await yieldToEventLoop();

  const solved = await solveGenericBundleComponentWithSat(
    request,
    {
      bundles: repairBundles,
      cells: componentKeys,
    },
    deadline,
    () => {},
  );

  return { selectedBundles: solved.selectedBundles };
}

async function generateThreeClipRepairBundlesForComponent(
  request,
  componentKeys,
  occupied,
  selectedSignatures,
  deadline,
  bundleCap,
) {
  const shape = request.enabledShapes[0];
  const componentSet = new Set(componentKeys);
  const seen = new Set();
  const bundles = [];
  const coordinates = componentKeys.map((key) => key.split(",").map(Number));
  const minRow = Math.min(...coordinates.map(([row]) => row));
  const maxRow = Math.max(...coordinates.map(([row]) => row));
  const minCol = Math.min(...coordinates.map(([, col]) => col));
  const maxCol = Math.max(...coordinates.map(([, col]) => col));
  let checkedPlacements = 0;

  for (const rotation of getShapeRotations(shape)) {
    const rowStart = Math.max(0, minRow - rotation.height + 1);
    const rowEnd = Math.min(request.height - rotation.height, maxRow);
    const colStart = Math.max(0, minCol - rotation.width + 1);
    const colEnd = Math.min(request.width - rotation.width, maxCol);

    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        checkedPlacements += 1;
        if (checkedPlacements % 200 === 0) {
          await yieldToEventLoop();
          if (performance.now() >= deadline) {
            return bundles;
          }
        }

        const placement = buildPlacement(rotation, row, col);
        if (!placementFitsTemplate(request, placement)) {
          continue;
        }

        const bundle =
          request.symmetry === "None"
            ? buildSinglePlacementBundle(placement, "3-Clip")
            : buildSymmetryBundle(request, placement, "3-Clip");
        if (!bundle || selectedSignatures.has(bundle.signature) || seen.has(bundle.signature)) {
          continue;
        }

        const uncoveredKeys = [];
        for (const key of bundle.coverage) {
          if (!occupied.has(key)) {
            uncoveredKeys.push(key);
          }
        }
        if (!uncoveredKeys.length || uncoveredKeys.some((key) => !componentSet.has(key))) {
          continue;
        }

        const evaluation = evaluateBundle(bundle, occupied, new Set());
        if (!evaluation.fits || evaluation.newCells === 0) {
          continue;
        }

        seen.add(bundle.signature);
        bundles.push({
          ...bundle,
          id: `repair-${bundles.length + 1}`,
          shapeName: "3-Clip",
        });

        if (bundles.length >= bundleCap) {
          return bundles.sort((left, right) => right.coverage.size - left.coverage.size);
        }
      }
    }
  }

  return bundles.sort((left, right) => right.coverage.size - left.coverage.size);
}

async function refineThreeClipSymmetrySeams(
  request,
  candidate,
  deadline,
  sendProgress,
  solveStart,
  bundleLimit,
) {
  const activeCellSet = buildThreeClipSymmetryRefineCellSet(request, candidate.occupied);
  if (!activeCellSet.size) {
    return candidate;
  }

  const keptBundles = [];
  const removedBundles = [];
  for (const bundle of candidate.selectedBundles) {
    let touchesActiveRegion = false;
    for (const key of bundle.coverage) {
      if (activeCellSet.has(key)) {
        touchesActiveRegion = true;
        break;
      }
    }
    if (touchesActiveRegion) {
      removedBundles.push(bundle);
    } else {
      keptBundles.push(bundle);
    }
  }

  if (!removedBundles.length) {
    return candidate;
  }

  for (const bundle of removedBundles) {
    for (const key of bundle.coverage) {
      activeCellSet.add(key);
    }
  }

  const fixedOccupied = new Map();
  for (const bundle of keptBundles) {
    applyBundle(bundle, fixedOccupied);
  }

  const selectedSignatures = new Set(keptBundles.map((bundle) => bundle.signature));
  const componentKeys = [...activeCellSet];
  const refineBundles = await generateThreeClipRepairBundlesForComponent(
    request,
    componentKeys,
    fixedOccupied,
    selectedSignatures,
    deadline,
    Math.max(180, Math.min(720, Math.round(bundleLimit / 8))),
  );

  if (!refineBundles.length || performance.now() >= deadline) {
    return candidate;
  }

  sendProgress(
    "Refining periodic 3-clip symmetry seams with SAT...",
    buildThreeClipPeriodicPayload(
      request,
      { score: fixedOccupied.size, occupied: fixedOccupied, selectedBundles: keptBundles },
      performance.now() - solveStart,
      candidate.evaluatedCandidates,
    ),
    true,
  );
  await yieldToEventLoop();

  const solved = await solveGenericBundleComponentWithSat(
    request,
    {
      bundles: refineBundles,
      cells: componentKeys,
    },
    deadline,
    () => {},
  );

  if (!solved.selectedBundles.length) {
    return candidate;
  }

  const occupied = new Map(fixedOccupied);
  const selectedBundles = [...keptBundles];
  for (const bundle of solved.selectedBundles) {
    const evaluation = evaluateBundle(bundle, occupied, new Set());
    if (!evaluation.fits || evaluation.newCells === 0) {
      continue;
    }
    applyBundle(bundle, occupied);
    selectedBundles.push(bundle);
  }

  if (occupied.size <= candidate.occupied.size) {
    return candidate;
  }

  return {
    score: occupied.size,
    occupied,
    selectedBundles,
    evaluatedCandidates: candidate.evaluatedCandidates,
  };
}

function buildThreeClipSymmetryRefineCellSet(request, occupied) {
  const active = new Set();
  const operations = getSymmetryOperations(request.symmetry);
  const radius = request.symmetry === "Rotational (180°)" ? 1 : 2;
  const boundaryBand = request.symmetry === "Rotational (180°)" ? 4 : 0;

  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const key = cellKey(row, col);
      if (request.blockedLookup.has(key) || occupied.has(key)) {
        continue;
      }

      if (
        boundaryBand > 0 &&
        row >= boundaryBand &&
        col >= boundaryBand &&
        row < request.height - boundaryBand &&
        col < request.width - boundaryBand
      ) {
        continue;
      }

      for (const operation of operations) {
        const transformed = transformCoordinate(request, row, col, operation);
        if (!transformed) {
          continue;
        }

        for (let dRow = -radius; dRow <= radius; dRow += 1) {
          for (let dCol = -radius; dCol <= radius; dCol += 1) {
            const nextRow = transformed.row + dRow;
            const nextCol = transformed.col + dCol;
            if (
              nextRow < 0 ||
              nextCol < 0 ||
              nextRow >= request.height ||
              nextCol >= request.width
            ) {
              continue;
            }
            const nextKey = cellKey(nextRow, nextCol);
            if (!request.blockedLookup.has(nextKey)) {
              active.add(nextKey);
            }
          }
        }
      }
    }
  }

  return active;
}

async function refineThreeClipNoSymmetryBoundary(
  request,
  candidate,
  deadline,
  sendProgress,
  solveStart,
  bundleLimit,
) {
  const activeCellSet = buildThreeClipNoSymmetryRefineCellSet(request, candidate.occupied);
  if (!activeCellSet.size) {
    return candidate;
  }

  const keptBundles = [];
  const removedBundles = [];
  for (const bundle of candidate.selectedBundles) {
    let touchesActiveRegion = false;
    for (const key of bundle.coverage) {
      if (activeCellSet.has(key)) {
        touchesActiveRegion = true;
        break;
      }
    }
    if (touchesActiveRegion) {
      removedBundles.push(bundle);
    } else {
      keptBundles.push(bundle);
    }
  }

  if (!removedBundles.length) {
    return candidate;
  }

  for (const bundle of removedBundles) {
    for (const key of bundle.coverage) {
      activeCellSet.add(key);
    }
  }

  const fixedOccupied = new Map();
  for (const bundle of keptBundles) {
    applyBundle(bundle, fixedOccupied);
  }

  const selectedSignatures = new Set(keptBundles.map((bundle) => bundle.signature));
  const componentKeys = [...activeCellSet];
  const refineBundles = await generateThreeClipRepairBundlesForComponent(
    request,
    componentKeys,
    fixedOccupied,
    selectedSignatures,
    deadline,
    Math.max(220, Math.min(900, Math.round(bundleLimit / 6))),
  );

  if (!refineBundles.length || performance.now() >= deadline) {
    return candidate;
  }

  sendProgress(
    "Refining periodic 3-clip boundary orientations with SAT...",
    buildThreeClipPeriodicPayload(
      request,
      { score: fixedOccupied.size, occupied: fixedOccupied, selectedBundles: keptBundles },
      performance.now() - solveStart,
      candidate.evaluatedCandidates,
    ),
    true,
  );
  await yieldToEventLoop();

  const solved = await solveGenericBundleComponentWithSat(
    request,
    {
      bundles: refineBundles,
      cells: componentKeys,
    },
    deadline,
    () => {},
  );

  if (!solved.selectedBundles.length) {
    return candidate;
  }

  const occupied = new Map(fixedOccupied);
  const selectedBundles = [...keptBundles];
  for (const bundle of solved.selectedBundles) {
    const evaluation = evaluateBundle(bundle, occupied, new Set());
    if (!evaluation.fits || evaluation.newCells === 0) {
      continue;
    }
    applyBundle(bundle, occupied);
    selectedBundles.push(bundle);
  }

  if (occupied.size <= candidate.occupied.size) {
    return candidate;
  }

  return {
    score: occupied.size,
    occupied,
    selectedBundles,
    evaluatedCandidates: candidate.evaluatedCandidates,
  };
}

function buildThreeClipNoSymmetryRefineCellSet(request, occupied) {
  const active = new Set();
  const boundaryBand = 3;
  const emptyRadius = 1;

  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const key = cellKey(row, col);
      if (request.blockedLookup.has(key)) {
        continue;
      }

      const nearBoundary =
        row < boundaryBand ||
        col < boundaryBand ||
        row >= request.height - boundaryBand ||
        col >= request.width - boundaryBand;

      if (occupied.has(key) || !nearBoundary) {
        continue;
      }

      for (let dRow = -emptyRadius; dRow <= emptyRadius; dRow += 1) {
        for (let dCol = -emptyRadius; dCol <= emptyRadius; dCol += 1) {
          const nextRow = row + dRow;
          const nextCol = col + dCol;
          if (
            nextRow < 0 ||
            nextCol < 0 ||
            nextRow >= request.height ||
            nextCol >= request.width
          ) {
            continue;
          }
          const nextKey = cellKey(nextRow, nextCol);
          if (!request.blockedLookup.has(nextKey)) {
            active.add(nextKey);
          }
        }
      }
    }
  }

  return active;
}

function getThreeClipPeriodicMotifs(shape) {
  if (cachedThreeClipPeriodicMotifs) {
    return cachedThreeClipPeriodicMotifs;
  }

  const motifs = [];
  const seen = new Set();
  for (const spec of THREE_CLIP_PERIOD_SPECS) {
    const placements = buildToroidalPlacements(shape, spec.height, spec.width);
    if (!placements.length) {
      continue;
    }
    for (const motifPlacements of solveToroidalPlacementCandidates(placements)) {
      const signature = motifPlacements
        .map((placement) =>
          placement.keys
            .slice()
            .sort()
            .join("|"),
        )
        .sort()
        .join("||");
      if (seen.has(`${spec.height}x${spec.width}:${signature}`)) {
        continue;
      }
      seen.add(`${spec.height}x${spec.width}:${signature}`);
      motifs.push({
        height: spec.height,
        width: spec.width,
        placements: motifPlacements,
      });
    }
  }

  cachedThreeClipPeriodicMotifs = motifs;
  return cachedThreeClipPeriodicMotifs;
}

function buildToroidalPlacements(shape, height, width) {
  const rotations = getShapeRotations(shape);
  const placements = [];
  const seen = new Set();

  for (const rotation of rotations) {
    for (let anchorRow = 0; anchorRow < height; anchorRow += 1) {
      for (let anchorCol = 0; anchorCol < width; anchorCol += 1) {
        const rawCells = rotation.cells.map((cell) => ({
          row: anchorRow + cell.row,
          col: anchorCol + cell.col,
          token: cell.token,
        }));
        const wrappedCells = rawCells.map((cell) => ({
          key: cellKey(
            normalizePeriodicOffsetWithPeriod(cell.row, height),
            normalizePeriodicOffsetWithPeriod(cell.col, width),
          ),
          token: cell.token,
        }));

        const signature = wrappedCells
          .map((cell) => `${cell.key}:${cell.token}`)
          .sort()
          .join("|");
        if (seen.has(signature)) {
          continue;
        }
        seen.add(signature);
        placements.push({
          anchorRow,
          anchorCol,
          rotation,
          rawCells,
          keys: wrappedCells.map((cell) => cell.key),
        });
      }
    }
  }

  return placements;
}

function buildPeriodicPlacement(motifPlacement, rowBase, colBase) {
  return {
    cells: motifPlacement.rawCells.map((cell) => {
      const row = rowBase + cell.row;
      const col = colBase + cell.col;
      return {
        row,
        col,
        token: cell.token,
        key: cellKey(row, col),
      };
    }),
  };
}

function solveToroidalPlacementSet(placements) {
  if (!placements.length) {
    return [];
  }

  const conflictMasks = buildPlacementConflictMasks(placements);
  const size = placements.length;
  const allMask = (1n << BigInt(size)) - 1n;
  let bestMask = greedyToroidalPlacementMask(conflictMasks, allMask, size);
  let bestCount = popcountBigInt(bestMask);

  const search = (mask, chosenMask, chosenCount) => {
    if (mask === 0n) {
      if (chosenCount > bestCount) {
        bestCount = chosenCount;
        bestMask = chosenMask;
      }
      return;
    }

    const bound = chosenCount + cliqueCoverUpperBound(mask, conflictMasks, size);
    if (bound <= bestCount) {
      return;
    }

    const branchIndex = chooseToroidalBranch(mask, conflictMasks, size);
    const branchBit = 1n << BigInt(branchIndex);
    search(
      mask & ~branchBit & ~conflictMasks[branchIndex],
      chosenMask | branchBit,
      chosenCount + 1,
    );
    search(mask & ~branchBit, chosenMask, chosenCount);
  };

  search(allMask, 0n, 0);

  return placements.filter((_, index) => (bestMask & (1n << BigInt(index))) !== 0n);
}

function solveToroidalPlacementCandidates(placements) {
  const conflictMasks = buildPlacementConflictMasks(placements);
  const size = placements.length;
  const allMask = (1n << BigInt(size)) - 1n;
  const candidates = [];
  const greedyMask = greedyToroidalPlacementMask(conflictMasks, allMask, size);
  const seen = new Set();

  const pushCandidate = (mask) => {
    const selected = placements.filter((_, index) => (mask & (1n << BigInt(index))) !== 0n);
    const signature = maskSignature(selected, placements);
    if (!seen.has(signature)) {
      seen.add(signature);
      candidates.push(selected);
    }
  };

  pushCandidate(greedyMask);

  for (let attempt = 0; attempt < 36; attempt += 1) {
    const mask = randomizedToroidalPlacementMask(conflictMasks, allMask, size);
    pushCandidate(mask);
  }

  candidates.sort((left, right) => right.length - left.length);
  return candidates.slice(0, 12);
}

function greedyToroidalPlacementMask(conflictMasks, availableMask, size) {
  let remaining = availableMask;
  let chosen = 0n;

  while (remaining !== 0n) {
    const index = chooseToroidalLowDegreeBranch(remaining, conflictMasks, size);
    const bit = 1n << BigInt(index);
    chosen |= bit;
    remaining &= ~bit & ~conflictMasks[index];
  }

  return chosen;
}

function randomizedToroidalPlacementMask(conflictMasks, availableMask, size) {
  let remaining = availableMask;
  let chosen = 0n;

  while (remaining !== 0n) {
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index < size; index += 1) {
      const bit = 1n << BigInt(index);
      if ((remaining & bit) === 0n) {
        continue;
      }
      const degree = popcountBigInt(conflictMasks[index] & remaining);
      const score = degree + Math.random() * 1.5;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    const bit = 1n << BigInt(bestIndex);
    chosen |= bit;
    remaining &= ~bit & ~conflictMasks[bestIndex];
  }

  return chosen;
}

function maskSignature(selectedPlacements, allPlacements) {
  const indices = [];
  const selectedSet = new Set(selectedPlacements);
  for (let index = 0; index < allPlacements.length; index += 1) {
    if (selectedSet.has(allPlacements[index])) {
      indices.push(index);
    }
  }
  return indices.join(",");
}

function chooseToroidalLowDegreeBranch(mask, conflictMasks, size) {
  let bestIndex = -1;
  let bestDegree = Number.POSITIVE_INFINITY;

  for (let index = 0; index < size; index += 1) {
    const bit = 1n << BigInt(index);
    if ((mask & bit) === 0n) {
      continue;
    }
    const degree = popcountBigInt(conflictMasks[index] & mask);
    if (degree < bestDegree) {
      bestDegree = degree;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function cliqueCoverUpperBound(mask, conflictMasks, size) {
  let remaining = mask;
  let coverCount = 0;

  while (remaining !== 0n) {
    let cliqueMask = 0n;
    let candidates = remaining;

    while (candidates !== 0n) {
      const index = firstSetBitIndex(candidates, size);
      const bit = 1n << BigInt(index);
      candidates &= ~bit;

      if (cliqueMask === 0n || (cliqueMask & ~conflictMasks[index]) === 0n) {
        cliqueMask |= bit;
        remaining &= ~bit;
      }
    }

    coverCount += 1;
  }

  return coverCount;
}

function firstSetBitIndex(mask, size) {
  for (let index = 0; index < size; index += 1) {
    if ((mask & (1n << BigInt(index))) !== 0n) {
      return index;
    }
  }
  return -1;
}

async function solveFourClipPeriodicCutout(request, solveStart, deadline, sendProgress) {
  const patternVariants = getFourClipPeriodicPatternVariants();
  let best = { score: -1, placements: [], occupied: new Map(), evaluatedCandidates: 0 };

  for (const pattern of patternVariants) {
    for (let rowOffset = 0; rowOffset < FOUR_CLIP_PERIOD; rowOffset += 1) {
      for (let colOffset = 0; colOffset < FOUR_CLIP_PERIOD; colOffset += 1) {
        if (performance.now() >= deadline) {
          return best.score >= 0 ? best : buildEmptyFourClipPeriodicResult();
        }

        const candidate = buildFourClipPeriodicCandidate(request, pattern, rowOffset, colOffset);
        candidate.evaluatedCandidates = best.evaluatedCandidates + 1;
        if (candidate.score > best.score) {
          best = candidate;
          sendProgress(
            `Evaluating periodic 4-clip cutouts... ${candidate.evaluatedCandidates}`,
            buildCenterSolverPayload(
              request,
              candidate.occupied,
              candidate.placements,
              performance.now() - solveStart,
              candidate.evaluatedCandidates,
            ),
            true,
          );
          await yieldToEventLoop();
        } else {
          best.evaluatedCandidates = candidate.evaluatedCandidates;
        }
      }
    }
  }

  return best.score >= 0 ? best : buildEmptyFourClipPeriodicResult();
}

function buildEmptyFourClipPeriodicResult() {
  return {
    score: 0,
    placements: [],
    occupied: new Map(),
    evaluatedCandidates: 0,
  };
}

function buildFourClipPeriodicCandidate(request, pattern, rowOffset, colOffset) {
  if (request.symmetry === "None") {
    return buildFourClipPeriodicNoneCandidate(request, pattern, rowOffset, colOffset);
  }
  return buildFourClipPeriodicSymmetricCandidate(request, pattern, rowOffset, colOffset);
}

function buildFourClipPeriodicNoneCandidate(request, pattern, rowOffset, colOffset) {
  const placements = [];
  const occupied = new Map();
 
  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const modRow = normalizePeriodicOffset(row - rowOffset);
      const modCol = normalizePeriodicOffset(col - colOffset);
      if (!pattern.has(cellKey(modRow, modCol))) {
        continue;
      }
      const placement = buildFourClipPlacement(row, col);
      if (!placementFitsTemplate(request, placement)) {
        continue;
      }
      placements.push(buildCenterPlacementFromRowCol(row, col));
      applyBundle({ members: [placement] }, occupied);
    }
  }

  return {
    score: occupied.size,
    placements,
    occupied,
    evaluatedCandidates: 0,
  };
}

function buildFourClipPeriodicSymmetricCandidate(request, pattern, rowOffset, colOffset) {
  const candidatePlacements = [];
  const seenBundles = new Set();

  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const modRow = normalizePeriodicOffset(row - rowOffset);
      const modCol = normalizePeriodicOffset(col - colOffset);
      if (!pattern.has(cellKey(modRow, modCol))) {
        continue;
      }

      const placement = buildFourClipPlacement(row, col);
      if (!placementFitsTemplate(request, placement)) {
        continue;
      }

      const bundle = buildSymmetryBundle(request, placement, "4-Clip");
      if (!bundle || seenBundles.has(bundle.signature)) {
        continue;
      }

      seenBundles.add(bundle.signature);
      candidatePlacements.push(bundle);
    }
  }

  candidatePlacements.sort((left, right) => right.coverage.size - left.coverage.size);

  const occupied = new Map();
  const selectedPlacements = [];

  for (const bundle of candidatePlacements) {
    const evaluation = evaluateBundle(bundle, occupied, new Set());
    if (!evaluation.fits) {
      continue;
    }
    applyBundle(bundle, occupied);
    for (const member of bundle.members) {
      const centerPlacement = centerPlacementFromPlacement(member);
      if (centerPlacement) {
        selectedPlacements.push(centerPlacement);
      }
    }
  }

  return {
    score: occupied.size,
    placements: dedupeCenterPlacements(selectedPlacements),
    occupied,
    evaluatedCandidates: 0,
  };
}

function dedupeCenterPlacements(placements) {
  const seen = new Set();
  const deduped = [];
  for (const placement of placements) {
    if (seen.has(placement.centerKey)) {
      continue;
    }
    seen.add(placement.centerKey);
    deduped.push(placement);
  }
  return deduped;
}

function buildFourClipPlacement(row, col) {
  return {
    cells: [
      { row: row - 1, col, token: "clipS", key: cellKey(row - 1, col) },
      { row, col: col - 1, token: "clipE", key: cellKey(row, col - 1) },
      { row, col, token: "loader", key: cellKey(row, col) },
      { row, col: col + 1, token: "clipW", key: cellKey(row, col + 1) },
      { row: row + 1, col, token: "clipN", key: cellKey(row + 1, col) },
    ],
  };
}

function buildCenterPlacementFromRowCol(row, col) {
  return {
    centerKey: cellKey(row, col),
    keys: [
      cellKey(row, col),
      cellKey(row - 1, col),
      cellKey(row + 1, col),
      cellKey(row, col - 1),
      cellKey(row, col + 1),
    ],
  };
}

function centerPlacementFromPlacement(placement) {
  const centerCell = placement.cells.find((cell) => cell.token === "loader");
  if (!centerCell) {
    return null;
  }
  return buildCenterPlacementFromRowCol(centerCell.row, centerCell.col);
}

function normalizePeriodicOffset(value) {
  return ((value % FOUR_CLIP_PERIOD) + FOUR_CLIP_PERIOD) % FOUR_CLIP_PERIOD;
}

function normalizePeriodicOffsetWithPeriod(value, period) {
  return ((value % period) + period) % period;
}

function buildSinglePlacementBundle(placement, shapeName) {
  return {
    members: [placement],
    coverage: new Set(placement.cells.map((cell) => cell.key)),
    signature: placementSignature(placement),
    shapeName,
  };
}

function cloneOccupiedMap(occupied) {
  return new Map(occupied);
}

function getFourClipPeriodicPatternVariants() {
  if (cachedFourClipPeriodicPatterns) {
    return cachedFourClipPeriodicPatterns;
  }

  const basePattern = solveFourClipToroidalPattern(FOUR_CLIP_PERIOD, FOUR_CLIP_PERIOD);
  const variants = [];
  const seen = new Set();

  for (const transformed of transformToroidalPattern(basePattern, FOUR_CLIP_PERIOD, FOUR_CLIP_PERIOD)) {
    const signature = [...transformed].sort().join("|");
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    variants.push(transformed);
  }

  cachedFourClipPeriodicPatterns = variants.length ? variants : [basePattern];
  return cachedFourClipPeriodicPatterns;
}

function transformToroidalPattern(pattern, height, width) {
  const cells = [...pattern].map((key) => key.split(",").map(Number));
  const variants = [];
  const transforms = [
    (row, col) => [row, col],
    (row, col) => [col, width - 1 - row],
    (row, col) => [height - 1 - row, width - 1 - col],
    (row, col) => [height - 1 - col, row],
    (row, col) => [height - 1 - row, col],
    (row, col) => [row, width - 1 - col],
    (row, col) => [col, row],
    (row, col) => [height - 1 - col, width - 1 - row],
  ];

  for (const transform of transforms) {
    const next = new Set();
    for (const [row, col] of cells) {
      const [nextRow, nextCol] = transform(row, col);
      next.add(cellKey(normalizePeriodicOffset(nextRow), normalizePeriodicOffset(nextCol)));
    }
    variants.push(next);
  }

  return variants;
}

function solveFourClipToroidalPattern(height, width) {
  const placements = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const keys = [
        cellKey(row, col),
        cellKey(normalizePeriodicOffset(row - 1), col),
        cellKey(normalizePeriodicOffset(row + 1), col),
        cellKey(row, normalizePeriodicOffset(col - 1)),
        cellKey(row, normalizePeriodicOffset(col + 1)),
      ];
      placements.push({ centerKey: cellKey(row, col), keys });
    }
  }

  const conflictMasks = buildPlacementConflictMasks(placements);
  const allMask = (1n << BigInt(placements.length)) - 1n;
  const bestMask = solveToroidalIndependentSet(conflictMasks, allMask, placements.length);
  const pattern = new Set();

  for (let index = 0; index < placements.length; index += 1) {
    if ((bestMask & (1n << BigInt(index))) !== 0n) {
      pattern.add(placements[index].centerKey);
    }
  }

  return pattern;
}

function solveToroidalIndependentSet(conflictMasks, availableMask, size) {
  let bestMask = 0n;
  let bestCount = 0;

  const search = (mask, chosenMask, chosenCount) => {
    if (mask === 0n) {
      if (chosenCount > bestCount) {
        bestCount = chosenCount;
        bestMask = chosenMask;
      }
      return;
    }

    if (chosenCount + popcountBigInt(mask) <= bestCount) {
      return;
    }

    const branchIndex = chooseToroidalBranch(mask, conflictMasks, size);
    const branchBit = 1n << BigInt(branchIndex);
    search(
      mask & ~branchBit & ~conflictMasks[branchIndex],
      chosenMask | branchBit,
      chosenCount + 1,
    );
    search(mask & ~branchBit, chosenMask, chosenCount);
  };

  search(availableMask, 0n, 0);
  return bestMask;
}

function chooseToroidalBranch(mask, conflictMasks, size) {
  let bestIndex = -1;
  let bestDegree = -1;
  for (let index = 0; index < size; index += 1) {
    const bit = 1n << BigInt(index);
    if ((mask & bit) === 0n) {
      continue;
    }
    const degree = popcountBigInt(conflictMasks[index] & mask);
    if (degree > bestDegree) {
      bestDegree = degree;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function describeSatFallback(error, solveQuality, context) {
  const rawMessage = error instanceof Error ? error.message : "";
  if (rawMessage.includes("timed out")) {
    const limit = solveQuality ? ` after the ${solveQuality} limit` : "";
    return `CryptoMiniSat timed out during ${context}${limit}; continued with JS fallback.`;
  }

  if (rawMessage) {
    return `CryptoMiniSat failed during ${context}; continued with JS fallback. ${rawMessage}`;
  }

  return `CryptoMiniSat failed during ${context}; continued with JS fallback.`;
}

function buildInitialSeed(request, bundles, freeCellCount, cellToBundles, seedAttempts) {
  let best = greedyPass(request, bundles, freeCellCount, cellToBundles);

  for (let attempt = 1; attempt < seedAttempts; attempt += 1) {
    const candidate = greedyPass(request, bundles, freeCellCount, cellToBundles);
    if (candidate.score > best.score) {
      best = candidate;
      if (best.score === freeCellCount) {
        break;
      }
    }
  }

  return best;
}

function buildCenterSolverPayload(request, occupied, selectedPlacements, durationMs, passes) {
  const totalFree = request.width * request.height - request.blockedCells.length;
  const fillCells = occupied.size;
  const shapeCount = selectedPlacements.length;

  return {
    width: request.width,
    height: request.height,
    template: request.template,
    symmetry: request.symmetry,
    hardSymmetry: request.hardSymmetry,
    blockedCells: request.blockedCells,
    fillCells,
    totalFreeCells: totalFree,
    fillRatio: totalFree === 0 ? 0 : fillCells / totalFree,
    durationMs,
    passes,
    shapeCounts: shapeCount ? { "4-Clip": shapeCount } : {},
    selectedBundles: selectedPlacements.map((placement, index) => ({
      id: `exact4-${index}`,
      shape: "4-Clip",
      members: [placement.keys.map((key) => keyToTokenCell(placement.centerKey, key))],
    })),
    grid: [...occupied.entries()].map(([key, token]) => ({ key, token })),
    quality: request.solveQuality,
    solverBackend: request.solveDiagnostics.backend,
    solverRoute: request.solveDiagnostics.route,
    solverNote: request.solveDiagnostics.fallbackReason,
    solveRequest: request.solveDiagnostics.request,
  };
}

function greedyPass(request, bundles, freeCellCount, cellToBundles) {
  const occupied = new Map();
  const skipped = new Set();
  const selected = [];
  const shapeCounts = {};
  const orderedBundles = [...bundles];
  shuffleInPlace(orderedBundles);

  while (true) {
    const targetInfo = findNextTargetCell(request, occupied, skipped, cellToBundles);
    const target = targetInfo?.key ?? null;
    if (!target) {
      break;
    }

    let bestBundle = null;
    let bestScore = -Infinity;
    const pool = targetInfo.fittingBundles.length ? targetInfo.fittingBundles : orderedBundles;

    for (const bundle of pool) {
      const evalResult = evaluateBundle(bundle, occupied, skipped);
      if (!evalResult.fits || evalResult.newCells === 0) {
        continue;
      }

      const score = evalResult.newCells * 10 + bundle.members.length * 1.6 + bundle.coverage.size * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestBundle = bundle;
      }
    }

    if (!bestBundle) {
      skipped.add(target);
      continue;
    }

    applyBundle(bestBundle, occupied);
    selected.push(bestBundle.id);
    shapeCounts[bestBundle.shapeName] = (shapeCounts[bestBundle.shapeName] ?? 0) + 1;

    if (occupied.size === freeCellCount) {
      break;
    }
  }

  return {
    score: occupied.size,
    occupied,
    selected,
    shapeCounts,
  };
}

function payloadFromCandidate(request, candidate, bundles, durationMs, passes) {
  const totalFree = request.width * request.height - request.blockedCells.length;
  const fillRatio = totalFree === 0 ? 0 : candidate.score / totalFree;
  const selectedBundleIds = new Set(candidate.selected);
  const selectedBundles = bundles
    .filter((bundle) => selectedBundleIds.has(bundle.id))
    .map((bundle) => ({
      id: bundle.id,
      shape: bundle.shapeName,
      members: bundle.members.map((member) =>
        member.cells.map((cell) => ({ row: cell.row, col: cell.col, token: cell.token })),
      ),
    }));

  return {
    width: request.width,
    height: request.height,
    template: request.template,
    symmetry: request.symmetry,
    hardSymmetry: request.hardSymmetry,
    blockedCells: request.blockedCells,
    fillCells: candidate.score,
    totalFreeCells: totalFree,
    fillRatio,
    durationMs,
    passes,
    shapeCounts: { ...candidate.shapeCounts },
    selectedBundles,
    grid: [...candidate.occupied.entries()].map(([key, token]) => ({ key, token })),
    quality: request.solveQuality,
    solverBackend: request.solveDiagnostics.backend,
    solverNote: request.solveDiagnostics.fallbackReason,
    solveRequest: request.solveDiagnostics.request,
  };
}

function buildEmptyPayload(request, durationMs) {
  const freeCellCount = request.width * request.height - request.blockedCells.length;
  return {
    width: request.width,
    height: request.height,
    template: request.template,
    symmetry: request.symmetry,
    hardSymmetry: request.hardSymmetry,
    blockedCells: request.blockedCells,
    fillCells: 0,
    totalFreeCells: freeCellCount,
    fillRatio: 0,
    durationMs,
    passes: 0,
    shapeCounts: {},
    selectedBundles: [],
    grid: [],
    quality: request.solveQuality,
    solverBackend: request.solveDiagnostics.backend,
    solverNote: request.solveDiagnostics.fallbackReason,
    solveRequest: request.solveDiagnostics.request,
  };
}

function buildOriginalSatPayload(request, placements, durationMs, passes) {
  const occupied = new Map();
  const shapeCounts = {};

  for (const placement of placements) {
    for (const cell of placement.cells) {
      if (!occupied.has(cell.key)) {
        occupied.set(cell.key, cell.token);
      }
    }
    shapeCounts[placement.shapeName] = (shapeCounts[placement.shapeName] ?? 0) + 1;
  }

  const totalFree = request.width * request.height - request.blockedCells.length;
  return {
    width: request.width,
    height: request.height,
    template: request.template,
    symmetry: request.symmetry,
    hardSymmetry: request.hardSymmetry,
    blockedCells: request.blockedCells,
    fillCells: occupied.size,
    totalFreeCells: totalFree,
    fillRatio: totalFree === 0 ? 0 : occupied.size / totalFree,
    durationMs,
    passes,
    shapeCounts,
    selectedBundles: placements.map((placement) => ({
      id: placement.id,
      shape: placement.shapeName,
      members: [
        placement.cells.map((cell) => ({
          row: cell.row,
          col: cell.col,
          token: cell.token,
        })),
      ],
    })),
    grid: [...occupied.entries()].map(([key, token]) => ({ key, token })),
    quality: request.solveQuality,
    solverBackend: request.solveDiagnostics.backend,
    solverNote: request.solveDiagnostics.fallbackReason,
    solveRequest: request.solveDiagnostics.request,
  };
}

async function generateRawPlacements(request, deadline, onProgress) {
  const placements = [];
  let placementIndex = 0;
  let checkedPlacements = 0;

  for (const shape of request.enabledShapes) {
    const rotations = getShapeRotations(shape);
    for (let rotationIndex = 0; rotationIndex < rotations.length; rotationIndex += 1) {
      const rotation = rotations[rotationIndex];
      const maxRow = request.height - rotation.height;
      const maxCol = request.width - rotation.width;

      for (let row = 0; row <= maxRow; row += 1) {
        for (let col = 0; col <= maxCol; col += 1) {
          checkedPlacements += 1;
          if (checkedPlacements % 500 === 0) {
            onProgress(placements.length);
            await yieldToEventLoop();
            if (performance.now() >= deadline) {
              return placements;
            }
          }

          const placement = buildPlacement(rotation, row, col);
          if (!placementFitsTemplate(request, placement)) {
            continue;
          }

          placements.push({
            id: `raw-${placementIndex += 1}`,
            placementIndex,
            shapeId: shape.id,
            shapeName: shape.name,
            rotationIndex,
            row,
            col,
            cells: placement.cells,
            coveredKeys: placement.cells.map((cell) => cell.key),
            signature: placementSignature(placement),
          });
        }
      }
    }
  }

  return placements;
}

function applySymmetryAndGroupOriginal(rawPlacements, request) {
  const variableToElementMap = new Map();
  const elements = [];
  const assignedPlacementIds = new Set();
  const placementLookup = new Map();
  const operations = getSymmetryOperations(request.symmetry);
  let nextVariableId = 1;

  for (const placement of rawPlacements) {
    placementLookup.set(placement.signature, placement);
  }

  for (const seedPlacement of rawPlacements) {
    if (assignedPlacementIds.has(seedPlacement.id)) {
      continue;
    }

    const orbit = buildPlacementSymmetryOrbit(seedPlacement, request, placementLookup, operations);
    const currentGroup = orbit?.placements ?? [seedPlacement];
    const isConsistent = orbit?.complete && groupPlacementsAreInternallyConsistent(currentGroup);
    if (isConsistent) {
      const element = {
        variableId: nextVariableId,
        placements: currentGroup,
      };
      nextVariableId += 1;
      elements.push(element);
      variableToElementMap.set(element.variableId, element);
      for (const placement of currentGroup) {
        assignedPlacementIds.add(placement.id);
      }
      continue;
    }

    if (!request.hardSymmetry && request.symmetry === "None") {
      for (const placement of currentGroup) {
        if (assignedPlacementIds.has(placement.id)) {
          continue;
        }
        const element = {
          variableId: nextVariableId,
          placements: [placement],
        };
        nextVariableId += 1;
        elements.push(element);
        variableToElementMap.set(element.variableId, element);
        assignedPlacementIds.add(placement.id);
      }
    } else {
      for (const placement of currentGroup) {
        assignedPlacementIds.add(placement.id);
      }
    }
  }

  return {
    elements,
    variableToElementMap,
  };
}

function buildPlacementSymmetryOrbit(seedPlacement, request, placementLookup, operations) {
  const placements = [];
  const seenIds = new Set();

  for (const operation of operations) {
    const transformed = transformPlacement(request, { cells: seedPlacement.cells }, operation);
    if (!transformed || !placementFitsTemplate(request, transformed)) {
      return { complete: false, placements };
    }

    const partner = placementLookup.get(placementSignature(transformed));
    if (!partner) {
      return { complete: false, placements };
    }

    if (!seenIds.has(partner.id)) {
      seenIds.add(partner.id);
      placements.push(partner);
    }
  }

  return { complete: true, placements };
}

function groupPlacementsAreInternallyConsistent(placements) {
  const cellEntries = new Map();

  for (const placement of placements) {
    for (const cell of placement.cells) {
      if (!cellEntries.has(cell.key)) {
        cellEntries.set(cell.key, []);
      }
      cellEntries.get(cell.key).push(cell.token);
    }
  }

  for (const tokens of cellEntries.values()) {
    for (let index = 0; index < tokens.length; index += 1) {
      for (let other = index + 1; other < tokens.length; other += 1) {
        if (!canShareCell(tokens[index], tokens[other])) {
          return false;
        }
      }
    }
  }

  return true;
}

function buildOriginalSatModel(elements, request) {
  const cellCoverageMap = new Map();
  const conflictPairs = new Set();

  for (const element of elements) {
    const uniqueCoverage = new Set();
    for (const placement of element.placements) {
      for (const cell of placement.cells) {
        if (!cellCoverageMap.has(cell.key)) {
          cellCoverageMap.set(cell.key, []);
        }
        cellCoverageMap.get(cell.key).push({
          variableId: element.variableId,
          token: cell.token,
        });
        uniqueCoverage.add(cell.key);
      }
    }
    element.coveredKeys = [...uniqueCoverage];
  }

  for (const entries of cellCoverageMap.values()) {
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        const leftEntry = entries[left];
        const rightEntry = entries[right];
        if (
          leftEntry.variableId !== rightEntry.variableId &&
          !canShareCell(leftEntry.token, rightEntry.token)
        ) {
          const minVar = Math.min(leftEntry.variableId, rightEntry.variableId);
          const maxVar = Math.max(leftEntry.variableId, rightEntry.variableId);
          conflictPairs.add(`${minVar},${maxVar}`);
        }
      }
    }
  }

  const conflictClauses = [...conflictPairs].map((pair) => {
    const [left, right] = pair.split(",").map(Number);
    return [-left, -right];
  });

  const openCells = [];
  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const key = cellKey(row, col);
      if (!request.blockedLookup.has(key)) {
        openCells.push(key);
      }
    }
  }

  return {
    elements,
    cellCoverageMap,
    conflictClauses,
    openCells,
    maxVariableId: Math.max(0, ...elements.map((element) => element.variableId)),
  };
}

function buildOriginalSolveCnf(satModel, requiredCells) {
  const clauses = satModel.conflictClauses.map((clause) => [...clause]);
  const yVars = [];
  let nextVar = satModel.maxVariableId;

  for (const key of satModel.openCells) {
    nextVar += 1;
    const yVar = nextVar;
    yVars.push(yVar);
    const covering = satModel.cellCoverageMap.get(key) ?? [];
    const uniqueCovering = [...new Set(covering.map((entry) => entry.variableId))];

    if (!uniqueCovering.length) {
      clauses.push([-yVar]);
      continue;
    }

    clauses.push([-yVar, ...uniqueCovering]);
    for (const variableId of uniqueCovering) {
      clauses.push([-variableId, yVar]);
    }
  }

  const ref = { value: nextVar };
  const { clauses: atLeastClauses, variableCount } = encodeAtLeastK(yVars, requiredCells, ref);
  appendClauses(clauses, atLeastClauses);

  return {
    dimacs: buildDimacs(clauses, variableCount),
  };
}

function calculateOriginalDecrementStep(enabledShapes) {
  const shapeAreas = enabledShapes.map((shape) => getShapeArea(shape.matrix)).filter((area) => area > 0);
  if (!shapeAreas.length) {
    return 1;
  }
  if (enabledShapes.some((shape) => shapeCouldSelfIntersect(shape.matrix))) {
    return 1;
  }
  return shapeAreas.reduce((acc, area) => gcd(acc, area));
}

function shapeCouldSelfIntersect(matrix) {
  for (const row of matrix) {
    for (const token of row) {
      if (token && CELL_META[token]?.canOverlap) {
        return true;
      }
    }
  }
  return false;
}

function mapOriginalSatResult(model, variableToElementMap) {
  const placements = [];
  const positiveVars = new Set(model.filter((value) => value > 0));
  for (const variableId of positiveVars) {
    const element = variableToElementMap.get(variableId);
    if (element) {
      placements.push(...element.placements);
    }
  }
  return placements;
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

function shouldForceRotational90(request) {
  return false;
}

function buildSolveRequestDiagnostics(request) {
  const expectedBlocked = buildTemplateBlockedCells(request.template, request.width, request.height);
  const expectedSet = new Set(expectedBlocked);
  const actualSet = new Set(request.blockedCells);
  let manualEdits = 0;

  for (const key of actualSet) {
    if (!expectedSet.has(key)) {
      manualEdits += 1;
    }
  }
  for (const key of expectedSet) {
    if (!actualSet.has(key)) {
      manualEdits += 1;
    }
  }

  return {
    width: request.width,
    height: request.height,
    gridArea: request.width * request.height,
    template: request.template,
    symmetry: request.symmetry,
    hardSymmetry: request.hardSymmetry,
    quality: request.solveQuality,
    enabledShapes: request.enabledShapes.map((shape) => shape.name),
    blockedCount: request.blockedCells.length,
    openCount: request.width * request.height - request.blockedCells.length,
    templateBlockedCount: expectedBlocked.length,
    manualEditDelta: manualEdits,
  };
}

function buildTemplateBlockedCells(templateName, width, height) {
  return [...generateTemplateBlockedCells(templateName, width, height)];
}

function snapshotCandidate(occupied, selected, shapeCounts) {
  return {
    score: occupied.size,
    occupied: new Map(occupied),
    selected: [...selected],
    shapeCounts: { ...shapeCounts },
  };
}

async function generateCandidateBundles(request, bundleLimit, deadline, onProgress) {
  const bundles = [];
  const seen = new Set();
  let bundleIndex = 0;
  let checkedPlacements = 0;

  for (const shape of request.enabledShapes) {
    const rotations = getShapeRotations(shape);

    for (const rotation of rotations) {
      const maxRow = request.height - rotation.height;
      const maxCol = request.width - rotation.width;

      for (let row = 0; row <= maxRow; row += 1) {
        for (let col = 0; col <= maxCol; col += 1) {
          checkedPlacements += 1;
          if (checkedPlacements % 250 === 0) {
            onProgress(bundles.length);
            await yieldToEventLoop();
            if (performance.now() >= deadline) {
              return bundles.sort((a, b) => b.coverage.size - a.coverage.size);
            }
          }

          const basePlacement = buildPlacement(rotation, row, col);
          if (!placementFitsTemplate(request, basePlacement)) {
            continue;
          }

          const bundle = buildSymmetryBundle(request, basePlacement, shape.name);
          if (!bundle) {
            continue;
          }

          const key = `${shape.id}:${bundle.signature}`;
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          bundles.push({
            ...bundle,
            id: `bundle-${bundleIndex += 1}`,
            shapeName: shape.name,
          });

          if (bundles.length >= bundleLimit) {
            onProgress(bundles.length);
            return bundles.sort((a, b) => b.coverage.size - a.coverage.size);
          }
        }
      }
    }
  }

  return bundles.sort((a, b) => b.coverage.size - a.coverage.size);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildCellToBundlesMap(bundles) {
  const map = new Map();
  for (const bundle of bundles) {
    for (const key of bundle.coverage) {
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key).push(bundle);
    }
  }
  return map;
}

function buildCellCoverageMap(bundles, bundleVarById) {
  const map = new Map();

  for (const bundle of bundles) {
    const bundleVar = bundleVarById.get(bundle.id);
    const seenCells = new Set();
    for (const member of bundle.members) {
      for (const cell of member.cells) {
        if (seenCells.has(cell.key)) {
          continue;
        }
        seenCells.add(cell.key);
        if (!map.has(cell.key)) {
          map.set(cell.key, []);
        }
        map.get(cell.key).push(bundleVar);
      }
    }
  }

  return map;
}

function buildBundleConflictClauses(bundles, bundleVarById, conflictPairs = null) {
  const clauses = [];
  const pairs = conflictPairs ?? buildBundleConflictGraph(bundles).conflictPairs;

  for (const [left, right] of pairs) {
    clauses.push([
      -bundleVarById.get(bundles[left].id),
      -bundleVarById.get(bundles[right].id),
    ]);
  }

  return clauses;
}

function splitBundleInteractionComponents(bundles) {
  if (!bundles.length) {
    return [];
  }
  const { adjacency } = buildBundleConflictGraph(bundles);

  const seen = new Set();
  const components = [];

  for (let index = 0; index < bundles.length; index += 1) {
    if (seen.has(index)) {
      continue;
    }

    const queue = [index];
    const componentBundles = [];
    const componentCells = new Set();
    seen.add(index);

    while (queue.length) {
      const current = queue.pop();
      const bundle = bundles[current];
      componentBundles.push(bundle);
      for (const key of bundle.coverage) {
        componentCells.add(key);
      }

      for (const neighbor of adjacency[current]) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    components.push({
      bundles: componentBundles,
      cells: [...componentCells],
    });
  }

  return components;
}

function preprocessBundleComponent(component) {
  if (component.bundles.length <= 1) {
    return { component, conflictPairs: [] };
  }

  const { adjacency, conflictPairs } = buildBundleConflictGraph(component.bundles);
  const active = new Array(component.bundles.length).fill(true);
  let changed = true;

  while (changed) {
    changed = false;
    for (let left = 0; left < component.bundles.length; left += 1) {
      if (!active[left]) {
        continue;
      }
      for (let right = 0; right < component.bundles.length; right += 1) {
        if (left === right || !active[right]) {
          continue;
        }
        if (
          bundleDominates(
            component.bundles[right],
            adjacency[right],
            component.bundles[left],
            adjacency[left],
            active,
            left,
            right,
          )
        ) {
          active[left] = false;
          changed = true;
          break;
        }
      }
    }
  }

  if (active.every(Boolean)) {
    return { component, conflictPairs };
  }

  const reducedBundles = [];
  const remap = new Map();
  for (let index = 0; index < component.bundles.length; index += 1) {
    if (!active[index]) {
      continue;
    }
    remap.set(index, reducedBundles.length);
    reducedBundles.push(component.bundles[index]);
  }

  const reducedCells = new Set();
  for (const bundle of reducedBundles) {
    for (const key of bundle.coverage) {
      reducedCells.add(key);
    }
  }

  const reducedPairs = [];
  for (const [left, right] of conflictPairs) {
    const mappedLeft = remap.get(left);
    const mappedRight = remap.get(right);
    if (mappedLeft != null && mappedRight != null) {
      reducedPairs.push([mappedLeft, mappedRight]);
    }
  }

  return {
    component: {
      bundles: reducedBundles,
      cells: [...reducedCells],
    },
    conflictPairs: reducedPairs,
  };
}

function bundleDominates(
  dominatorBundle,
  dominatorNeighbors,
  dominatedBundle,
  dominatedNeighbors,
  active,
  dominatedIndex,
  dominatorIndex,
) {
  if (dominatedBundle.shapeName !== dominatorBundle.shapeName) {
    return false;
  }
  if (!coverageIsSubset(dominatedBundle.coverage, dominatorBundle.coverage)) {
    return false;
  }

  const dominatedNeighborSet = new Set(dominatedNeighbors);
  for (const neighbor of dominatorNeighbors) {
    if (!active[neighbor] || neighbor === dominatedIndex || neighbor === dominatorIndex) {
      continue;
    }
    if (!dominatedNeighborSet.has(neighbor)) {
      return false;
    }
  }

  return true;
}

function coverageIsSubset(subsetCoverage, supersetCoverage) {
  if (subsetCoverage.size > supersetCoverage.size) {
    return false;
  }
  for (const key of subsetCoverage) {
    if (!supersetCoverage.has(key)) {
      return false;
    }
  }
  return true;
}

function buildBundleConflictGraph(bundles) {
  const adjacency = Array.from({ length: bundles.length }, () => []);
  const conflictPairs = [];

  for (let left = 0; left < bundles.length; left += 1) {
    for (let right = left + 1; right < bundles.length; right += 1) {
      if (bundlesConflict(bundles[left], bundles[right])) {
        adjacency[left].push(right);
        adjacency[right].push(left);
        conflictPairs.push([left, right]);
      }
    }
  }

  return { adjacency, conflictPairs };
}

function buildBundleBitGraph(bundles, conflictPairs) {
  const conflicts = Array.from({ length: bundles.length }, () => 0n);
  for (const [left, right] of conflictPairs) {
    conflicts[left] |= 1n << BigInt(right);
    conflicts[right] |= 1n << BigInt(left);
  }
  return {
    bundles,
    conflicts,
    weights: bundles.map((bundle) => bundle.coverage.size),
    allMask: (1n << BigInt(bundles.length)) - 1n,
  };
}

function appendClauses(target, clauses) {
  for (const clause of clauses) {
    target.push(clause);
  }
}

function getRemainingSatBudgetMs(deadline, floorMs = 50) {
  const remainingMs = Math.round(deadline - performance.now());
  if (remainingMs <= 0) {
    throw new Error("SAT solver timed out after the allotted budget.");
  }
  return Math.max(floorMs, remainingMs);
}

async function solveGenericBundleComponentWithSat(request, component, deadline, onPass) {
  const reduced = preprocessBundleComponent(component);
  const workingComponent = reduced.component;
  const bundleVarById = new Map();
  const bundlesByVar = new Map();
  let nextVar = 1;
  for (const bundle of workingComponent.bundles) {
    bundleVarById.set(bundle.id, nextVar);
    bundlesByVar.set(nextVar, bundle);
    nextVar += 1;
  }

  const baseClauses = buildBundleConflictClauses(
    workingComponent.bundles,
    bundleVarById,
    reduced.conflictPairs,
  );
  const cellCoverageMap = buildCellCoverageMap(workingComponent.bundles, bundleVarById);
  const yVarByCell = new Map();
  for (const key of workingComponent.cells) {
    yVarByCell.set(key, nextVar);
    nextVar += 1;
  }

  for (const key of workingComponent.cells) {
    const yVar = yVarByCell.get(key);
    const covering = cellCoverageMap.get(key) ?? [];
    if (!covering.length) {
      baseClauses.push([-yVar]);
      continue;
    }

    baseClauses.push([-yVar, ...covering]);
    for (const bundleVar of covering) {
      baseClauses.push([-bundleVar, yVar]);
    }
  }

  const yVars = workingComponent.cells.map((key) => yVarByCell.get(key));
  const greedySeed = buildGenericComponentGreedySeed(workingComponent.bundles);
  let bestSelection = greedySeed.selectedBundles;
  let bestCoverage = greedySeed.coverage;
  let satCalls = 0;

  const searchResult = await optimizeTargetProgressively({
    lowerBound: bestCoverage,
    upperBound: workingComponent.cells.length,
    deadline,
    onAttempt: (target) => onPass(satCalls + 1, target),
    solveTarget: async (target) => {
      const workingClauses = baseClauses.map((clause) => [...clause]);
      const ref = { value: nextVar };
      const { clauses: atLeastClauses, variableCount } = encodeAtLeastK(yVars, target, ref);
      appendClauses(workingClauses, atLeastClauses);
      satCalls += 1;
      return runExternalSat(buildDimacs(workingClauses, variableCount), getRemainingSatBudgetMs(deadline));
    },
  });

  if (searchResult.bestModel.length) {
    const modelSet = new Set(searchResult.bestModel.filter((value) => value > 0));
    bestSelection = [];
    for (const [bundleVar, bundle] of bundlesByVar.entries()) {
      if (modelSet.has(bundleVar)) {
        bestSelection.push(bundle);
      }
    }
  }

  return {
    selectedBundles: bestSelection,
    satCalls,
  };
}

function buildGenericComponentGreedySeed(bundles) {
  const remaining = [...bundles];
  const occupied = new Map();
  const selectedBundles = [];

  while (remaining.length) {
    let bestIndex = -1;
    let bestScore = -1;

    for (let index = 0; index < remaining.length; index += 1) {
      const evalResult = evaluateBundle(remaining[index], occupied, new Set());
      if (!evalResult.fits || evalResult.newCells === 0) {
        continue;
      }
      if (evalResult.newCells > bestScore) {
        bestScore = evalResult.newCells;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const [bundle] = remaining.splice(bestIndex, 1);
    applyBundle(bundle, occupied);
    selectedBundles.push(bundle);
  }

  return {
    coverage: occupied.size,
    selectedBundles,
  };
}

function bundlesConflict(leftBundle, rightBundle) {
  const leftCells = new Map();
  for (const member of leftBundle.members) {
    for (const cell of member.cells) {
      if (!leftCells.has(cell.key)) {
        leftCells.set(cell.key, []);
      }
      leftCells.get(cell.key).push(cell.token);
    }
  }

  for (const member of rightBundle.members) {
    for (const cell of member.cells) {
      if (!leftCells.has(cell.key)) {
        continue;
      }
      const tokens = leftCells.get(cell.key);
      if (tokens.some((existingToken) => !canShareCell(existingToken, cell.token))) {
        return true;
      }
    }
  }

  return false;
}

function findNextTargetCell(request, occupied, skipped, cellToBundles) {
  let best = null;

  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const key = cellKey(row, col);
      if (request.blockedLookup.has(key) || occupied.has(key) || skipped.has(key)) {
        continue;
      }

      const fittingBundles = (cellToBundles.get(key) ?? []).filter(
        (bundle) => evaluateBundle(bundle, occupied, skipped).fits,
      );
      const candidateCount = fittingBundles.length;
      const distance =
        Math.abs(row - (request.height - 1) / 2) + Math.abs(col - (request.width - 1) / 2);

      if (
        !best ||
        candidateCount < best.candidateCount ||
        (candidateCount === best.candidateCount && distance > best.distance)
      ) {
        best = { key, fittingBundles, candidateCount, distance };
        if (candidateCount === 0) {
          return best;
        }
      }
    }
  }

  return best;
}

function evaluateBundle(bundle, occupied, skipped) {
  let newCells = 0;

  for (const member of bundle.members) {
    for (const cell of member.cells) {
      if (skipped.has(cell.key)) {
        return { fits: false, newCells: 0 };
      }
      const existing = occupied.get(cell.key);
      if (existing && !canShareCell(existing, cell.token)) {
        return { fits: false, newCells: 0 };
      }
      if (!existing) {
        newCells += 1;
      }
    }
  }

  return { fits: true, newCells };
}

function applyBundle(bundle, occupied) {
  for (const member of bundle.members) {
    for (const cell of member.cells) {
      if (!occupied.has(cell.key)) {
        occupied.set(cell.key, cell.token);
      }
    }
  }
}

function applyBundleTracked(bundle, occupied) {
  const appliedKeys = [];
  for (const member of bundle.members) {
    for (const cell of member.cells) {
      if (!occupied.has(cell.key)) {
        occupied.set(cell.key, cell.token);
        appliedKeys.push(cell.key);
      }
    }
  }
  return appliedKeys;
}

function undoBundle(appliedKeys, occupied) {
  for (const key of appliedKeys) {
    occupied.delete(key);
  }
}

function estimateRemainingFill(request, occupied, skipped, shapeAreas, knapsack) {
  const components = extractOpenComponents(request, occupied, skipped);
  let maxFill = 0;

  for (const componentKeys of components) {
    maxFill += estimateComponentFill(request, componentKeys, componentKeys.length, knapsack);
  }

  return maxFill;
}

function estimateComponentFill(request, componentKeys, componentSize, knapsack) {
  return bestReachableAtOrBelow(componentSize, knapsack);
}

function buildReachabilityTable(shapeAreas, limit) {
  const reachable = new Array(limit + 1).fill(false);
  reachable[0] = true;

  for (let total = 1; total <= limit; total += 1) {
    reachable[total] = shapeAreas.some((area) => total >= area && reachable[total - area]);
  }

  return reachable;
}

function bestReachableAtOrBelow(size, reachable) {
  for (let candidate = size; candidate >= 0; candidate -= 1) {
    if (reachable[candidate]) {
      return candidate;
    }
  }
  return 0;
}

async function optimizeTargetProgressively({ lowerBound, upperBound, deadline, solveTarget, onAttempt }) {
  let bestTarget = Math.max(0, Math.min(lowerBound, upperBound));
  let bestModel = [];
  let attempts = 0;
  const cache = new Map();

  const tryTarget = async (target) => {
    if (cache.has(target)) {
      return cache.get(target);
    }
    onAttempt?.(target);
    attempts += 1;
    const result = await solveTarget(target);
    cache.set(target, result);
    return result;
  };

  let step = 1;
  let unsatUpper = upperBound + 1;
  while (bestTarget + step <= upperBound && performance.now() < deadline) {
    const target = bestTarget + step;
    const result = await tryTarget(target);
    if (result.satisfiable) {
      bestTarget = target;
      bestModel = result.model;
      step *= 2;
    } else {
      unsatUpper = target;
      break;
    }
  }

  let low = bestTarget + 1;
  let high = Math.min(upperBound, unsatUpper - 1);
  if (unsatUpper === upperBound + 1) {
    high = upperBound;
  }

  while (low <= high && performance.now() < deadline) {
    const target = Math.floor((low + high) / 2);
    const result = await tryTarget(target);
    if (result.satisfiable) {
      bestTarget = target;
      bestModel = result.model;
      low = target + 1;
    } else {
      high = target - 1;
    }
  }

  return { bestTarget, bestModel, attempts };
}

function buildPlacementConflictMasks(placements) {
  const placementsByCell = new Map();
  const masks = Array.from({ length: placements.length }, () => 0n);

  for (let index = 0; index < placements.length; index += 1) {
    for (const key of placements[index].keys) {
      if (!placementsByCell.has(key)) {
        placementsByCell.set(key, []);
      }
      placementsByCell.get(key).push(index);
    }
  }

  for (const indexes of placementsByCell.values()) {
    for (const left of indexes) {
      for (const right of indexes) {
        if (left !== right) {
          masks[left] |= 1n << BigInt(right);
        }
      }
    }
  }

  return masks;
}

function popcountBigInt(value) {
  let count = 0;
  let current = value;
  while (current !== 0n) {
    current &= current - 1n;
    count += 1;
  }
  return count;
}

function applyExactFourClipPlacement(placement, occupied, appliedKeys, filledKeys) {
  const [centerRow, centerCol] = placement.centerKey.split(",").map(Number);
  const tokenByKey = new Map([
    [cellKey(centerRow, centerCol), "loader"],
    [cellKey(centerRow - 1, centerCol), "clipS"],
    [cellKey(centerRow + 1, centerCol), "clipN"],
    [cellKey(centerRow, centerCol - 1), "clipE"],
    [cellKey(centerRow, centerCol + 1), "clipW"],
  ]);

  for (const key of placement.keys) {
    filledKeys.add(key);
    if (!occupied.has(key)) {
      occupied.set(key, tokenByKey.get(key) ?? "loader");
      appliedKeys.push(key);
    }
  }
}

function keyToTokenCell(centerKey, key) {
  const [centerRow, centerCol] = centerKey.split(",").map(Number);
  const [row, col] = key.split(",").map(Number);

  let token = "loader";
  if (row === centerRow - 1 && col === centerCol) {
    token = "clipS";
  } else if (row === centerRow + 1 && col === centerCol) {
    token = "clipN";
  } else if (row === centerRow && col === centerCol - 1) {
    token = "clipE";
  } else if (row === centerRow && col === centerCol + 1) {
    token = "clipW";
  }

  return { row, col, token };
}

function extractOpenComponents(request, occupied, skipped) {
  const seen = new Set();
  const components = [];

  for (let row = 0; row < request.height; row += 1) {
    for (let col = 0; col < request.width; col += 1) {
      const startKey = cellKey(row, col);
      if (
        request.blockedLookup.has(startKey) ||
        occupied.has(startKey) ||
        skipped.has(startKey) ||
        seen.has(startKey)
      ) {
        continue;
      }

      const queue = [startKey];
      const componentKeys = [startKey];
      seen.add(startKey);

      while (queue.length) {
        const current = queue.pop();
        const [currentRow, currentCol] = current.split(",").map(Number);
        const neighbors = [
          [currentRow - 1, currentCol],
          [currentRow + 1, currentCol],
          [currentRow, currentCol - 1],
          [currentRow, currentCol + 1],
        ];

        for (const [nextRow, nextCol] of neighbors) {
          if (
            nextRow < 0 ||
            nextCol < 0 ||
            nextRow >= request.height ||
            nextCol >= request.width
          ) {
            continue;
          }
          const nextKey = cellKey(nextRow, nextCol);
          if (
            seen.has(nextKey) ||
            request.blockedLookup.has(nextKey) ||
            occupied.has(nextKey) ||
            skipped.has(nextKey)
          ) {
            continue;
          }
          seen.add(nextKey);
          queue.push(nextKey);
          componentKeys.push(nextKey);
        }
      }

      components.push(componentKeys);
    }
  }

  return components;
}

function getShapeArea(matrix) {
  let area = 0;
  for (const row of matrix) {
    for (const cell of row) {
      if (cell) {
        area += 1;
      }
    }
  }
  return area;
}

function buildStateKey(occupied, skipped) {
  const occupiedKeys = [...occupied.keys()].sort().join(";");
  const skippedKeys = [...skipped].sort().join(";");
  return `${occupiedKeys}|${skippedKeys}`;
}

function getShapeRotations(shape) {
  const rotations = [];
  const seen = new Set();
  let current = cloneMatrix(shape.matrix);
  const limit = shape.rotatable ? 4 : 1;

  for (let index = 0; index < limit; index += 1) {
    const normalized = trimMatrix(current);
    const signature = matrixSignature(normalized);
    if (!seen.has(signature)) {
      seen.add(signature);
      rotations.push(matrixToShape(normalized));
    }
    current = rotateMatrix(current);
  }

  return rotations;
}

function buildPlacement(rotation, anchorRow, anchorCol) {
  return {
    cells: rotation.cells.map((cell) => ({
      row: anchorRow + cell.row,
      col: anchorCol + cell.col,
      token: cell.token,
      key: cellKey(anchorRow + cell.row, anchorCol + cell.col),
    })),
  };
}

function placementFitsTemplate(request, placement) {
  for (const cell of placement.cells) {
    if (
      cell.row < 0 ||
      cell.col < 0 ||
      cell.row >= request.height ||
      cell.col >= request.width ||
      request.blockedLookup.has(cell.key)
    ) {
      return false;
    }
  }
  return true;
}

function buildSymmetryBundle(request, basePlacement, shapeName) {
  const operations = getSymmetryOperations(request.symmetry);
  const members = [];
  const seenMembers = new Set();

  for (const operation of operations) {
    const transformed = transformPlacement(request, basePlacement, operation);
    if (!transformed || !placementFitsTemplate(request, transformed)) {
      return null;
    }

    const memberSignature = placementSignature(transformed);
    if (!seenMembers.has(memberSignature)) {
      seenMembers.add(memberSignature);
      members.push(transformed);
    }
  }

  if (!bundleHasValidInternalOverlap(members)) {
    return null;
  }

  const coverage = new Set();
  for (const member of members) {
    for (const cell of member.cells) {
      coverage.add(cell.key);
    }
  }

  return {
    members,
    coverage,
    signature: [...seenMembers].sort().join("|"),
    shapeName,
  };
}

function bundleHasValidInternalOverlap(members) {
  const occupied = new Map();

  for (const member of members) {
    for (const cell of member.cells) {
      const existing = occupied.get(cell.key);
      if (existing && !canShareCell(existing, cell.token)) {
        return false;
      }
      if (!existing) {
        occupied.set(cell.key, cell.token);
      }
    }
  }

  return true;
}

function transformPlacement(request, placement, operation) {
  const transformedCells = [];

  for (const cell of placement.cells) {
    const transformedCoord = transformCoordinate(request, cell.row, cell.col, operation);
    if (!transformedCoord) {
      return null;
    }
    transformedCells.push({
      row: transformedCoord.row,
      col: transformedCoord.col,
      token: transformToken(cell.token, operation),
      key: cellKey(transformedCoord.row, transformedCoord.col),
    });
  }

  return { cells: transformedCells };
}

function transformCoordinate(request, row, col, operation) {
  switch (operation) {
    case "identity":
      return { row, col };
    case "rot90":
      return { row: col, col: request.width - 1 - row };
    case "rot180":
      return { row: request.height - 1 - row, col: request.width - 1 - col };
    case "rot270":
      return { row: request.height - 1 - col, col: row };
    case "reflectH":
      return { row: request.height - 1 - row, col };
    case "reflectV":
      return { row, col: request.width - 1 - col };
    default:
      return null;
  }
}

function transformToken(token, operation) {
  if (!token.startsWith("clip")) {
    return token;
  }

  const direction = token.at(-1);
  const rotate = {
    N: { rot90: "E", rot180: "S", rot270: "W" },
    E: { rot90: "S", rot180: "W", rot270: "N" },
    S: { rot90: "W", rot180: "N", rot270: "E" },
    W: { rot90: "N", rot180: "E", rot270: "S" },
  };

  const reflectH = { N: "S", S: "N", E: "E", W: "W" };
  const reflectV = { E: "W", W: "E", N: "N", S: "S" };

  if (operation === "reflectH") {
    return `clip${reflectH[direction]}`;
  }
  if (operation === "reflectV") {
    return `clip${reflectV[direction]}`;
  }
  if (operation === "identity") {
    return token;
  }
  return `clip${rotate[direction][operation]}`;
}

function getSymmetryOperations(symmetry) {
  switch (symmetry) {
    case "Rotational (90°)":
      return ["identity", "rot90", "rot180", "rot270"];
    case "Rotational (180°)":
      return ["identity", "rot180"];
    default:
      return ["identity"];
  }
}

function rotateMatrix(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result = Array.from({ length: cols }, () => Array(rows).fill(null));

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      result[col][rows - 1 - row] = rotateToken(matrix[row][col]);
    }
  }
  return result;
}

function rotateToken(token) {
  if (!token || !token.startsWith("clip")) {
    return token;
  }
  const next = { N: "E", E: "S", S: "W", W: "N" };
  return `clip${next[token.at(-1)]}`;
}

function trimMatrix(matrix) {
  const filledRows = matrix
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.some(Boolean))
    .map(({ index }) => index);
  const filledCols = matrix[0]
    .map((_, index) => index)
    .filter((index) => matrix.some((row) => row[index]));

  return filledRows.map((rowIndex) => filledCols.map((colIndex) => matrix[rowIndex][colIndex]));
}

function matrixToShape(matrix) {
  const cells = [];
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix[0].length; col += 1) {
      const token = matrix[row][col];
      if (token) {
        cells.push({ row, col, token });
      }
    }
  }
  return {
    width: matrix[0].length,
    height: matrix.length,
    cells,
  };
}

function matrixSignature(matrix) {
  return matrix.map((row) => row.map((cell) => cell ?? ".").join(",")).join(";");
}

function placementSignature(placement) {
  return placement.cells
    .map((cell) => `${cell.row}:${cell.col}:${cell.token}`)
    .sort()
    .join("|");
}

function cloneMatrix(matrix) {
  return matrix.map((row) => [...row]);
}

function canShareCell(existingToken, incomingToken) {
  return (
    existingToken === incomingToken &&
    CELL_META[existingToken] &&
    CELL_META[existingToken].canOverlap &&
    CELL_META[incomingToken].canOverlap
  );
}

function cellKey(row, col) {
  return `${row},${col}`;
}

function shuffleInPlace(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
  }
}
