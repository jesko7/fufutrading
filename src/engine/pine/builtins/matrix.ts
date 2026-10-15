/**
 * Pine Script matrix.* — row-major matrices of numbers (or other values for the structural
 * functions), with the linear algebra TradingView provides: products, powers, determinant,
 * inverse, pseudo-inverse, rank, trace, eigenvalues/-vectors (Jacobi for symmetric matrices, QR
 * iterations otherwise) and Kronecker products. Invalid shapes give na results like
 * TradingView instead of throwing, except where Pine raises a runtime error.
 */

const NA = NaN;

export class PineMatrix {
  constructor(
    public rows: number,
    public cols: number,
    public data: unknown[],
  ) {}

  static filled(rows: number, cols: number, v: unknown): PineMatrix {
    const r = Math.max(0, Math.floor(rows) || 0);
    const c = Math.max(0, Math.floor(cols) || 0);
    return new PineMatrix(r, c, new Array(r * c).fill(v === undefined ? NA : v));
  }

  at(r: number, c: number): unknown {
    return this.data[r * this.cols + c];
  }

  num(r: number, c: number): number {
    const v = this.data[r * this.cols + c];
    return typeof v === 'number' ? v : NA;
  }

  put(r: number, c: number, v: unknown): void {
    this.data[r * this.cols + c] = v;
  }

  rowArray(r: number): unknown[] {
    return this.data.slice(r * this.cols, (r + 1) * this.cols);
  }

  colArray(c: number): unknown[] {
    const out = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) out[r] = this.data[r * this.cols + c];
    return out;
  }

  clone(): PineMatrix {
    return new PineMatrix(this.rows, this.cols, this.data.slice());
  }
}

type M = PineMatrix | null | undefined;

function err(msg: string): never {
  throw new Error(msg);
}

function checkIndex(m: PineMatrix, r: number, c: number): void {
  if (!(r >= 0 && r < m.rows && c >= 0 && c < m.cols)) err(`matrix index (${r}, ${c}) is out of bounds for a ${m.rows}×${m.cols} matrix`);
}

const numbers = (m: PineMatrix) => m.data.filter((v): v is number => typeof v === 'number' && v === v);

// ---------------------------------------------------------------- numeric helpers

function toRows(m: PineMatrix): number[][] {
  const a: number[][] = [];
  for (let r = 0; r < m.rows; r++) {
    const row: number[] = new Array(m.cols);
    for (let c = 0; c < m.cols; c++) row[c] = m.num(r, c);
    a.push(row);
  }
  return a;
}

function fromRows(a: number[][], cols?: number): PineMatrix {
  const rows = a.length;
  const c = cols ?? (rows ? a[0].length : 0);
  const out = PineMatrix.filled(rows, c, NA);
  for (let r = 0; r < rows; r++) for (let k = 0; k < c; k++) out.put(r, k, a[r][k]);
  return out;
}

function product(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const k = b.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m).fill(0);
    for (let t = 0; t < k; t++) {
      const v = a[i][t];
      if (v === 0) continue;
      for (let j = 0; j < m; j++) row[j] += v * b[t][j];
    }
    out.push(row);
  }
  return out;
}

function transposeRows(a: number[][]): number[][] {
  const r = a.length;
  const c = r ? a[0].length : 0;
  const out: number[][] = [];
  for (let j = 0; j < c; j++) {
    const row = new Array(r);
    for (let i = 0; i < r; i++) row[i] = a[i][j];
    out.push(row);
  }
  return out;
}

/** LU decomposition with partial pivoting: returns the determinant and the inverse (null if singular). */
function luInverse(a0: number[][]): { det: number; inv: number[][] | null } {
  const n = a0.length;
  const a = a0.map((r) => r.slice());
  const inv: number[][] = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
  let det = 1;
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[p][col])) p = r;
    if (!(Math.abs(a[p][col]) > 1e-14)) return { det: 0, inv: null };
    if (p !== col) {
      [a[p], a[col]] = [a[col], a[p]];
      [inv[p], inv[col]] = [inv[col], inv[p]];
      det = -det;
    }
    const piv = a[col][col];
    det *= piv;
    for (let j = 0; j < n; j++) {
      a[col][j] /= piv;
      inv[col][j] /= piv;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) {
        a[r][j] -= f * a[col][j];
        inv[r][j] -= f * inv[col][j];
      }
    }
  }
  return { det, inv };
}

function rankOf(a0: number[][]): number {
  const a = a0.map((r) => r.slice());
  const rows = a.length;
  const cols = rows ? a[0].length : 0;
  let rank = 0;
  const tol = 1e-10 * Math.max(1, ...a.flat().map(Math.abs));
  for (let c = 0; c < cols && rank < rows; c++) {
    let p = rank;
    for (let r = rank + 1; r < rows; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) <= tol) continue;
    [a[p], a[rank]] = [a[rank], a[p]];
    for (let r = rank + 1; r < rows; r++) {
      const f = a[r][c] / a[rank][c];
      for (let j = c; j < cols; j++) a[r][j] -= f * a[rank][j];
    }
    rank++;
  }
  return rank;
}

/** Jacobi eigen decomposition of a symmetric matrix: eigenvalues (descending) and eigenvectors as columns. */
function jacobi(a0: number[][]): { values: number[]; vectors: number[][] } {
  const n = a0.length;
  const a = a0.map((r) => r.slice());
  const v: number[][] = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = a.map((_, i) => i).sort((x, y) => a[y][y] - a[x][x]);
  return { values: order.map((i) => a[i][i]), vectors: v.map((row) => order.map((i) => row[i])) };
}

/** Eigenvalues of a general real matrix by shifted QR iterations (real parts; complex pairs give their real part). */
function qrEigenvalues(a0: number[][]): number[] {
  const n = a0.length;
  let a = a0.map((r) => r.slice());
  for (let it = 0; it < 500 * n; it++) {
    const mu = a[n - 1][n - 1];
    for (let i = 0; i < n; i++) a[i][i] -= mu;
    // Gram–Schmidt QR
    const q: number[][] = a.map(() => new Array(n).fill(0));
    const r: number[][] = a.map(() => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const v = a.map((row) => row[j]);
      for (let k = 0; k < j; k++) {
        let d = 0;
        for (let i = 0; i < n; i++) d += q[i][k] * a[i][j];
        r[k][j] = d;
        for (let i = 0; i < n; i++) v[i] -= d * q[i][k];
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      r[j][j] = norm;
      for (let i = 0; i < n; i++) q[i][j] = norm > 1e-300 ? v[i] / norm : 0;
    }
    a = product(r, q);
    for (let i = 0; i < n; i++) a[i][i] += mu;
    let sub = 0;
    for (let i = 1; i < n; i++) sub += Math.abs(a[i][i - 1]);
    if (sub < 1e-12) break;
  }
  return a.map((row, i) => row[i]).sort((x, y) => y - x);
}

function isSymmetric(a: number[][], tol = 1e-12): boolean {
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) if (Math.abs(a[i][j] - a[j][i]) > tol * Math.max(1, Math.abs(a[i][j]))) return false;
  return true;
}

// ---------------------------------------------------------------- matrix.*

const sortedNums = (m: PineMatrix) => numbers(m).sort((a, b) => a - b);

export const matrix = {
  new: (rows = 0, cols = 0, initial?: unknown) => PineMatrix.filled(rows, cols, initial),
  get: (m: M, r: number, c: number) => {
    if (!m) return NA;
    checkIndex(m, r, c);
    return m.at(r, c);
  },
  set: (m: M, r: number, c: number, v: unknown) => {
    if (!m) return;
    checkIndex(m, r, c);
    m.put(r, c, v);
  },
  rows: (m: M) => (m ? m.rows : NA),
  columns: (m: M) => (m ? m.cols : NA),
  elements_count: (m: M) => (m ? m.rows * m.cols : NA),
  row: (m: M, r: number) => (m && r >= 0 && r < m.rows ? m.rowArray(r) : []),
  col: (m: M, c: number) => (m && c >= 0 && c < m.cols ? m.colArray(c) : []),
  add_row: (m: M, r?: number, arr?: unknown[]) => {
    if (!m) return;
    const at = r === undefined || r !== r ? m.rows : r;
    if (m.rows === 0 && m.cols === 0 && arr) m.cols = arr.length;
    const row = arr ? arr.slice(0, m.cols) : new Array(m.cols).fill(NA);
    if (row.length !== m.cols) err(`matrix.add_row: the array has ${row.length} elements, the matrix ${m.cols} columns`);
    m.data.splice(at * m.cols, 0, ...row);
    m.rows++;
  },
  add_col: (m: M, c?: number, arr?: unknown[]) => {
    if (!m) return;
    const at = c === undefined || c !== c ? m.cols : c;
    if (m.rows === 0 && m.cols === 0 && arr) m.rows = arr.length;
    const col = arr ? arr.slice(0, m.rows) : new Array(m.rows).fill(NA);
    if (col.length !== m.rows) err(`matrix.add_col: the array has ${col.length} elements, the matrix ${m.rows} rows`);
    const data: unknown[] = [];
    for (let r = 0; r < m.rows; r++) {
      const row = m.rowArray(r);
      row.splice(at, 0, col[r]);
      data.push(...row);
    }
    m.cols++;
    m.data = data;
  },
  remove_row: (m: M, r?: number) => {
    if (!m || !m.rows) return [];
    const at = r === undefined || r !== r ? m.rows - 1 : r;
    const out = m.data.splice(at * m.cols, m.cols);
    m.rows--;
    return out;
  },
  remove_col: (m: M, c?: number) => {
    if (!m || !m.cols) return [];
    const at = c === undefined || c !== c ? m.cols - 1 : c;
    const out: unknown[] = [];
    const data: unknown[] = [];
    for (let r = 0; r < m.rows; r++) {
      const row = m.rowArray(r);
      out.push(row.splice(at, 1)[0]);
      data.push(...row);
    }
    m.cols--;
    m.data = data;
    return out;
  },
  fill: (m: M, v: unknown, fromRow = 0, toRow?: number, fromCol = 0, toCol?: number) => {
    if (!m) return;
    const r1 = toRow === undefined || toRow !== toRow ? m.rows : toRow;
    const c1 = toCol === undefined || toCol !== toCol ? m.cols : toCol;
    for (let r = fromRow; r < r1; r++) for (let c = fromCol; c < c1; c++) m.put(r, c, v);
  },
  copy: (m: M) => (m ? m.clone() : null),
  submatrix: (m: M, fromRow = 0, toRow?: number, fromCol = 0, toCol?: number) => {
    if (!m) return null;
    const r1 = toRow === undefined || toRow !== toRow ? m.rows : toRow;
    const c1 = toCol === undefined || toCol !== toCol ? m.cols : toCol;
    const out = PineMatrix.filled(r1 - fromRow, c1 - fromCol, NA);
    for (let r = fromRow; r < r1; r++) for (let c = fromCol; c < c1; c++) out.put(r - fromRow, c - fromCol, m.at(r, c));
    return out;
  },
  reshape: (m: M, rows: number, cols: number) => {
    if (!m) return;
    if (rows * cols !== m.rows * m.cols) err(`matrix.reshape: ${m.rows}×${m.cols} can't become ${rows}×${cols}`);
    m.rows = rows;
    m.cols = cols;
  },
  reverse: (m: M) => {
    if (m) m.data.reverse();
  },
  swap_rows: (m: M, a: number, b: number) => {
    if (!m) return;
    for (let c = 0; c < m.cols; c++) {
      const t = m.at(a, c);
      m.put(a, c, m.at(b, c));
      m.put(b, c, t);
    }
  },
  swap_columns: (m: M, a: number, b: number) => {
    if (!m) return;
    for (let r = 0; r < m.rows; r++) {
      const t = m.at(r, a);
      m.put(r, a, m.at(r, b));
      m.put(r, b, t);
    }
  },
  transpose: (m: M) => {
    if (!m) return null;
    const out = PineMatrix.filled(m.cols, m.rows, NA);
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) out.put(c, r, m.at(r, c));
    return out;
  },
  concat: (a: M, b: M) => {
    if (!a || !b) return a ?? null;
    if (a.cols !== b.cols && a.rows) err('matrix.concat: the matrices need the same number of columns');
    if (!a.rows) a.cols = b.cols;
    a.data.push(...b.data);
    a.rows += b.rows;
    return a;
  },
  sum: (a: M, b: M | number) => {
    if (!a) return null;
    const out = a.clone();
    if (b instanceof PineMatrix) {
      if (b.rows !== a.rows || b.cols !== a.cols) err('matrix.sum: the matrices need the same size');
      out.data = out.data.map((v, k) => (v as number) + (b.data[k] as number));
    } else out.data = out.data.map((v) => (v as number) + (b as number));
    return out;
  },
  diff: (a: M, b: M | number) => {
    if (!a) return null;
    const out = a.clone();
    if (b instanceof PineMatrix) {
      if (b.rows !== a.rows || b.cols !== a.cols) err('matrix.diff: the matrices need the same size');
      out.data = out.data.map((v, k) => (v as number) - (b.data[k] as number));
    } else out.data = out.data.map((v) => (v as number) - (b as number));
    return out;
  },
  mult: (a: M, b: M | number | number[]) => {
    if (!a) return null;
    if (b instanceof PineMatrix) {
      if (a.cols !== b.rows) err(`matrix.mult: ${a.rows}×${a.cols} times ${b.rows}×${b.cols} is undefined`);
      return fromRows(product(toRows(a), toRows(b)), b.cols);
    }
    if (Array.isArray(b)) {
      if (a.cols !== b.length) err(`matrix.mult: a ${a.rows}×${a.cols} matrix times an array of ${b.length}`);
      return toRows(a).map((row) => row.reduce((s, v, k) => s + v * (b[k] as number), 0));
    }
    const out = a.clone();
    out.data = out.data.map((v) => (v as number) * (b as number));
    return out;
  },
  pow: (m: M, power: number) => {
    if (!m) return null;
    if (m.rows !== m.cols) err('matrix.pow: the matrix must be square');
    let result: number[][] = Array.from({ length: m.rows }, (_, i) => Array.from({ length: m.cols }, (__, j) => (i === j ? 1 : 0)));
    let base = toRows(m);
    let p = Math.floor(power);
    while (p > 0) {
      if (p & 1) result = product(result, base);
      base = product(base, base);
      p >>= 1;
    }
    return fromRows(result, m.cols);
  },
  det: (m: M) => {
    if (!m || m.rows !== m.cols) return NA;
    return luInverse(toRows(m)).det;
  },
  inv: (m: M) => {
    if (!m || m.rows !== m.cols) return null;
    const { inv } = luInverse(toRows(m));
    return inv ? fromRows(inv, m.cols) : PineMatrix.filled(m.rows, m.cols, NA);
  },
  pinv: (m: M) => {
    if (!m) return null;
    const a = toRows(m);
    const at = transposeRows(a);
    // full column rank: (AᵀA)⁻¹Aᵀ, full row rank: Aᵀ(AAᵀ)⁻¹, otherwise a tiny ridge keeps it defined
    if (m.rows >= m.cols) {
      const ata = product(at, a);
      let { inv } = luInverse(ata);
      if (!inv) inv = luInverse(ata.map((r, i) => r.map((v, j) => v + (i === j ? 1e-10 : 0)))).inv;
      return inv ? fromRows(product(inv, at), m.rows) : PineMatrix.filled(m.cols, m.rows, NA);
    }
    const aat = product(a, at);
    let { inv } = luInverse(aat);
    if (!inv) inv = luInverse(aat.map((r, i) => r.map((v, j) => v + (i === j ? 1e-10 : 0)))).inv;
    return inv ? fromRows(product(at, inv), m.rows) : PineMatrix.filled(m.cols, m.rows, NA);
  },
  rank: (m: M) => (m ? rankOf(toRows(m)) : NA),
  trace: (m: M) => {
    if (!m || m.rows !== m.cols) return NA;
    let s = 0;
    for (let i = 0; i < m.rows; i++) s += m.num(i, i);
    return s;
  },
  avg: (m: M) => {
    if (!m) return NA;
    const v = numbers(m);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NA;
  },
  max: (m: M) => (m && numbers(m).length ? Math.max(...numbers(m)) : NA),
  min: (m: M) => (m && numbers(m).length ? Math.min(...numbers(m)) : NA),
  median: (m: M) => {
    if (!m) return NA;
    const s = sortedNums(m);
    if (!s.length) return NA;
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  },
  mode: (m: M) => {
    if (!m) return NA;
    const counts = new Map<number, number>();
    for (const v of numbers(m)) counts.set(v, (counts.get(v) || 0) + 1);
    let best = NA;
    let n = 0;
    for (const [v, k] of counts) if (k > n || (k === n && v < best)) [best, n] = [v, k];
    return best;
  },
  sort: (m: M, column = 0, order = 'ascending') => {
    if (!m) return;
    const rows = Array.from({ length: m.rows }, (_, r) => m.rowArray(r));
    const dir = order === 'descending' ? -1 : 1;
    rows.sort((a, b) => dir * ((a[column] as number) - (b[column] as number)));
    m.data = rows.flat();
  },
  kron: (a: M, b: M) => {
    if (!a || !b) return null;
    const out = PineMatrix.filled(a.rows * b.rows, a.cols * b.cols, NA);
    for (let i = 0; i < a.rows; i++)
      for (let j = 0; j < a.cols; j++)
        for (let k = 0; k < b.rows; k++) for (let l = 0; l < b.cols; l++) out.put(i * b.rows + k, j * b.cols + l, a.num(i, j) * b.num(k, l));
    return out;
  },
  eigenvalues: (m: M) => {
    if (!m || m.rows !== m.cols) return [];
    const a = toRows(m);
    return isSymmetric(a) ? jacobi(a).values : qrEigenvalues(a);
  },
  eigenvectors: (m: M) => {
    if (!m || m.rows !== m.cols) return null;
    const a = toRows(m);
    if (isSymmetric(a)) return fromRows(jacobi(a).vectors, m.cols);
    // general matrices: inverse iteration per eigenvalue
    const n = m.rows;
    const vals = qrEigenvalues(a);
    const cols: number[][] = vals.map((lam) => {
      const shifted = a.map((r, i) => r.map((v, j) => v - (i === j ? lam + 1e-9 : 0)));
      const inv = luInverse(shifted).inv;
      let v = new Array(n).fill(1 / Math.sqrt(n));
      if (inv) for (let it = 0; it < 30; it++) {
        const w = inv.map((row) => row.reduce((s, x, k) => s + x * v[k], 0));
        const norm = Math.sqrt(w.reduce((s, x) => s + x * x, 0)) || 1;
        v = w.map((x) => x / norm);
      }
      return v;
    });
    return fromRows(Array.from({ length: n }, (_, i) => cols.map((c) => c[i])), n);
  },
  is_square: (m: M) => !!m && m.rows === m.cols,
  is_zero: (m: M) => !!m && m.data.every((v) => v === 0),
  is_binary: (m: M) => !!m && m.data.every((v) => v === 0 || v === 1),
  is_identity: (m: M) => !!m && m.rows === m.cols && m.data.every((v, k) => v === (Math.floor(k / m.cols) === k % m.cols ? 1 : 0)),
  is_diagonal: (m: M) => !!m && m.rows === m.cols && m.data.every((v, k) => Math.floor(k / m.cols) === k % m.cols || v === 0),
  is_antidiagonal: (m: M) => !!m && m.rows === m.cols && m.data.every((v, k) => Math.floor(k / m.cols) + (k % m.cols) === m.cols - 1 || v === 0),
  is_symmetric: (m: M) => !!m && m.rows === m.cols && isSymmetric(toRows(m), 0),
  is_antisymmetric: (m: M) => {
    if (!m || m.rows !== m.cols) return false;
    for (let i = 0; i < m.rows; i++) for (let j = 0; j < m.cols; j++) if (m.num(i, j) !== -m.num(j, i)) return false;
    return true;
  },
  is_triangular: (m: M) => {
    if (!m || m.rows !== m.cols) return false;
    let upper = true;
    let lower = true;
    for (let i = 0; i < m.rows; i++)
      for (let j = 0; j < m.cols; j++) {
        if (i > j && m.num(i, j) !== 0) upper = false;
        if (i < j && m.num(i, j) !== 0) lower = false;
      }
    return upper || lower;
  },
  is_stochastic: (m: M) => {
    if (!m || !m.rows) return false;
    for (let r = 0; r < m.rows; r++) {
      let s = 0;
      for (let c = 0; c < m.cols; c++) {
        const v = m.num(r, c);
        if (!(v >= 0)) return false;
        s += v;
      }
      if (Math.abs(s - 1) > 1e-9) return false;
    }
    return true;
  },
};

/** Parameter names of matrix.* (TradingView's), for named arguments. */
export const MATRIX_PARAMS: Record<string, string> = {
  new: 'rows,columns,initial_value',
  get: 'id,row,column',
  set: 'id,row,column,value',
  rows: 'id',
  columns: 'id',
  elements_count: 'id',
  row: 'id,row',
  col: 'id,column',
  add_row: 'id,row,array_id',
  add_col: 'id,column,array_id',
  remove_row: 'id,row',
  remove_col: 'id,column',
  fill: 'id,value,from_row,to_row,from_column,to_column',
  copy: 'id',
  submatrix: 'id,from_row,to_row,from_column,to_column',
  reshape: 'id,rows,columns',
  reverse: 'id',
  swap_rows: 'id,row1,row2',
  swap_columns: 'id,column1,column2',
  transpose: 'id',
  concat: 'id1,id2',
  sum: 'id1,id2',
  diff: 'id1,id2',
  mult: 'id1,id2',
  pow: 'id,power',
  det: 'id',
  inv: 'id',
  pinv: 'id',
  rank: 'id',
  trace: 'id',
  avg: 'id',
  max: 'id',
  min: 'id',
  median: 'id',
  mode: 'id',
  sort: 'id,column,order',
  kron: 'id1,id2',
  eigenvalues: 'id',
  eigenvectors: 'id',
  is_square: 'id',
  is_zero: 'id',
  is_binary: 'id',
  is_identity: 'id',
  is_diagonal: 'id',
  is_antidiagonal: 'id',
  is_symmetric: 'id',
  is_antisymmetric: 'id',
  is_triangular: 'id',
  is_stochastic: 'id',
};
