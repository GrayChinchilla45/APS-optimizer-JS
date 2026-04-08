import { generateTemplateBlockedCells } from "./circle-template.js";

const TEMPLATE_OPTIONS = ["Circle (Center Hole)", "Circle (No Hole)", "None"];
const SYMMETRY_OPTIONS = [
  "None",
  "Rotational (90°)",
  "Rotational (180°)",
];
const SOLVE_TIMEOUT_LABEL = "15 seconds";

const CELL_META = {
  empty: { className: "empty", label: "", canOverlap: false },
  blocked: { className: "blocked", label: "", canOverlap: false },
  loader: { className: "loader", label: "L", canOverlap: false },
  clipN: { className: "clip", label: "↑", canOverlap: false },
  clipE: { className: "clip", label: "→", canOverlap: false },
  clipS: { className: "clip", label: "↓", canOverlap: false },
  clipW: { className: "clip", label: "←", canOverlap: false },
  cooler: { className: "cooler", label: "C", canOverlap: true },
};

const BASE_SHAPES = [
  {
    id: "clip3",
    name: "3-Clip",
    rotatable: true,
    matrix: [
      ["clipE", "loader", "clipW"],
      [null, "clipN", null],
    ],
  },
  {
    id: "clip4",
    name: "4-Clip",
    rotatable: false,
    matrix: [
      [null, "clipS", null],
      ["clipE", "loader", "clipW"],
      [null, "clipN", null],
    ],
  },
];

const state = {
  template: "Circle (Center Hole)",
  symmetry: "None",
  width: 15,
  height: 15,
  hardSymmetry: false,
  backendStatus: "Checking backend",
  selectedShapeId: BASE_SHAPES[0].id,
  blockedCells: new Set(),
  resultMap: new Map(),
  lastSolve: null,
  solverToken: 0,
};
let currentSolveController = null;
let currentStatusPollTimer = null;

const elements = {
  templateSelect: document.querySelector("#templateSelect"),
  symmetrySelect: document.querySelector("#symmetrySelect"),
  widthInput: document.querySelector("#widthInput"),
  heightInput: document.querySelector("#heightInput"),
  hardSymmetryToggle: document.querySelector("#hardSymmetryToggle"),
  shapeSelect: document.querySelector("#shapeSelect"),
  shapeList: document.querySelector("#shapeList"),
  editorGrid: document.querySelector("#editorGrid"),
  resultGrid: document.querySelector("#resultGrid"),
  solveButton: document.querySelector("#solveButton"),
  randomizeButton: document.querySelector("#randomizeButton"),
  downloadButton: document.querySelector("#downloadButton"),
  resetResultButton: document.querySelector("#resetResultButton"),
  resetBoardButton: document.querySelector("#resetBoardButton"),
  fillMetric: document.querySelector("#fillMetric"),
  shapeMetric: document.querySelector("#shapeMetric"),
  statusMetric: document.querySelector("#statusMetric"),
  backendInfo: document.querySelector("#backendInfo"),
  boardInfo: document.querySelector("#boardInfo"),
  solveAdvice: document.querySelector("#solveAdvice"),
  resultSummary: document.querySelector("#resultSummary"),
  searchTimer: document.querySelector("#searchTimer"),
  summaryContent: document.querySelector("#summaryContent"),
};

initialize();

function initialize() {
  populateSelect(elements.templateSelect, TEMPLATE_OPTIONS, state.template);
  populateSelect(elements.symmetrySelect, SYMMETRY_OPTIONS, state.symmetry);
  populateSelect(
    elements.shapeSelect,
    BASE_SHAPES.map((shape) => shape.name),
    getSelectedShape().name,
  );
  elements.widthInput.value = String(state.width);
  elements.heightInput.value = String(state.height);
  elements.hardSymmetryToggle.checked = state.hardSymmetry;

  bindEvents();
  renderShapeCards();
  enforceSymmetryConstraints();
  applyTemplate(state.template);
  clearResult();
  loadBackendStatus();
  updateSolveAdvice();
}

function bindEvents() {
  elements.templateSelect.addEventListener("change", (event) => {
    state.template = event.target.value;
    enforceSymmetryConstraints();
    applyTemplate(state.template);
    clearResult();
    updateSolveAdvice();
  });

  elements.symmetrySelect.addEventListener("change", (event) => {
    state.symmetry = event.target.value;
    enforceSymmetryConstraints();
    clearResult();
    updateSolveAdvice();
  });

  elements.widthInput.addEventListener("change", (event) => {
    state.width = clampNumber(Number(event.target.value), 5, 31, 15);
    event.target.value = String(state.width);
    enforceSymmetryConstraints();
    applyTemplate(state.template);
    clearResult();
    updateSolveAdvice();
  });

  elements.heightInput.addEventListener("change", (event) => {
    state.height = clampNumber(Number(event.target.value), 5, 31, 15);
    event.target.value = String(state.height);
    enforceSymmetryConstraints();
    applyTemplate(state.template);
    clearResult();
    updateSolveAdvice();
  });

  elements.hardSymmetryToggle.addEventListener("change", (event) => {
    state.hardSymmetry = event.target.checked;
    clearResult();
  });

  elements.shapeSelect.addEventListener("change", (event) => {
    const nextShape = BASE_SHAPES.find((shape) => shape.name === event.target.value) ?? BASE_SHAPES[0];
    state.selectedShapeId = nextShape.id;
    enforceSymmetryConstraints();
    renderShapeCards();
    clearResult();
    updateSolveAdvice();
  });

  elements.solveButton.addEventListener("click", runSolve);
  elements.randomizeButton.addEventListener("click", runSolve);
  elements.downloadButton.addEventListener("click", downloadResult);
  elements.resetResultButton.addEventListener("click", clearResult);
  elements.resetBoardButton.addEventListener("click", () => {
    applyTemplate(state.template);
    clearResult();
  });
}

function populateSelect(select, options, selected) {
  select.innerHTML = "";
  for (const option of options) {
    const item = document.createElement("option");
    item.value = option;
    item.textContent = option;
    item.selected = option === selected;
    select.append(item);
  }
}

function renderShapeCards() {
  elements.shapeList.innerHTML = "";
  const shape = getSelectedShape();
  elements.shapeSelect.value = shape.name;

  const card = document.createElement("article");
  card.className = "shape-card";

  const header = document.createElement("header");
  const titleBlock = document.createElement("div");
  const title = document.createElement("h4");
  title.textContent = shape.name;
  const desc = document.createElement("p");
  desc.textContent = shape.rotatable ? "Supports rotational search" : "Single orientation";
  titleBlock.append(title, desc);

  header.append(titleBlock);

  const preview = createShapePreview(shape.matrix);
  card.append(header, preview);
  elements.shapeList.append(card);
}

function createShapePreview(matrix) {
  const preview = document.createElement("div");
  preview.className = "shape-preview";
  preview.style.gridTemplateColumns = `repeat(${matrix[0].length}, 18px)`;

  for (const row of matrix) {
    for (const token of row) {
      const cell = document.createElement("div");
      cell.className = "shape-preview-cell";
      if (!token) {
        cell.style.opacity = "0.14";
        cell.style.background = "var(--cell-empty)";
      } else {
        cell.style.background = getTokenColor(token);
      }
      preview.append(cell);
    }
  }

  return preview;
}

function applyTemplate(template) {
  state.blockedCells = generateBlockedPattern(template, state.width, state.height);
  renderEditorGrid();
  renderResultGrid();
  renderSummary();
  updateBoardInfo();
}

function getEnabledShapeNames() {
  return [getSelectedShape().name];
}

function getSelectedShape() {
  return BASE_SHAPES.find((shape) => shape.id === state.selectedShapeId) ?? BASE_SHAPES[0];
}

function enforceSymmetryConstraints() {
  elements.symmetrySelect.disabled = false;
}

function clearResult() {
  cancelSolve();
  state.resultMap = new Map();
  state.lastSolve = null;
  elements.searchTimer.textContent = "0 ms";
  updateMetrics("Ready");
  renderResultGrid();
  renderSummary();
}

async function loadBackendStatus() {
  try {
    const response = await fetch("/api/status");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Failed to load backend status.");
    }

    state.backendStatus = payload.available ? "CryptoMiniSat" : "JS fallback";
    const revisionSuffix = payload.revision ? ` (${payload.revision})` : "";
    if (payload.activeSolve) {
      const shapeLabel = payload.activeSolve.shapeNames?.join(", ") || "unknown";
      const routeLabel = payload.activeSolve.expectedRoute || "unknown";
      elements.backendInfo.textContent =
        `Backend: ${payload.detail}${revisionSuffix} | Active solve: ${payload.activeSolve.width}x${payload.activeSolve.height} ${shapeLabel}, ${payload.activeSolve.symmetry}, route ${routeLabel}`;
    } else if (payload.lastSolve?.solverRoute) {
      elements.backendInfo.textContent =
        `Backend: ${payload.detail}${revisionSuffix} | Last solve: route ${payload.lastSolve.solverRoute}`;
    } else {
      elements.backendInfo.textContent = `Backend: ${payload.detail}${revisionSuffix}`;
    }
    if (!state.lastSolve) {
      elements.statusMetric.textContent = "Ready";
    }
  } catch (error) {
    state.backendStatus = "Status unavailable";
    elements.backendInfo.textContent =
      error instanceof Error ? `Backend: ${error.message}` : "Backend: status unavailable";
  }
}

function cancelSolve() {
  state.solverToken += 1;
  if (currentSolveController) {
    currentSolveController.abort();
    currentSolveController = null;
  }
  stopStatusPolling();
}

function renderEditorGrid() {
  configureBoard(elements.editorGrid, state.width);
  elements.editorGrid.innerHTML = "";

  for (let row = 0; row < state.height; row += 1) {
    for (let col = 0; col < state.width; col += 1) {
      const key = cellKey(row, col);
      const cell = renderCell(state.blockedCells.has(key) ? "blocked" : "empty", true);
      cell.addEventListener("click", () => {
        if (state.blockedCells.has(key)) {
          state.blockedCells.delete(key);
        } else {
          state.blockedCells.add(key);
        }
        renderEditorGrid();
        updateBoardInfo();
        clearResult();
      });
      elements.editorGrid.append(cell);
    }
  }
}

function renderResultGrid() {
  configureBoard(elements.resultGrid, state.width);
  elements.resultGrid.innerHTML = "";

  for (let row = 0; row < state.height; row += 1) {
    for (let col = 0; col < state.width; col += 1) {
      const key = cellKey(row, col);
      let token = "empty";
      if (state.resultMap.has(key)) {
        token = state.resultMap.get(key);
      } else if (state.blockedCells.has(key)) {
        token = "blocked";
      }

      elements.resultGrid.append(renderCell(token, false));
    }
  }
}

function renderCell(token, isEditor) {
  const meta = CELL_META[token];
  const cell = document.createElement("div");
  cell.className = `grid-cell ${meta.className}${isEditor ? " editor" : ""}`;
  cell.textContent = meta.label;
  return cell;
}

function configureBoard(board, width) {
  board.style.gridTemplateColumns = `repeat(${width}, 26px)`;
}

async function runSolve() {
  enforceSymmetryConstraints();
  const enabledShapes = [getSelectedShape()];

  cancelSolve();
  const token = state.solverToken;
  const controller = new AbortController();
  currentSolveController = controller;
  setBusy(true, "Searching");
  elements.resultSummary.textContent = "Solving on local service...";
  elements.searchTimer.textContent = "0 ms";
  startStatusPolling();

  try {
    const response = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        solveQuality: SOLVE_TIMEOUT_LABEL,
        width: state.width,
        height: state.height,
        template: state.template,
        symmetry: state.symmetry,
        hardSymmetry: state.hardSymmetry,
        blockedCells: [...state.blockedCells],
        enabledShapes: enabledShapes.map((shape) => ({
          id: shape.id,
          name: shape.name,
          rotatable: shape.rotatable,
          matrix: shape.matrix,
        })),
      }),
    });

    if (token !== state.solverToken) {
      return;
    }

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Solve request failed.");
    }

    state.resultMap = new Map(payload.grid.map(({ key, token: cellToken }) => [key, cellToken]));
    state.lastSolve = payload;
    renderResultGrid();
    renderSummary(payload);
    elements.backendInfo.textContent = formatBackendInfo(payload);
    setBusy(false, payload.fillCells > 0 ? "Solved" : "No result");
    currentSolveController = null;
    stopStatusPolling();
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    elements.resultSummary.textContent =
      error instanceof Error ? error.message : "The local solver request failed.";
    setBusy(false, "Error");
    currentSolveController = null;
    stopStatusPolling();
  }
}

function greedyPass(bundles, freeCellCount, cellToBundles) {
  const occupied = new Map();
  const skipped = new Set();
  const selected = [];
  const shapeCounts = {};
  const orderedBundles = [...bundles];
  shuffleInPlace(orderedBundles);

  while (true) {
    const targetInfo = findNextTargetCell(occupied, skipped, cellToBundles);
    const target = targetInfo?.key ?? null;
    if (!target) {
      break;
    }

    const fittingBundles = targetInfo.fittingBundles;
    let bestBundle = null;
    let bestScore = -Infinity;

    for (const bundle of fittingBundles.length ? fittingBundles : orderedBundles) {
      if (selected.includes(bundle.id)) {
        continue;
      }

      const evalResult = evaluateBundle(bundle, occupied, skipped);
      if (!evalResult.fits || evalResult.newCells === 0) {
        continue;
      }

      const randomJitter = Math.random() * 0.45;
      const score =
        evalResult.newCells * 10 +
        bundle.members.length * 1.6 +
        bundle.coverage.size * 0.5 +
        randomJitter;

      if (score > bestScore) {
        bestScore = score;
        bestBundle = { bundle, evalResult };
      }
    }

    if (!bestBundle) {
      skipped.add(target);
      continue;
    }

    applyBundle(bestBundle.bundle, occupied);
    selected.push(bestBundle.bundle.id);
    shapeCounts[bestBundle.bundle.shapeName] = (shapeCounts[bestBundle.bundle.shapeName] ?? 0) + 1;

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

function applyBundle(bundle, occupied) {
  for (const member of bundle.members) {
    for (const cell of member.cells) {
      if (!occupied.has(cell.key)) {
        occupied.set(cell.key, cell.token);
      }
    }
  }
}

function searchBestLayout({ bundles, cellToBundles, freeCellCount, deadline, token, initialBest }) {
  const occupied = new Map();
  const skipped = new Set();
  const selected = [];
  const shapeCounts = {};
  let visitedStates = 0;
  let best = cloneCandidate(initialBest);

  const search = () => {
    if (performance.now() >= deadline || token !== state.solverToken) {
      return;
    }

    visitedStates += 1;

    const upperBound = freeCellCount - skipped.size;
    if (upperBound <= best.score) {
      return;
    }

    if (occupied.size > best.score) {
      best = snapshotCandidate(occupied, selected, shapeCounts);
      if (best.score === freeCellCount) {
        return;
      }
    }

    const targetInfo = findNextTargetCell(occupied, skipped, cellToBundles);
    if (!targetInfo) {
      return;
    }

    if (targetInfo.fittingBundles.length === 0) {
      skipped.add(targetInfo.key);
      search();
      skipped.delete(targetInfo.key);
      return;
    }

    const rankedBundles = [...targetInfo.fittingBundles].sort((left, right) => {
      const leftGain = evaluateBundle(left, occupied, skipped).newCells;
      const rightGain = evaluateBundle(right, occupied, skipped).newCells;
      return rightGain - leftGain || right.coverage.size - left.coverage.size;
    });

    for (const bundle of rankedBundles) {
      if (performance.now() >= deadline || token !== state.solverToken) {
        return;
      }

      const appliedKeys = applyBundleTracked(bundle, occupied);
      selected.push(bundle.id);
      shapeCounts[bundle.shapeName] = (shapeCounts[bundle.shapeName] ?? 0) + 1;

      search();

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
    search();
    skipped.delete(targetInfo.key);
  };

  search();

  return { best, visitedStates };
}

function findNextTargetCell(occupied, skipped, cellToBundles) {
  let best = null;

  for (let row = 0; row < state.height; row += 1) {
    for (let col = 0; col < state.width; col += 1) {
      const key = cellKey(row, col);
      if (state.blockedCells.has(key) || occupied.has(key) || skipped.has(key)) {
        continue;
      }

      const fittingBundles = (cellToBundles.get(key) ?? []).filter(
        (bundle) => evaluateBundle(bundle, occupied, skipped).fits,
      );
      const candidateCount = fittingBundles.length;
      const distance =
        Math.abs(row - (state.height - 1) / 2) + Math.abs(col - (state.width - 1) / 2);

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

function snapshotCandidate(occupied, selected, shapeCounts) {
  return {
    score: occupied.size,
    occupied: new Map(occupied),
    selected: [...selected],
    shapeCounts: { ...shapeCounts },
  };
}

function cloneCandidate(candidate) {
  return {
    score: candidate.score,
    occupied: new Map(candidate.occupied),
    selected: [...candidate.selected],
    shapeCounts: { ...candidate.shapeCounts },
  };
}

function generateCandidateBundles(enabledShapes) {
  const bundles = [];
  const seen = new Set();
  let bundleIndex = 0;

  for (const shape of enabledShapes) {
    const rotations = getShapeRotations(shape);

    for (const rotation of rotations) {
      const maxRow = state.height - rotation.height;
      const maxCol = state.width - rotation.width;

      for (let row = 0; row <= maxRow; row += 1) {
        for (let col = 0; col <= maxCol; col += 1) {
          const basePlacement = buildPlacement(rotation, row, col);
          if (!placementFitsTemplate(basePlacement)) {
            continue;
          }

          const bundle = buildSymmetryBundle(basePlacement, shape.name);
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
        }
      }
    }
  }

  return bundles.sort((a, b) => b.coverage.size - a.coverage.size);
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

function placementFitsTemplate(placement) {
  for (const cell of placement.cells) {
    if (
      cell.row < 0 ||
      cell.col < 0 ||
      cell.row >= state.height ||
      cell.col >= state.width ||
      state.blockedCells.has(cell.key)
    ) {
      return false;
    }
  }

  return true;
}

function buildSymmetryBundle(basePlacement, shapeName) {
  const operations = getSymmetryOperations(state.symmetry);
  const members = [];
  const seenMembers = new Set();

  for (const operation of operations) {
    const transformed = transformPlacement(basePlacement, operation);
    if (!transformed || !placementFitsTemplate(transformed)) {
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

function transformPlacement(placement, operation) {
  const transformedCells = [];

  for (const cell of placement.cells) {
    const transformedCoord = transformCoordinate(cell.row, cell.col, operation);
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

function transformCoordinate(row, col, operation) {
  switch (operation) {
    case "identity":
      return { row, col };
    case "rot90":
      return { row: col, col: state.width - 1 - row };
    case "rot180":
      return { row: state.height - 1 - row, col: state.width - 1 - col };
    case "rot270":
      return { row: state.height - 1 - col, col: row };
    case "reflectH":
      return { row: state.height - 1 - row, col };
    case "reflectV":
      return { row, col: state.width - 1 - col };
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
    case "None":
    default:
      return ["identity"];
  }
}

function buildSolvePayload(best, bundles, durationMs, passes) {
  const totalFree = state.width * state.height - state.blockedCells.size;
  const fillRatio = totalFree === 0 ? 0 : best.score / totalFree;
  const selectedBundles = bundles.filter((bundle) => best.selected.includes(bundle.id));

  return {
    width: state.width,
    height: state.height,
    template: state.template,
    symmetry: state.symmetry,
    hardSymmetry: state.hardSymmetry,
    blockedCells: [...state.blockedCells],
    fillCells: best.score,
    totalFreeCells: totalFree,
    fillRatio,
    durationMs,
    passes,
    shapeCounts: best.shapeCounts,
    selectedBundles: selectedBundles.map((bundle) => ({
      id: bundle.id,
      shape: bundle.shapeName,
      members: bundle.members.map((member) =>
        member.cells.map((cell) => ({ row: cell.row, col: cell.col, token: cell.token })),
      ),
    })),
    grid: [...best.occupied.entries()].map(([key, token]) => ({ key, token })),
  };
}

function renderSummary(payload = state.lastSolve) {
  elements.summaryContent.innerHTML = "";
  updateBoardInfo(payload?.solveRequest ?? null);

  if (!payload) {
    elements.resultSummary.textContent = "No solve has been run yet.";
    addSummaryBlock("Current layout", [
      `Blocked cells: ${state.blockedCells.size}`,
      `Grid: ${state.width} × ${state.height}`,
      `Symmetry: ${state.symmetry}`,
    ]);
    return;
  }

  const fillPercent = `${Math.round(payload.fillRatio * 100)}%`;
  elements.resultSummary.textContent = `Filled ${payload.fillCells} of ${payload.totalFreeCells} open cells across ${payload.passes} search passes.`;
  elements.searchTimer.textContent = `${Math.round(payload.durationMs)} ms`;
  elements.fillMetric.textContent = fillPercent;
  elements.shapeMetric.textContent = String(
    Object.values(payload.shapeCounts).reduce((sum, count) => sum + count, 0),
  );

  addSummaryBlock("Result", [
    `Fill ratio: ${fillPercent}`,
    `Open cells: ${payload.totalFreeCells}`,
    `Search passes: ${payload.passes}`,
  ]);

  addSummaryBlock(
    "Shape usage",
    Object.entries(payload.shapeCounts).length
      ? Object.entries(payload.shapeCounts).map(([name, count]) => `${name}: ${count}`)
      : ["No shapes placed"],
  );

  addSummaryBlock("Settings", [
    `Template: ${payload.template}`,
    `Symmetry: ${payload.symmetry}`,
    `Hard symmetry: ${payload.hardSymmetry ? "On" : "Off"}`,
  ]);

  if (payload.solveRequest) {
    addSummaryBlock("Solve request", [
      `Grid: ${payload.solveRequest.width} × ${payload.solveRequest.height} (${payload.solveRequest.gridArea} cells)`,
      `Blocked cells sent: ${payload.solveRequest.blockedCount}`,
      `Open cells sent: ${payload.solveRequest.openCount}`,
      `Template baseline blocked: ${payload.solveRequest.templateBlockedCount}`,
      `Manual edits vs template: ${payload.solveRequest.manualEditDelta}`,
      `Shapes: ${payload.solveRequest.enabledShapes.join(", ") || "None"}`,
      `Quality: ${payload.solveRequest.quality}`,
    ]);
  }

  addSummaryBlock("Solver", [
    `Backend used: ${payload.solverBackend || state.backendStatus}`,
    `Route: ${payload.solverRoute || "unknown"}`,
    ...buildSolverSummaryLines(payload),
  ]);
}

function updateBoardInfo(solveRequest = null) {
  if (solveRequest) {
    elements.boardInfo.textContent =
      solveRequest.manualEditDelta === 0
        ? `Board: matches ${solveRequest.template}`
        : `Board: ${solveRequest.manualEditDelta} manual edits from ${solveRequest.template}`;
    return;
  }

  const baselineBlocked = generateBlockedPattern(state.template, state.width, state.height);
  const baselineSet = new Set(baselineBlocked);
  let manualEditDelta = 0;

  for (const key of state.blockedCells) {
    if (!baselineSet.has(key)) {
      manualEditDelta += 1;
    }
  }
  for (const key of baselineSet) {
    if (!state.blockedCells.has(key)) {
      manualEditDelta += 1;
    }
  }

  elements.boardInfo.textContent =
    manualEditDelta === 0
      ? `Board: matches ${state.template}`
      : `Board: ${manualEditDelta} manual edits from ${state.template}`;
}

function updateSolveAdvice() {
  const isLargeCircle =
    state.template !== "None" && Math.min(state.width, state.height) >= 19;
  const isFastRecommendedMode = state.symmetry === "Rotational (90°)";
  const enabledShapeNames = getEnabledShapeNames();
  const threeClipOnly = enabledShapeNames.length === 1 && enabledShapeNames[0] === "3-Clip";

  if (!isLargeCircle) {
    elements.solveAdvice.hidden = true;
    elements.solveAdvice.textContent = "";
    return;
  }

  elements.solveAdvice.hidden = false;
  if (threeClipOnly) {
    elements.solveAdvice.textContent =
      isFastRecommendedMode
        ? "3-Clip can use Rotational (90°), but large circles now usually solve faster and denser with no symmetry."
        : "3-Clip on large circles now usually solves faster and denser with no symmetry than with forced Rotational (90°).";
    return;
  }
  elements.solveAdvice.textContent = isFastRecommendedMode
    ? "4-Clip on large circles often solves quickly with Rotational (90°), but it is no longer forced."
    : "4-Clip on large circles can still benefit from Rotational (90°), but you can now choose asymmetrical solves when they make more sense.";
}

function startStatusPolling() {
  stopStatusPolling();
  currentStatusPollTimer = setInterval(() => {
    loadBackendStatus();
  }, 1000);
}

function stopStatusPolling() {
  if (currentStatusPollTimer) {
    clearInterval(currentStatusPollTimer);
    currentStatusPollTimer = null;
  }
}

function buildSolverSummaryLines(payload) {
  if (!payload?.solverNote) {
    return ["No fallback triggered"];
  }

  if (payload.solverBackend === "js-fallback") {
    return [`Fallback: ${payload.solverNote}`];
  }

  return [payload.solverNote];
}

function formatBackendInfo(payload) {
  const revisionSuffix = payload?.serverRevision ? ` [${payload.serverRevision}]` : "";
  if (!payload) {
    return `Backend: ${state.backendStatus}${revisionSuffix}`;
  }

  if (payload.solverBackend === "js-fallback" && payload.solverNote) {
    const timedOut = payload.solverNote.toLowerCase().includes("timed out");
    return timedOut
      ? `Backend: JS fallback after CryptoMiniSat timed out${revisionSuffix}`
      : `Backend: JS fallback after CryptoMiniSat failed${revisionSuffix}`;
  }

  if (payload.solverNote) {
    return `Backend: ${payload.solverBackend} (${payload.solverNote})${revisionSuffix}`;
  }

  return `Backend: ${payload.solverBackend}${revisionSuffix}`;
}

function addSummaryBlock(title, lines) {
  const block = document.createElement("section");
  block.className = "summary-block";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.className = "summary-list";

  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  }

  block.append(heading, list);
  elements.summaryContent.append(block);
}

function updateMetrics(status) {
  const totalFree = state.width * state.height - state.blockedCells.size;
  const fill = totalFree === 0 ? 0 : Math.round((state.resultMap.size / totalFree) * 100);
  elements.fillMetric.textContent = `${fill}%`;
  elements.shapeMetric.textContent = state.lastSolve
    ? String(Object.values(state.lastSolve.shapeCounts).reduce((sum, count) => sum + count, 0))
    : "0";
  elements.statusMetric.textContent = status;
}

function setBusy(isBusy, status) {
  elements.solveButton.disabled = isBusy;
  elements.randomizeButton.disabled = isBusy;
  updateMetrics(status);
}

function downloadResult() {
  if (!state.lastSolve) {
    elements.statusMetric.textContent = "Nothing to export";
    return;
  }

  const blob = new Blob([JSON.stringify(state.lastSolve, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "aps-optimizer-layout.json";
  link.click();
  URL.revokeObjectURL(url);
}

function generateBlockedPattern(templateName, width, height) {
  return generateTemplateBlockedCells(templateName, width, height);
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

function getTokenColor(token) {
  switch (CELL_META[token].className) {
    case "loader":
      return "var(--cell-loader)";
    case "clip":
      return "var(--cell-clip)";
    case "cooler":
      return "var(--cell-cooler)";
    case "blocked":
      return "var(--cell-blocked)";
    default:
      return "var(--cell-empty)";
  }
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
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
