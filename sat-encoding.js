export function buildDimacs(clauses, variableCount) {
  const header = `p cnf ${variableCount} ${clauses.length}`;
  const body = clauses.map((clause) => `${clause.join(" ")} 0`).join("\n");
  return `${header}\n${body}\n`;
}

export function encodeAtLeastK(variables, k, nextVarRef) {
  if (k <= 0) {
    return { clauses: [], variableCount: nextVarRef.value - 1 };
  }
  if (k > variables.length) {
    return { clauses: [[1], [-1]], variableCount: nextVarRef.value - 1 };
  }

  return encodeAtMostK(variables.map((variable) => -variable), variables.length - k, nextVarRef);
}

function encodeAtMostK(literals, k, nextVarRef) {
  const n = literals.length;

  if (k < 0) {
    return { clauses: [[1], [-1]], variableCount: nextVarRef.value - 1 };
  }
  if (k >= n || n === 0) {
    return { clauses: [], variableCount: nextVarRef.value - 1 };
  }
  if (k === 0) {
    return {
      clauses: literals.map((literal) => [-literal]),
      variableCount: nextVarRef.value - 1,
    };
  }
  if (n === 1) {
    return { clauses: [], variableCount: nextVarRef.value - 1 };
  }

  const s = Array.from({ length: n - 1 }, () => Array(k).fill(0));
  const clauses = [];

  for (let i = 0; i < n - 1; i += 1) {
    for (let j = 0; j < k; j += 1) {
      s[i][j] = nextVarRef.value;
      nextVarRef.value += 1;
    }
  }

  clauses.push([-literals[0], s[0][0]]);
  for (let j = 1; j < k; j += 1) {
    clauses.push([-s[0][j]]);
  }

  for (let i = 1; i < n - 1; i += 1) {
    clauses.push([-literals[i], s[i][0]]);
    clauses.push([-s[i - 1][0], s[i][0]]);

    for (let j = 1; j < k; j += 1) {
      clauses.push([-literals[i], -s[i - 1][j - 1], s[i][j]]);
      clauses.push([-s[i - 1][j], s[i][j]]);
    }

    clauses.push([-literals[i], -s[i - 1][k - 1]]);
  }

  clauses.push([-literals[n - 1], -s[n - 2][k - 1]]);

  return { clauses, variableCount: nextVarRef.value - 1 };
}
