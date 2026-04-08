export function generateTemplateBlockedCells(templateName, width, height) {
  const blocked = new Set();

  if (templateName === "None") {
    return blocked;
  }

  const filledCircle = buildFilledRasterCircle(width, height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const key = cellKey(row, col);
      if (!filledCircle.has(key)) {
        blocked.add(key);
      }
    }
  }

  if (templateName === "Circle (Center Hole)" && width % 2 === 1 && height % 2 === 1) {
    blocked.add(cellKey((height - 1) / 2, (width - 1) / 2));
  }

  return blocked;
}

function buildFilledRasterCircle(width, height) {
  const filled = new Set();
  const centerRow = (height - 1) / 2;
  const centerCol = (width - 1) / 2;
  const radius = Math.min(width, height) / 2;

  for (let row = 0; row < height; row += 1) {
    const y = Math.abs(row - centerRow);
    const span = Math.floor(Math.sqrt(radius * radius - y * y) - 1e-9);
    const start = Math.max(0, Math.ceil(centerCol - span));
    const end = Math.min(width - 1, Math.floor(centerCol + span));
    for (let col = start; col <= end; col += 1) {
      filled.add(cellKey(row, col));
    }
  }

  return filled;
}

function cellKey(row, col) {
  return `${row},${col}`;
}
