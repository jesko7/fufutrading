/** Recursive-descent parser for Pine Script v4–v6 (the commonly used language subset). */
import { lex, PineError, type Token } from './lexer';
import type { Arg, Expr, ForInStmt, ForStmt, FuncDef, IfStmt, Param, Program, Stmt, SwitchStmt, TypeRef, WhileStmt } from './ast';

const TYPE_NAMES = new Set(['int', 'float', 'bool', 'string', 'color', 'label', 'line', 'box', 'table', 'linefill', 'polyline', 'array', 'map', 'matrix', 'chart']);
const QUALIFIERS = new Set(['series', 'simple', 'const', 'input']);
const ASSIGN_OPS = new Set([':=', '+=', '-=', '*=', '/=', '%=']);

let nodeId = 0;

export function parse(src: string): Program {
  const { tokens, version, annotations } = lex(src);
  const p = new Parser(tokens);
  const body = p.program();
  return { body, version, annotations };
}

class Parser {
  i = 0;
  userTypes = new Set<string>();
  constructor(private t: Token[]) {}

  peek(o = 0): Token {
    return this.t[Math.min(this.i + o, this.t.length - 1)];
  }
  next(): Token {
    return this.t[this.i++];
  }
  is(type: string, value?: string, o = 0): boolean {
    const tk = this.peek(o);
    return tk.type === type && (value === undefined || tk.value === value);
  }
  isOp(v: string, o = 0): boolean {
    return this.is('op', v, o);
  }
  isKw(v: string, o = 0): boolean {
    return this.is('kw', v, o);
  }
  expectOp(v: string): Token {
    if (!this.isOp(v)) this.fail(`Expected '${v}'`);
    return this.next();
  }
  expectIdent(): Token {
    const tk = this.peek();
    if (tk.type !== 'ident') this.fail(`Expected identifier but found '${tk.value || tk.type}'`);
    return this.next();
  }
  fail(msg: string, tk = this.peek()): never {
    throw new PineError(msg, tk.line, tk.col, 'syntax');
  }
  skipNewlines(): void {
    while (this.is('newline')) this.next();
  }

  program(): Stmt[] {
    const out: Stmt[] = [];
    this.skipNewlines();
    while (!this.is('eof')) {
      if (this.is('indent')) this.fail('Unexpected indentation');
      out.push(this.statement());
      this.endStatement();
    }
    return out;
  }

  endStatement(): void {
    if (this.is('newline')) {
      this.skipNewlines();
      return;
    }
    if (this.is('eof') || this.is('dedent')) return;
    // a statement ending with an indented block is terminated by its DEDENT
    if (this.i > 0 && this.t[this.i - 1].type === 'dedent') return;
    // allow comma-separated statements on one line (Pine permits this)
    if (this.isOp(',')) {
      this.next();
      return;
    }
    this.fail(`Unexpected '${this.peek().value}'`);
  }

  block(): Stmt[] {
    // expects NEWLINE INDENT stmts DEDENT
    if (!this.is('newline')) {
      // single statement on the same line is not valid Pine for blocks, but accept it
      return [this.statement()];
    }
    this.skipNewlines();
    if (!this.is('indent')) this.fail('Expected an indented block');
    this.next();
    const out: Stmt[] = [];
    this.skipNewlines();
    while (!this.is('dedent') && !this.is('eof')) {
      out.push(this.statement());
      this.endStatement();
    }
    if (this.is('dedent')) this.next();
    return out;
  }

  // ------------------------------------------------------------------ statements

  statement(): Stmt {
    const tk = this.peek();
    const pos = { line: tk.line, col: tk.col };
    if (this.isKw('import')) {
      this.next();
      let path = '';
      while (!this.is('newline') && !this.is('eof') && !this.isKw('as' as any)) {
        if (this.is('ident', 'as')) break;
        path += this.next().value;
      }
      let alias = path.split('/').slice(-2, -1)[0] || path;
      if (this.is('ident', 'as')) {
        this.next();
        alias = this.expectIdent().value;
      }
      return { k: 'import', path, alias, ...pos };
    }
    let exported = false;
    if (this.isKw('export')) {
      this.next();
      exported = true;
    }
    const declEnd = (o: number) => this.is('newline', undefined, o) || this.is('eof', undefined, o) || this.is('indent', undefined, o);
    if (this.is('ident', 'type') && this.is('ident', undefined, 1) && declEnd(2)) return this.typeDef(exported, pos);
    if (this.is('ident', 'enum') && this.is('ident', undefined, 1) && declEnd(2)) return this.enumDef(pos);
    if (this.is('ident', 'method') && this.is('ident', undefined, 1) && this.isOp('(', 2)) {
      this.next();
      return this.funcDef(true, exported, pos);
    }
    if (this.is('ident') && this.isOp('(', 1) && this.isFuncDef()) return this.funcDef(false, exported, pos);
    if (this.isKw('if')) return this.ifStmt();
    if (this.isKw('for')) return this.forStmt();
    if (this.isKw('while')) return this.whileStmt();
    if (this.isKw('switch')) return this.switchStmt();
    if (this.isKw('break')) {
      this.next();
      return { k: 'break', ...pos };
    }
    if (this.isKw('continue')) {
      this.next();
      return { k: 'continue', ...pos };
    }
    // tuple declaration [a, b] = ...
    if (this.isOp('[') && this.isTupleDecl()) {
      this.next();
      const names: string[] = [];
      do {
        names.push(this.expectIdent().value);
      } while (this.isOp(',') && this.next());
      this.expectOp(']');
      this.expectOp('=');
      return { k: 'tupledecl', names, value: this.exprOrBlock(), id: nodeId++, ...pos };
    }
    // declarations: [var|varip] [qualifier] [type] name = expr
    let mode: 'normal' | 'var' | 'varip' = 'normal';
    if (this.isKw('var') || this.isKw('varip')) mode = this.next().value as 'var' | 'varip';
    const declType = this.tryDeclType();
    if (declType || mode !== 'normal') {
      const name = this.expectIdent().value;
      this.expectOp('=');
      return { k: 'decl', mode, type: declType || undefined, name, value: this.exprOrBlock(), id: nodeId++, ...pos };
    }
    if (this.is('ident') && this.isOp('=', 1)) {
      const name = this.next().value;
      this.next();
      return { k: 'decl', mode, name, value: this.exprOrBlock(), id: nodeId++, ...pos };
    }
    const e = this.expr();
    if (this.is('op') && ASSIGN_OPS.has(this.peek().value)) {
      const op = this.next().value;
      if (e.k !== 'id' && e.k !== 'member') this.fail('Invalid assignment target');
      return { k: 'assign', target: e, op, value: this.exprOrBlock(), ...pos };
    }
    if (this.isOp('=')) this.fail("Use ':=' to reassign an existing variable");
    return { k: 'expr', e, ...pos };
  }

  /** Lookahead: ident ( ... ) => */
  isFuncDef(): boolean {
    let j = this.i + 1;
    let d = 0;
    for (; j < this.t.length; j++) {
      const tk = this.t[j];
      if (tk.type === 'op' && (tk.value === '(' || tk.value === '[')) d++;
      else if (tk.type === 'op' && (tk.value === ')' || tk.value === ']')) {
        d--;
        if (d === 0) break;
      } else if (tk.type === 'newline' && d === 0) return false;
      else if (tk.type === 'eof') return false;
    }
    const after = this.t[j + 1];
    return !!after && after.type === 'op' && after.value === '=>';
  }

  isTupleDecl(): boolean {
    let j = this.i + 1;
    while (j < this.t.length) {
      const tk = this.t[j];
      if (tk.type === 'op' && tk.value === ']') break;
      if (!(tk.type === 'ident' || (tk.type === 'op' && tk.value === ','))) return false;
      j++;
    }
    const after = this.t[j + 1];
    return !!after && after.type === 'op' && after.value === '=';
  }

  /** Parse an optional type in a declaration (only when followed by an identifier and '='). */
  tryDeclType(): TypeRef | null {
    const save = this.i;
    let qualifier: TypeRef['qualifier'];
    if (this.is('ident') && QUALIFIERS.has(this.peek().value) && this.is('ident', undefined, 1)) qualifier = this.next().value as TypeRef['qualifier'];
    const t = this.tryType();
    if (t && this.is('ident') && this.isOp('=', 1)) {
      if (qualifier) t.qualifier = qualifier;
      return t;
    }
    this.i = save;
    return null;
  }

  tryType(): TypeRef | null {
    const tk = this.peek();
    if (tk.type !== 'ident') return null;
    const save = this.i;
    let name = this.next().value;
    // namespaced types like chart.point or lib.Type
    while (this.isOp('.') && this.is('ident', undefined, 1)) {
      this.next();
      name += `.${this.next().value}`;
    }
    if (!TYPE_NAMES.has(name.split('.')[0]) && !this.userTypes.has(name) && !/^[A-Z]/.test(name)) {
      this.i = save;
      return null;
    }
    const t: TypeRef = { name };
    if (this.isOp('<')) {
      const gs = this.tryGenerics();
      if (!gs) {
        this.i = save;
        return null;
      }
      t.args = gs;
    }
    if (this.isOp('[') && this.isOp(']', 1)) {
      this.next();
      this.next();
      t.isArray = true;
    }
    return t;
  }

  tryGenerics(): TypeRef[] | null {
    const save = this.i;
    if (!this.isOp('<')) return null;
    this.next();
    const out: TypeRef[] = [];
    for (;;) {
      const t = this.tryType();
      if (!t) {
        this.i = save;
        return null;
      }
      out.push(t);
      if (this.isOp(',')) {
        this.next();
        continue;
      }
      if (this.isOp('>')) {
        this.next();
        return out;
      }
      this.i = save;
      return null;
    }
  }

  typeDef(exported: boolean, pos: { line: number; col: number }): Stmt {
    this.next();
    const name = this.expectIdent().value;
    this.userTypes.add(name);
    const fields: { name: string; type: TypeRef; def?: Expr }[] = [];
    this.skipNewlines();
    if (this.is('indent')) {
      this.next();
      while (!this.is('dedent') && !this.is('eof')) {
        this.skipNewlines();
        if (this.is('dedent')) break;
        if (this.isKw('varip') || this.isKw('var')) this.next();
        const type = this.tryType();
        if (!type) this.fail('Expected a field type');
        const fname = this.expectIdent().value;
        let def: Expr | undefined;
        if (this.isOp('=')) {
          this.next();
          def = this.expr();
        }
        fields.push({ name: fname, type, def });
        this.skipNewlines();
      }
      if (this.is('dedent')) this.next();
    }
    return { k: 'typedef', name, fields, exported, ...pos };
  }

  enumDef(pos: { line: number; col: number }): Stmt {
    this.next();
    const name = this.expectIdent().value;
    this.userTypes.add(name);
    const members: { name: string; title?: string }[] = [];
    this.skipNewlines();
    if (this.is('indent')) {
      this.next();
      while (!this.is('dedent') && !this.is('eof')) {
        this.skipNewlines();
        if (this.is('dedent')) break;
        const m = this.expectIdent().value;
        let title: string | undefined;
        if (this.isOp('=')) {
          this.next();
          const s = this.next();
          title = s.value;
        }
        members.push({ name: m, title });
        this.skipNewlines();
      }
      if (this.is('dedent')) this.next();
    }
    return { k: 'enumdef', name, members, ...pos };
  }

  funcDef(isMethod: boolean, exported: boolean, pos: { line: number; col: number }): FuncDef {
    const name = this.expectIdent().value;
    this.expectOp('(');
    const params: Param[] = [];
    while (!this.isOp(')')) {
      if (this.is('ident') && QUALIFIERS.has(this.peek().value) && this.is('ident', undefined, 1)) this.next();
      let type: TypeRef | undefined;
      // "Type name" or just "name"
      if (this.is('ident') && (this.is('ident', undefined, 1) || this.isOp('<', 1) || (this.isOp('[', 1) && this.isOp(']', 2)))) {
        const t = this.tryType();
        if (t && this.is('ident')) type = t;
      }
      const pname = this.expectIdent().value;
      let def: Expr | undefined;
      if (this.isOp('=')) {
        this.next();
        def = this.expr();
      }
      params.push({ name: pname, type, def });
      if (this.isOp(',')) this.next();
      else break;
    }
    this.expectOp(')');
    this.expectOp('=>');
    let body: Stmt[];
    if (this.is('newline')) body = this.block();
    else {
      const e = this.exprOrBlock();
      body = [{ k: 'expr', e, line: e.line, col: e.col }];
    }
    return { k: 'func', name, params, body, isMethod, exported, ...pos };
  }

  ifStmt(): IfStmt {
    const tk = this.next();
    const test = this.expr();
    const then = this.block();
    const elifs: { test: Expr; body: Stmt[] }[] = [];
    let els: Stmt[] | undefined;
    for (;;) {
      // `else` must be at the same indentation: after the block we are at a newline-less position
      const save = this.i;
      this.skipNewlines();
      if (this.isKw('else')) {
        this.next();
        if (this.isKw('if')) {
          this.next();
          const t2 = this.expr();
          elifs.push({ test: t2, body: this.block() });
          continue;
        }
        els = this.block();
        break;
      }
      this.i = save;
      break;
    }
    return { k: 'if', test, then, elifs, else: els, line: tk.line, col: tk.col };
  }

  forStmt(): ForStmt | ForInStmt {
    const tk = this.next();
    if (this.isOp('[')) {
      this.next();
      const names = [this.expectIdent().value];
      while (this.isOp(',')) {
        this.next();
        names.push(this.expectIdent().value);
      }
      this.expectOp(']');
      if (!this.isKw('in')) this.fail("Expected 'in'");
      this.next();
      const iter = this.expr();
      return { k: 'forin', names, iter, body: this.block(), line: tk.line, col: tk.col };
    }
    const name = this.expectIdent().value;
    if (this.isKw('in')) {
      this.next();
      const iter = this.expr();
      return { k: 'forin', names: [name], iter, body: this.block(), line: tk.line, col: tk.col };
    }
    this.expectOp('=');
    const from = this.expr();
    if (!this.isKw('to')) this.fail("Expected 'to'");
    this.next();
    const to = this.expr();
    let step: Expr | undefined;
    if (this.isKw('by')) {
      this.next();
      step = this.expr();
    }
    return { k: 'for', name, from, to, step, body: this.block(), line: tk.line, col: tk.col };
  }

  whileStmt(): WhileStmt {
    const tk = this.next();
    const test = this.expr();
    return { k: 'while', test, body: this.block(), line: tk.line, col: tk.col };
  }

  switchStmt(): SwitchStmt {
    const tk = this.next();
    let subject: Expr | undefined;
    if (!this.is('newline')) subject = this.expr();
    this.skipNewlines();
    if (!this.is('indent')) this.fail('Expected switch cases');
    this.next();
    const cases: { test?: Expr; body: Stmt[] }[] = [];
    while (!this.is('dedent') && !this.is('eof')) {
      this.skipNewlines();
      if (this.is('dedent')) break;
      let test: Expr | undefined;
      if (this.isOp('=>')) this.next();
      else {
        test = this.expr();
        this.expectOp('=>');
      }
      let body: Stmt[];
      if (this.is('newline')) body = this.block();
      else {
        const s = this.statementOrExpr();
        body = [s];
      }
      cases.push({ test, body });
      this.skipNewlines();
    }
    if (this.is('dedent')) this.next();
    return { k: 'switch', subject, cases, line: tk.line, col: tk.col };
  }

  statementOrExpr(): Stmt {
    return this.statement();
  }

  exprOrBlock(): Expr {
    const tk = this.peek();
    if (this.isKw('if')) return { k: 'ifx', node: this.ifStmt(), line: tk.line, col: tk.col };
    if (this.isKw('switch')) return { k: 'switchx', node: this.switchStmt(), line: tk.line, col: tk.col };
    if (this.isKw('for')) return { k: 'forx', node: this.forStmt(), line: tk.line, col: tk.col };
    if (this.isKw('while')) return { k: 'forx', node: this.whileStmt(), line: tk.line, col: tk.col };
    return this.expr();
  }

  // ------------------------------------------------------------------ expressions

  expr(): Expr {
    return this.ternary();
  }

  ternary(): Expr {
    const test = this.or();
    if (this.isOp('?')) {
      const tk = this.next();
      const a = this.ternary();
      this.expectOp(':');
      const b = this.ternary();
      return { k: 'ternary', test, then: a, else: b, line: tk.line, col: tk.col };
    }
    return test;
  }

  or(): Expr {
    let l = this.and();
    while (this.isKw('or')) {
      const tk = this.next();
      l = { k: 'binary', op: 'or', left: l, right: this.and(), line: tk.line, col: tk.col };
    }
    return l;
  }

  and(): Expr {
    let l = this.not();
    while (this.isKw('and')) {
      const tk = this.next();
      l = { k: 'binary', op: 'and', left: l, right: this.not(), line: tk.line, col: tk.col };
    }
    return l;
  }

  not(): Expr {
    if (this.isKw('not')) {
      const tk = this.next();
      return { k: 'unary', op: 'not', arg: this.not(), line: tk.line, col: tk.col };
    }
    return this.equality();
  }

  equality(): Expr {
    let l = this.comparison();
    while (this.isOp('==') || this.isOp('!=')) {
      const tk = this.next();
      l = { k: 'binary', op: tk.value, left: l, right: this.comparison(), line: tk.line, col: tk.col };
    }
    return l;
  }

  comparison(): Expr {
    let l = this.additive();
    while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) {
      const tk = this.next();
      l = { k: 'binary', op: tk.value, left: l, right: this.additive(), line: tk.line, col: tk.col };
    }
    return l;
  }

  additive(): Expr {
    let l = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const tk = this.next();
      l = { k: 'binary', op: tk.value, left: l, right: this.multiplicative(), line: tk.line, col: tk.col };
    }
    return l;
  }

  multiplicative(): Expr {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const tk = this.next();
      l = { k: 'binary', op: tk.value, left: l, right: this.unary(), line: tk.line, col: tk.col };
    }
    return l;
  }

  unary(): Expr {
    if (this.isOp('-') || this.isOp('+')) {
      const tk = this.next();
      return { k: 'unary', op: tk.value, arg: this.unary(), line: tk.line, col: tk.col };
    }
    if (this.isKw('not')) {
      const tk = this.next();
      return { k: 'unary', op: 'not', arg: this.unary(), line: tk.line, col: tk.col };
    }
    return this.postfix();
  }

  postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp('(')) {
        const tk = this.next();
        const args = this.args();
        e = { k: 'call', callee: e, args, id: nodeId++, line: tk.line, col: tk.col };
        continue;
      }
      if (this.isOp('<') && (e.k === 'member' || e.k === 'id')) {
        const save = this.i;
        const gs = this.tryGenerics();
        if (gs && this.isOp('(')) {
          const tk = this.next();
          const args = this.args();
          e = { k: 'call', callee: e, args, generics: gs, id: nodeId++, line: tk.line, col: tk.col };
          continue;
        }
        this.i = save;
        break;
      }
      if (this.isOp('[')) {
        const tk = this.next();
        const index = this.expr();
        this.expectOp(']');
        e = { k: 'index', obj: e, index, id: nodeId++, line: tk.line, col: tk.col };
        continue;
      }
      if (this.isOp('.')) {
        const tk = this.next();
        const nm = this.peek();
        if (nm.type !== 'ident' && nm.type !== 'kw') this.fail('Expected member name');
        this.next();
        e = { k: 'member', obj: e, prop: nm.value, line: tk.line, col: tk.col };
        continue;
      }
      break;
    }
    return e;
  }

  args(): Arg[] {
    const out: Arg[] = [];
    while (!this.isOp(')')) {
      if (this.is('ident') && this.isOp('=', 1)) {
        const name = this.next().value;
        this.next();
        out.push({ name, value: this.exprOrBlock() });
      } else out.push({ value: this.exprOrBlock() });
      if (this.isOp(',')) this.next();
      else break;
    }
    this.expectOp(')');
    return out;
  }

  primary(): Expr {
    const tk = this.peek();
    const pos = { line: tk.line, col: tk.col };
    switch (tk.type) {
      case 'num':
        this.next();
        return { k: 'num', v: +tk.value, isInt: /^\d+$/.test(tk.value), ...pos };
      case 'str':
        this.next();
        return { k: 'str', v: tk.value, ...pos };
      case 'color':
        this.next();
        return { k: 'color', v: tk.value, ...pos };
      case 'ident':
        this.next();
        return { k: 'id', name: tk.value, ...pos };
      case 'kw':
        if (tk.value === 'true' || tk.value === 'false') {
          this.next();
          return { k: 'bool', v: tk.value === 'true', ...pos };
        }
        if (tk.value === 'if' || tk.value === 'switch' || tk.value === 'for' || tk.value === 'while') return this.exprOrBlock();
        this.fail(`Unexpected keyword '${tk.value}'`);
      // eslint-disable-next-line no-fallthrough
      case 'op':
        if (tk.value === '(') {
          this.next();
          const e = this.expr();
          this.expectOp(')');
          return e;
        }
        if (tk.value === '[') {
          this.next();
          const items: Expr[] = [];
          while (!this.isOp(']')) {
            items.push(this.expr());
            if (this.isOp(',')) this.next();
            else break;
          }
          this.expectOp(']');
          return { k: 'tuple', items, ...pos };
        }
        this.fail(`Unexpected '${tk.value}'`);
      // eslint-disable-next-line no-fallthrough
      default:
        this.fail(tk.type === 'eof' ? 'Unexpected end of script' : `Unexpected '${tk.value || tk.type}'`);
    }
  }
}
