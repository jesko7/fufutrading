/**
 * Pine Script lexer. Produces tokens with INDENT/DEDENT/NEWLINE for Pine's indentation-based
 * blocks. Line continuation follows Pine (continuation lines are indented by a number of spaces
 * that is not a multiple of 4) and is also accepted inside open brackets and after trailing
 * operators/commas, which covers all common real-world formatting.
 */

export type TokType = 'num' | 'str' | 'color' | 'ident' | 'kw' | 'op' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  type: TokType;
  value: string;
  line: number;
  col: number;
}

export class PineError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
    readonly kind: 'syntax' | 'compile' | 'runtime' | 'unsupported' = 'syntax',
  ) {
    super(message);
  }
}

export const KEYWORDS = new Set(['var', 'varip', 'if', 'else', 'for', 'to', 'by', 'in', 'while', 'switch', 'break', 'continue', 'true', 'false', 'and', 'or', 'not', 'import', 'export', 'type', 'method', 'enum']);

const OPS = ['=>', ':=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '?', ':', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', ',', '.'];

const CONT_END = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '=', ':=', '+=', '-=', '*=', '/=', '%=', '?', ':', ',', '(', '[', 'and', 'or', 'not']);

export interface LexResult {
  tokens: Token[];
  version: number | null;
  annotations: Record<string, string>;
}

export function lex(src: string): LexResult {
  const tokens: Token[] = [];
  let version: number | null = null;
  const annotations: Record<string, string> = {};
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const indents: number[] = [0];
  let depth = 0;
  let prevSignificant: Token | null = null;
  let stmtStarted = false;

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const lineNo = li + 1;
    // annotations
    const ann = /^\s*\/\/\s*@(\w+)\s*(.*)$/.exec(raw);
    if (ann) {
      const [, key, val] = ann;
      if (key === 'version') {
        const m = /=?\s*(\d+)/.exec(val);
        if (m) version = +m[1];
      } else annotations[key] = (annotations[key] ? `${annotations[key]}\n` : '') + val.trim();
      continue;
    }
    // measure indentation
    let i = 0;
    let indent = 0;
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) {
      indent += raw[i] === '\t' ? 4 : 1;
      i++;
    }
    const rest = raw.slice(i);
    if (!rest.length || rest.startsWith('//')) continue;
    const continuation = stmtStarted && (depth > 0 || (prevSignificant && CONT_END.has(prevSignificant.value) && prevSignificant.type !== 'str') || (indent % 4 !== 0 && indent > indents[indents.length - 1]));
    if (!continuation) {
      if (stmtStarted) tokens.push({ type: 'newline', value: '\n', line: lineNo, col: 0 });
      const cur = indents[indents.length - 1];
      if (indent > cur) {
        indents.push(indent);
        tokens.push({ type: 'indent', value: '', line: lineNo, col: 0 });
      } else {
        while (indent < indents[indents.length - 1]) {
          indents.pop();
          tokens.push({ type: 'dedent', value: '', line: lineNo, col: 0 });
          if (indent > indents[indents.length - 1]) throw new PineError('Inconsistent indentation', lineNo, 1);
        }
      }
      stmtStarted = true;
    }
    // tokenize the rest of the line
    let c = i;
    while (c < raw.length) {
      const ch = raw[c];
      if (ch === ' ' || ch === '\t') {
        c++;
        continue;
      }
      if (ch === '/' && raw[c + 1] === '/') break;
      const col = c + 1;
      // numbers
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(raw[c + 1] || ''))) {
        const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(raw.slice(c))!;
        const t: Token = { type: 'num', value: m[1], line: lineNo, col };
        tokens.push(t);
        prevSignificant = t;
        c += m[1].length;
        continue;
      }
      // strings
      if (ch === '"' || ch === "'") {
        let j = c + 1;
        let s = '';
        while (j < raw.length && raw[j] !== ch) {
          if (raw[j] === '\\' && j + 1 < raw.length) {
            const e = raw[j + 1];
            s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            j += 2;
            continue;
          }
          s += raw[j];
          j++;
        }
        if (j >= raw.length) throw new PineError('Unterminated string', lineNo, col);
        const t: Token = { type: 'str', value: s, line: lineNo, col };
        tokens.push(t);
        prevSignificant = t;
        c = j + 1;
        continue;
      }
      // colors
      if (ch === '#') {
        const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})/.exec(raw.slice(c));
        if (!m) throw new PineError('Invalid color literal', lineNo, col);
        const t: Token = { type: 'color', value: m[0], line: lineNo, col };
        tokens.push(t);
        prevSignificant = t;
        c += m[0].length;
        continue;
      }
      // identifiers / keywords
      if (/[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(c))!;
        const w = m[0];
        const t: Token = { type: KEYWORDS.has(w) ? 'kw' : 'ident', value: w, line: lineNo, col };
        tokens.push(t);
        prevSignificant = t;
        c += w.length;
        continue;
      }
      const op = OPS.find((o) => raw.startsWith(o, c));
      if (!op) throw new PineError(`Unexpected character '${ch}'`, lineNo, col);
      if (op === '(' || op === '[') depth++;
      if (op === ')' || op === ']') depth = Math.max(0, depth - 1);
      const t: Token = { type: 'op', value: op, line: lineNo, col };
      tokens.push(t);
      prevSignificant = t;
      c += op.length;
    }
  }
  if (stmtStarted) tokens.push({ type: 'newline', value: '\n', line: lines.length, col: 0 });
  while (indents.length > 1) {
    indents.pop();
    tokens.push({ type: 'dedent', value: '', line: lines.length, col: 0 });
  }
  tokens.push({ type: 'eof', value: '', line: lines.length + 1, col: 0 });
  return { tokens, version, annotations };
}
