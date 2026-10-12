/**
 * Pine Script → JavaScript compiler.
 *
 * The generated module is a factory `(B, R) => main` where `main()` executes one bar.
 * User variables become JS locals (or properties of G when read inside functions); variables
 * referenced with the history operator get a series slot in their scope's context; built-in
 * stateful functions get a per-call-site state object; user functions get a child context per
 * call site — reproducing Pine's execution model.
 */
import { parse } from './parser';
import { PineError } from './lexer';
import type { Expr, Stmt, FuncDef, IfStmt, SwitchStmt, ForStmt, ForInStmt, WhileStmt, TypeRef, Program, Arg } from './ast';
import { BUILTINS, SPECIAL, UNSUPPORTED, VARIABLES, CONSTANTS, type Ret, type Spec } from './builtins/registry';
import { COLORS } from './builtins/lib';

export interface InputDef {
  key: string;
  index: number;
  type: 'int' | 'float' | 'bool' | 'string' | 'color' | 'source' | 'timeframe' | 'symbol' | 'session' | 'price' | 'time' | 'text_area' | 'enum';
  title: string;
  defval: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: unknown[];
  tooltip?: string;
  group?: string;
  inline?: string;
  line: number;
}

export interface PlotStatic {
  id: string;
  index: number;
  kind: 'plot' | 'shape' | 'char' | 'arrow' | 'candle' | 'bar';
  title: string;
  color?: string;
  colorDynamic: boolean;
  style: string;
  width: number;
  offset: number;
  histbase: number;
  display: boolean;
  trackPrice: boolean;
  location?: string;
  text?: string;
  char?: string;
  textColor?: string;
  size?: string;
  precision?: number;
  format?: string;
  colorup?: string;
  colordown?: string;
}

export interface HLineStatic {
  id: string;
  index: number;
  title: string;
  price: number | null;
  color: string;
  style: string;
  width: number;
  display: boolean;
}

export interface FillStatic {
  index: number;
  a: string;
  b: string;
  color?: string;
  colorDynamic: boolean;
  title: string;
}

export interface SecuritySite {
  site: number;
  symJs: string;
  tfJs: string;
  lookahead: boolean;
  gaps: boolean;
  lowerTf: boolean;
  line: number;
}

export interface ScriptMeta {
  type: 'indicator' | 'strategy' | 'library';
  title: string;
  shortTitle: string;
  overlay: boolean;
  precision?: number;
  format?: string;
  maxLabels?: number;
  maxLines?: number;
  maxBoxes?: number;
  strategy?: Record<string, unknown>;
}

export interface CompiledPine {
  version: number;
  meta: ScriptMeta;
  inputs: InputDef[];
  plots: PlotStatic[];
  hlines: HLineStatic[];
  fills: FillStatic[];
  alertconds: { index: number; title: string; message: string }[];
  security: SecuritySite[];
  js: string;
  factory: (B: any, R: any) => () => void;
  rootSlots: { num: number; obj: number; vars: number };
  warnings: { line: number; message: string; kind: 'lookahead' | 'repaint' | 'compat' | 'info' }[];
  usesStrategy: boolean;
  /** user functions (for the debugger / outline) */
  functions: { name: string; line: number; params: string[] }[];
  variables: { name: string; line: number }[];
}

interface VarInfo {
  name: string;
  js: string; // read expression
  mode: 'local' | 'var' | 'varip' | 'param' | 'loop' | 'global';
  type: Ret;
  decl: number; // unique id
  fn: FnScope;
  histSlot?: number;
  obj?: boolean;
  plotHandle?: number;
  hlineHandle?: number;
  gsync?: string;
  line: number;
}

class FnScope {
  num = 0;
  obj = 0;
  vars = 0;
  varips = 0;
  states = 0;
  children = 0;
  readonly token: string;
  constructor(
    readonly name: string,
    readonly isGlobal: boolean,
    id: number,
  ) {
    this.token = `\u0002F${id}\u0002`;
  }
}

const BAR_SERIES = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'time', 'time_close', 'bar_index']);
const JS_RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public', 'arguments', 'eval']);

function colorLit(c: string): string {
  const h = c.slice(1).toUpperCase();
  return `#${h.length === 6 ? `${h}ff` : h.slice(0, 6) + h.slice(6).toLowerCase()}`;
}

export function compilePine(src: string): CompiledPine {
  const prog = parse(src);
  return new Compiler(prog).compile();
}

class Compiler {
  out: string[] = [];
  indent = 1;
  scopes: Map<string, VarInfo>[] = [];
  fn!: FnScope;
  root!: FnScope;
  fns = new Map<string, { def: FuncDef; scope: FnScope; js: string; paramNames: string[] }>();
  methods = new Map<string, string>();
  udts = new Map<string, { fields: { name: string; def?: Expr; type: TypeRef }[] }>();
  enums = new Map<string, { name: string; title?: string }[]>();
  declSeq = 0;
  tmpSeq = 0;
  fnSeq = 0;
  decls = new Map<number, VarInfo>();
  inputs: InputDef[] = [];
  plots: PlotStatic[] = [];
  hlines: HLineStatic[] = [];
  fills: FillStatic[] = [];
  alertconds: { index: number; title: string; message: string }[] = [];
  security: SecuritySite[] = [];
  meta: ScriptMeta = { type: 'indicator', title: 'Script', shortTitle: 'Script', overlay: false };
  warnings: CompiledPine['warnings'] = [];
  globalsUsedInFns = new Set<string>();
  version: number;
  usesStrategy = false;
  /** globals whose history is read inside functions: name -> decl (filled when the global is declared) */
  globalHist = new Map<string, VarInfo | null>();
  /** initializer expressions of global (non-var) declarations, for static resolution in request.security */
  staticInits = new Map<string, Expr>();
  /** globals reassigned with := somewhere */
  reassigned = new Set<string>();
  /** globals whose initializer was inlined into a request.security argument */
  staticUsed = new Map<string, number>();
  variablesList: { name: string; line: number }[] = [];
  constructor(readonly prog: Program) {
    this.version = prog.version ?? 5;
  }

  err(msg: string, node: { line: number; col: number }, kind: 'compile' | 'unsupported' = 'compile'): never {
    throw new PineError(msg, node.line, node.col, kind);
  }

  emit(line: string): void {
    this.out.push('  '.repeat(this.indent) + line);
  }

  tmp(): string {
    return `__t${this.tmpSeq++}`;
  }

  // ------------------------------------------------------------------ scopes

  push(): void {
    this.scopes.push(new Map());
  }
  pop(): void {
    this.scopes.pop();
  }
  lookup(name: string): VarInfo | undefined {
    for (let k = this.scopes.length - 1; k >= 0; k--) {
      const v = this.scopes[k].get(name);
      if (v) return v;
    }
    return undefined;
  }
  declare(name: string, info: Omit<VarInfo, 'decl' | 'fn'>, node: { line: number; col: number }): VarInfo {
    const cur = this.scopes[this.scopes.length - 1];
    if (cur.has(name) && info.mode !== 'loop') this.err(`'${name}' is already declared in this scope (use ':=' to reassign)`, node);
    const v: VarInfo = { ...info, decl: this.declSeq++, fn: this.fn };
    cur.set(name, v);
    this.decls.set(v.decl, v);
    return v;
  }

  // ------------------------------------------------------------------ entry

  compile(): CompiledPine {
    // collect declarations hoisted: functions, methods, types, enums
    for (const s of this.prog.body) {
      if (s.k === 'import') this.err(`Libraries (import ${s.path}) are not supported: TradingView's library repository is not available in FuFu. Paste the library's functions into your script instead.`, s, 'unsupported');
      if (s.k === 'typedef') this.udts.set(s.name, { fields: s.fields });
      if (s.k === 'enumdef') this.enums.set(s.name, s.members);
    }
    this.root = new FnScope('main', true, this.fnSeq++);
    this.fn = this.root;
    // determine globals referenced inside functions (they must live on G)
    const globalNames = new Set<string>();
    for (const s of this.prog.body) if (s.k === 'decl') globalNames.add(s.name);
    for (const s of this.prog.body) if (s.k === 'tupledecl') s.names.forEach((n) => globalNames.add(n));
    for (const s of this.prog.body) if (s.k === 'func') this.scanNames(s.body, globalNames);
    for (const s of this.prog.body) if (s.k === 'func') this.registerFn(s);

    const header: string[] = [];
    // function bodies
    const fnBodies: string[] = [];
    for (const [, f] of this.fns) fnBodies.push(this.compileFn(f));
    // main body
    this.fn = this.root;
    this.out = [];
    this.indent = 2;
    this.push();
    for (const s of this.prog.body) {
      if (s.k === 'func' || s.k === 'typedef' || s.k === 'enumdef' || s.k === 'import') continue;
      this.stmt(s, true);
    }
    this.pop();
    const mainBody = this.out.join('\n');
    // UDT constructors
    for (const [name, t] of this.udts) {
      const params = t.fields.map((f) => `f_${f.name}`).join(', ');
      const defs = t.fields.map((f) => `if (f_${f.name} === undefined) f_${f.name} = ${f.def ? this.constJs(f.def) : this.naFor(f.type.name)};`).join(' ');
      header.push(`  const U_${name} = { new: function(${params}) { ${defs} return { __t: ${JSON.stringify(name)}, ${t.fields.map((f) => `${f.name}: f_${f.name}`).join(', ')} }; }, copy: (o) => (o ? Object.assign({}, o) : null) };`);
    }
    for (const [name, members] of this.enums) header.push(`  const E_${name} = { ${members.map((m) => `${m.name}: ${JSON.stringify(`${name}.${m.name}`)}`).join(', ')} };`);
    let js = [
      '"use strict";',
      // bar arrays are re-read whenever the data object is replaced (live updates)
      'let D = null, O, H, L, C, V, T, TC;',
      'function sync() { D = R.d; O = D.o; H = D.h; L = D.l; C = D.c; V = D.v; T = D.t; TC = D.tc; }',
      'const G = {};',
      'let i = 0;',
      ...header,
      ...fnBodies,
      'return function main() {',
      '  if (D !== R.d) sync();',
      '  i = R.i;',
      '  const ctx = R.root;',
      mainBody,
      '};',
    ].join('\n');
    for (const [name, line] of this.staticUsed) {
      if (this.reassigned.has(name)) throw new PineError(`request.security: '${name}' is reassigned with ':=' — the symbol/timeframe must be fixed (use an input or a constant)`, line, 0, 'compile');
    }
    // finalize placeholders
    js = this.finalize(js);
    let factory: (B: any, R: any) => () => void;
    try {
      factory = new Function('B', 'R', js) as any;
    } catch (e) {
      throw new PineError(`Internal compiler error: ${(e as Error).message}`, 0, 0, 'compile');
    }
    return {
      version: this.version,
      meta: this.meta,
      inputs: this.inputs,
      plots: this.plots,
      hlines: this.hlines,
      fills: this.fills,
      alertconds: this.alertconds,
      security: this.security,
      js,
      factory,
      rootSlots: { num: this.root.num, obj: this.root.obj, vars: this.root.vars },
      warnings: this.warnings,
      usesStrategy: this.usesStrategy,
      functions: [...this.fns.values()].map((f) => ({ name: f.def.name, line: f.def.line, params: f.def.params.map((p) => p.name) })),
      variables: this.variablesList,
    };
  }

  /** Replace slot-count tokens and history placeholders. */
  finalize(js: string): string {
    // history push/set placeholders: \u0001H<decl>|<expr>\u0001 and \u0001S<decl>|<expr>\u0001
    js = js.replace(/\u0001([HS])(\d+)\|([^\u0001]*)\u0001/g, (_m, kind, id, expr) => {
      const v = this.decls.get(+id);
      if (!v || v.histSlot === undefined) return '';
      return `${this.seriesRef(v)}.${kind === 'H' ? 'push' : 'set'}(${expr});`;
    });
    js = js.replace(/\u0004GH:(\w+)\u0004/g, (_m, name) => {
      const v = this.globalHist.get(name);
      if (!v || v.histSlot === undefined) throw new PineError(`'${name}' is used with [] inside a function but is not a top-level variable`, 0, 0, 'compile');
      return v.obj ? `${this.root.token}+${v.histSlot}` : String(v.histSlot);
    });
    const all = [this.root, ...[...this.fns.values()].map((f) => f.scope)];
    // prefixed placeholders first: the bare token is a substring of them
    for (const sc of all) {
      js = js.split(`\u0003O${sc.token}`).join(String(sc.obj));
      js = js.split(`\u0003V${sc.token}`).join(String(Math.max(sc.vars, 1)));
    }
    for (const sc of all) js = js.split(sc.token).join(String(sc.num));
    return js;
  }

  seriesRef(v: VarInfo): string {
    const ctx = v.fn.isGlobal ? 'R.root' : 'ctx';
    return v.obj ? `${ctx}.s[${v.fn.token}+${v.histSlot}]` : `${ctx}.s[${v.histSlot}]`;
  }

  scanNames(stmts: Stmt[], globals: Set<string>): void {
    const visit = (e: any): void => {
      if (!e || typeof e !== 'object') return;
      if (e.k === 'id' && globals.has(e.name)) this.globalsUsedInFns.add(e.name);
      for (const k of Object.keys(e)) {
        const v = e[k];
        if (Array.isArray(v)) v.forEach(visit);
        else if (v && typeof v === 'object') visit(v);
      }
    };
    stmts.forEach(visit);
  }

  registerFn(def: FuncDef): void {
    const scope = new FnScope(def.name, false, this.fnSeq++);
    const js = `fn_${def.name}`;
    if (this.fns.has(def.name) && !def.isMethod) this.err(`Function '${def.name}' is already defined`, def);
    const key = def.isMethod ? `${def.name}#${def.params[0]?.type?.name || ''}` : def.name;
    this.fns.set(key, { def, scope, js: def.isMethod ? `m_${def.name}_${this.fnSeq}` : js, paramNames: def.params.map((p) => p.name) });
    if (def.isMethod) this.methods.set(def.name, this.fns.get(key)!.js);
  }

  compileFn(f: { def: FuncDef; scope: FnScope; js: string; paramNames: string[] }): string {
    const saveOut = this.out;
    const saveIndent = this.indent;
    const saveScopes = this.scopes;
    this.out = [];
    this.indent = 2;
    this.fn = f.scope;
    this.scopes = [new Map()];
    const params = f.def.params.map((p) => `p_${p.name}`);
    for (const p of f.def.params) {
      const info = this.declare(p.name, { name: p.name, js: `p_${p.name}`, mode: 'param', type: this.typeOfRef(p.type), line: f.def.line }, f.def);
      if (p.def) this.emit(`if (p_${p.name} === undefined) p_${p.name} = ${this.expr(p.def).js};`);
      this.emit(`\u0001H${info.decl}|p_${p.name}\u0001`);
    }
    const last = this.block(f.def.body, true);
    this.emit(`return ${last ?? 'NaN'};`);
    const body = this.out.join('\n');
    this.out = saveOut;
    this.indent = saveIndent;
    this.scopes = saveScopes;
    this.fn = this.root;
    return `  function ${f.js}(ctx, ${params.join(', ')}) {\n${body}\n  }`;
  }

  typeOfRef(t?: TypeRef): Ret {
    if (!t) return 'any';
    if (t.isArray || t.name === 'array') return 'array';
    if (t.name === 'map') return 'map';
    if (t.name === 'int' || t.name === 'float') return 'num';
    if (t.name === 'bool') return 'bool';
    if (t.name === 'string') return 'str';
    if (t.name === 'color') return 'color';
    return 'obj';
  }

  naFor(typeName?: string): string {
    return typeName === 'int' || typeName === 'float' || !typeName ? 'NaN' : 'null';
  }

  // ------------------------------------------------------------------ statements

  /** Compile a block; if `wantValue`, returns the JS of the last expression's value. */
  block(stmts: Stmt[], wantValue = false): string | null {
    let last: string | null = null;
    stmts.forEach((s, k) => {
      const isLast = k === stmts.length - 1;
      if (wantValue && isLast) last = this.stmtValue(s);
      else this.stmt(s, false);
    });
    return last;
  }

  /** Compile a statement that produces the block's value; returns a JS expression for it. */
  stmtValue(s: Stmt): string | null {
    if (s.k === 'expr') {
      const e = s.e;
      if (e.k === 'ifx' || e.k === 'switchx' || e.k === 'forx') {
        const v = this.tmp();
        this.emit(`let ${v} = NaN;`);
        this.valueBlock(e, v);
        return v;
      }
      const r = this.expr(e);
      if (r.ret === 'void') {
        this.emit(`${r.js};`);
        return 'NaN';
      }
      const v = this.tmp();
      this.emit(`const ${v} = ${r.js};`);
      return v;
    }
    if (s.k === 'if' || s.k === 'switch' || s.k === 'for' || s.k === 'forin' || s.k === 'while') {
      const v = this.tmp();
      this.emit(`let ${v} = NaN;`);
      this.valueBlock({ k: s.k === 'if' ? 'ifx' : s.k === 'switch' ? 'switchx' : 'forx', node: s as any, line: s.line, col: s.col } as Expr, v);
      return v;
    }
    if (s.k === 'decl' || s.k === 'assign' || s.k === 'tupledecl') {
      this.stmt(s, false);
      if (s.k === 'decl') return this.lookup(s.name)!.js;
      if (s.k === 'assign' && s.target.k === 'id') return this.lookup(s.target.name)?.js || 'NaN';
      return 'NaN';
    }
    this.stmt(s, false);
    return null;
  }

  stmt(s: Stmt, global: boolean): void {
    switch (s.k) {
      case 'decl':
        return this.decl(s, global);
      case 'tupledecl': {
        const t = this.tmp();
        if (s.value.k === 'ifx' || s.value.k === 'switchx') {
          this.emit(`let ${t} = [];`);
          this.valueBlock(s.value, t);
        } else this.emit(`const ${t} = ${this.expr(s.value).js};`);
        s.names.forEach((n, k) => {
          if (n === '_') return;
          const isG = global && this.globalsUsedInFns.has(n);
          const js = isG ? `G.v_${n}` : `v_${n}_${this.declSeq}`;
          const info = this.declare(n, { name: n, js, mode: isG ? 'global' : 'local', type: 'any', line: s.line }, s);
          this.emit(`${isG ? '' : 'let '}${js} = ${t}[${k}];`);
          this.emit(`\u0001H${info.decl}|${js}\u0001`);
          if (global) this.variablesList.push({ name: n, line: s.line });
        });
        return;
      }
      case 'assign':
        return this.assign(s);
      case 'expr': {
        const e = s.e;
        if (e.k === 'ifx' || e.k === 'switchx' || e.k === 'forx') {
          const v = this.tmp();
          this.emit(`let ${v};`);
          this.valueBlock(e, v);
          return;
        }
        const r = this.expr(e);
        this.emit(`${r.js};`);
        return;
      }
      case 'if':
        return this.ifStmt(s, null);
      case 'for':
        return this.forStmt(s, null);
      case 'forin':
        return this.forInStmt(s, null);
      case 'while':
        return this.whileStmt(s, null);
      case 'switch':
        return this.switchStmt(s, null);
      case 'break':
        this.emit('break;');
        return;
      case 'continue':
        this.emit('continue;');
        return;
      case 'func':
        this.err('Functions must be declared at the top level of the script', s);
      // eslint-disable-next-line no-fallthrough
      case 'typedef':
      case 'enumdef':
        this.err('Types and enums must be declared at the top level of the script', s);
      // eslint-disable-next-line no-fallthrough
      case 'import':
        this.err('Libraries are not supported', s, 'unsupported');
    }
  }

  decl(s: Extract<Stmt, { k: 'decl' }>, global: boolean): void {
    const declType = s.type ? this.typeOfRef(s.type) : undefined;
    const isG = global && this.globalsUsedInFns.has(s.name);
    if (global) this.variablesList.push({ name: s.name, line: s.line });
    if (global && s.mode === 'normal') this.staticInits.set(s.name, s.value);
    if (s.mode === 'normal') {
      let valJs: string;
      let ret: Ret = declType || 'any';
      let plotHandle: number | undefined;
      let hlineHandle: number | undefined;
      if (s.value.k === 'ifx' || s.value.k === 'switchx' || s.value.k === 'forx') {
        const v = this.tmp();
        this.emit(`let ${v} = ${declType === 'num' || !declType ? 'NaN' : 'null'};`);
        this.valueBlock(s.value, v);
        valJs = v;
      } else {
        const r = this.expr(s.value, declType);
        valJs = r.js;
        if (!declType) ret = r.ret;
        plotHandle = r.plot;
        hlineHandle = r.hline;
      }
      if (s.value.k === 'id' && s.value.name === 'na' && declType && declType !== 'num') valJs = 'null';
      const js = isG ? `G.v_${s.name}` : `v_${s.name}_${this.declSeq}`;
      const info = this.declare(s.name, { name: s.name, js, mode: isG ? 'global' : 'local', type: ret, plotHandle, hlineHandle, line: s.line }, s);
      this.needGlobalHist(info);
      this.emit(`${isG ? '' : 'let '}${js} = ${valJs};`);
      this.emit(`\u0001H${info.decl}|${js}\u0001`);
      return;
    }
    // var / varip: persistent across bars in the context
    const slot = s.mode === 'var' ? this.fn.vars++ : this.fn.varips++;
    const arr = s.mode === 'var' ? 'v' : 'vp';
    const flags = s.mode === 'var' ? 'vi' : 'vpi';
    const js = `ctx.${arr}[${slot}]`;
    const ret: Ret = declType || this.peekType(s.value);
    this.emit(`if (!ctx.${flags}[${slot}]) {`);
    this.indent++;
    if (s.value.k === 'ifx' || s.value.k === 'switchx' || s.value.k === 'forx') {
      const v = this.tmp();
      this.emit(`let ${v} = NaN;`);
      this.valueBlock(s.value, v);
      this.emit(`${js} = ${v};`);
    } else {
      let valJs = this.expr(s.value, declType).js;
      if (s.value.k === 'id' && s.value.name === 'na' && declType && declType !== 'num') valJs = 'null';
      this.emit(`${js} = ${valJs};`);
    }
    this.emit(`ctx.${flags}[${slot}] = 1;`);
    this.indent--;
    this.emit('}');
    const info = this.declare(s.name, { name: s.name, js: this.fn.isGlobal && isG ? `R.root.${arr}[${slot}]` : js, mode: s.mode, type: ret, line: s.line }, s);
    if (isG) {
      // functions read the var through G (synced after every write)
      info.js = `ctx.${arr}[${slot}]`;
      info.gsync = `G.v_${s.name}`;
      this.emit(`G.v_${s.name} = ${info.js};`);
      this.needGlobalHist(info);
    }
    this.emit(`\u0001H${info.decl}|${info.js}\u0001`);
  }

  peekType(e: Expr): Ret {
    if (e.k === 'num') return 'num';
    if (e.k === 'str') return 'str';
    if (e.k === 'bool') return 'bool';
    if (e.k === 'color') return 'color';
    return 'any';
  }

  assign(s: Extract<Stmt, { k: 'assign' }>): void {
    if (s.target.k === 'member') {
      const obj = this.expr(s.target.obj).js;
      const val = s.value.k === 'ifx' || s.value.k === 'switchx' ? this.iife(s.value) : this.expr(s.value).js;
      const op = s.op === ':=' ? '=' : s.op;
      this.emit(`if (${obj}) ${obj}.${s.target.prop} ${op} ${val};`);
      return;
    }
    const name = (s.target as Extract<Expr, { k: 'id' }>).name;
    this.reassigned.add(name);
    const v = this.lookup(name);
    if (!v) this.err(`Cannot reassign undeclared variable '${name}' (declare it first with '=')`, s);
    if (v.mode === 'param') this.err(`Cannot modify function parameter '${name}'`, s);
    if (v.fn !== this.fn && v.fn.isGlobal && !this.fn.isGlobal) this.err(`Cannot modify global variable '${name}' from inside a function`, s);
    let val: string;
    if (s.value.k === 'ifx' || s.value.k === 'switchx' || s.value.k === 'forx') {
      const t = this.tmp();
      this.emit(`let ${t} = NaN;`);
      this.valueBlock(s.value, t);
      val = t;
    } else val = this.expr(s.value).js;
    if (s.value.k === 'id' && s.value.name === 'na' && v.type !== 'num' && v.type !== 'any') val = 'null';
    switch (s.op) {
      case ':=':
        this.emit(`${v.js} = ${val};`);
        break;
      case '+=':
        this.emit(v.type === 'str' ? `${v.js} = R.add(${v.js}, ${val});` : `${v.js} = ${v.js} + (${val});`);
        break;
      case '-=':
        this.emit(`${v.js} = ${v.js} - (${val});`);
        break;
      case '*=':
        this.emit(`${v.js} = ${v.js} * (${val});`);
        break;
      case '/=':
        this.emit(`${v.js} = R.div(${v.js}, ${val});`);
        break;
      case '%=':
        this.emit(`${v.js} = R.mod(${v.js}, ${val});`);
        break;
    }
    if (v.gsync) this.emit(`${v.gsync} = ${v.js};`);
    this.emit(`\u0001S${v.decl}|${v.js}\u0001`);
  }

  needGlobalHist(v: VarInfo): void {
    if (!this.globalHist.has(v.name) || !v.fn.isGlobal) return;
    if (v.histSlot === undefined) {
      v.obj = true;
      v.histSlot = v.fn.obj++;
    }
    this.globalHist.set(v.name, v);
  }

  cond(e: Expr): string {
    const r = this.expr(e);
    return r.ret === 'bool' ? r.js : `R.bool(${r.js})`;
  }

  ifStmt(s: IfStmt, target: string | null): void {
    this.emit(`if (${this.cond(s.test)}) {`);
    this.branch(s.then, target);
    for (const ei of s.elifs) {
      this.emit(`} else if (${this.cond(ei.test)}) {`);
      this.branch(ei.body, target);
    }
    if (s.else) {
      this.emit('} else {');
      this.branch(s.else, target);
    }
    this.emit('}');
  }

  branch(body: Stmt[], target: string | null): void {
    this.indent++;
    this.push();
    const v = this.block(body, target !== null);
    if (target !== null && v !== null) this.emit(`${target} = ${v};`);
    this.pop();
    this.indent--;
  }

  forStmt(s: ForStmt, target: string | null): void {
    const a = this.tmp();
    const b = this.tmp();
    const st = this.tmp();
    this.emit(`{ const ${a} = ${this.expr(s.from).js}, ${b} = ${this.expr(s.to).js};`);
    this.indent++;
    this.emit(`const ${st} = ${s.step ? `Math.abs(${this.expr(s.step).js}) * (${b} >= ${a} ? 1 : -1)` : `(${b} >= ${a} ? 1 : -1)`};`);
    const v = `v_${s.name}_${this.declSeq}`;
    this.emit(`for (let ${v} = ${a}; ${st} > 0 ? ${v} <= ${b} : ${v} >= ${b}; ${v} += ${st}) {`);
    this.indent++;
    this.emit('R.loop();');
    this.push();
    this.declare(s.name, { name: s.name, js: v, mode: 'loop', type: 'num', line: s.line }, s);
    const val = this.block(s.body, target !== null);
    if (target !== null && val !== null) this.emit(`${target} = ${val};`);
    this.pop();
    this.indent--;
    this.emit('}');
    this.indent--;
    this.emit('}');
  }

  forInStmt(s: ForInStmt, target: string | null): void {
    const it = this.tmp();
    const k = this.tmp();
    this.emit(`{ const ${it} = ${this.expr(s.iter).js};`);
    this.indent++;
    this.push();
    if (s.names.length === 2) {
      const iv = `v_${s.names[0]}_${this.declSeq}`;
      this.declare(s.names[0], { name: s.names[0], js: iv, mode: 'loop', type: 'any', line: s.line }, s);
      const vv = `v_${s.names[1]}_${this.declSeq}`;
      this.declare(s.names[1], { name: s.names[1], js: vv, mode: 'loop', type: 'any', line: s.line }, s);
      this.emit(`if (${it} instanceof Map) { for (const [${iv}, ${vv}] of ${it}) {`);
      this.indent++;
      this.emit('R.loop();');
      const val = this.block(s.body, target !== null);
      if (target !== null && val !== null) this.emit(`${target} = ${val};`);
      this.indent--;
      this.emit(`} } else if (${it}) { for (let ${k} = 0; ${k} < ${it}.length; ${k}++) { const ${iv} = ${k}, ${vv} = ${it}[${k}];`);
      this.indent++;
      this.emit('R.loop();');
      // re-compile body in its own scope instance for the array branch
      this.pop();
      this.push();
      this.declare(s.names[0], { name: s.names[0], js: iv, mode: 'loop', type: 'num', line: s.line }, s);
      this.declare(s.names[1], { name: s.names[1], js: vv, mode: 'loop', type: 'any', line: s.line }, s);
      const val2 = this.block(s.body, target !== null);
      if (target !== null && val2 !== null) this.emit(`${target} = ${val2};`);
      this.indent--;
      this.emit('} }');
    } else {
      const vv = `v_${s.names[0]}_${this.declSeq}`;
      this.declare(s.names[0], { name: s.names[0], js: vv, mode: 'loop', type: 'any', line: s.line }, s);
      this.emit(`for (const ${vv} of (${it} || [])) {`);
      this.indent++;
      this.emit('R.loop();');
      const val = this.block(s.body, target !== null);
      if (target !== null && val !== null) this.emit(`${target} = ${val};`);
      this.indent--;
      this.emit('}');
    }
    this.pop();
    this.indent--;
    this.emit('}');
  }

  whileStmt(s: WhileStmt, target: string | null): void {
    this.emit(`while (${this.cond(s.test)}) {`);
    this.indent++;
    this.emit('R.loop();');
    this.push();
    const val = this.block(s.body, target !== null);
    if (target !== null && val !== null) this.emit(`${target} = ${val};`);
    this.pop();
    this.indent--;
    this.emit('}');
  }

  switchStmt(s: SwitchStmt, target: string | null): void {
    let subj: string | null = null;
    if (s.subject) {
      subj = this.tmp();
      this.emit(`{ const ${subj} = ${this.expr(s.subject).js};`);
    }
    let first = true;
    let hasDefault = false;
    for (const c of s.cases) {
      if (!c.test) {
        hasDefault = true;
        continue;
      }
      const test = subj ? `R.eq(${subj}, ${this.expr(c.test).js})` : this.cond(c.test);
      this.emit(`${first ? '' : '} else '}if (${test}) {`);
      first = false;
      this.branch(c.body, target);
    }
    const def = s.cases.find((c) => !c.test);
    if (hasDefault && def) {
      if (first) {
        this.emit('{');
      } else this.emit('} else {');
      this.branch(def.body, target);
      this.emit('}');
    } else if (!first) this.emit('}');
    if (subj) this.emit('}');
  }

  valueBlock(e: Expr, target: string): void {
    if (e.k === 'ifx') this.ifStmt(e.node, target);
    else if (e.k === 'switchx') this.switchStmt(e.node, target);
    else if (e.k === 'forx') {
      const n = e.node;
      if (n.k === 'for') this.forStmt(n, target);
      else if (n.k === 'forin') this.forInStmt(n, target);
      else this.whileStmt(n, target);
    }
  }

  /** Value block inside an expression: wrap in an IIFE. */
  iife(e: Expr): string {
    const save = this.out;
    const saveIndent = this.indent;
    this.out = [];
    this.indent = 1;
    const v = this.tmp();
    this.emit(`let ${v} = NaN;`);
    this.valueBlock(e, v);
    this.emit(`return ${v};`);
    const body = this.out.join('\n');
    this.out = save;
    this.indent = saveIndent;
    return `(() => {\n${body}\n})()`;
  }

  // ------------------------------------------------------------------ expressions

  expr(e: Expr, want?: Ret): { js: string; ret: Ret; plot?: number; hline?: number } {
    switch (e.k) {
      case 'num':
        return { js: String(e.v), ret: 'num' };
      case 'str':
        return { js: JSON.stringify(e.v), ret: 'str' };
      case 'bool':
        return { js: String(e.v), ret: 'bool' };
      case 'color':
        return { js: JSON.stringify(colorLit(e.v)), ret: 'color' };
      case 'tuple':
        return { js: `[${e.items.map((x) => this.expr(x).js).join(', ')}]`, ret: 'tuple' };
      case 'ifx':
      case 'switchx':
      case 'forx':
        return { js: this.iife(e), ret: 'any' };
      case 'id':
        return this.ident(e, want);
      case 'member':
        return this.member(e);
      case 'index':
        return this.index(e);
      case 'call':
        return this.call(e);
      case 'unary': {
        const a = this.expr(e.arg);
        if (e.op === 'not') return { js: `!${a.ret === 'bool' ? a.js : `R.bool(${a.js})`}`, ret: 'bool' };
        return { js: `(${e.op}${a.js})`, ret: 'num' };
      }
      case 'binary':
        return this.binary(e);
      case 'ternary': {
        const t = this.cond(e.test);
        const a = this.expr(e.then, want);
        const b = this.expr(e.else, want);
        let aj = a.js;
        let bj = b.js;
        // na in non-numeric branches
        if (e.then.k === 'id' && e.then.name === 'na' && b.ret !== 'num') aj = 'null';
        if (e.else.k === 'id' && e.else.name === 'na' && a.ret !== 'num') bj = 'null';
        return { js: `(${t} ? ${aj} : ${bj})`, ret: a.ret === b.ret ? a.ret : a.ret === 'num' || b.ret === 'num' ? 'num' : 'any' };
      }
    }
  }

  ident(e: Extract<Expr, { k: 'id' }>, want?: Ret): { js: string; ret: Ret; plot?: number; hline?: number } {
    const v = this.lookup(e.name);
    if (v) {
      let js = v.js;
      // global variables read from a function scope
      if (v.fn.isGlobal && !this.fn.isGlobal && v.mode === 'local') this.err(`Internal: global '${e.name}' not exported to functions`, e);
      if (v.fn.isGlobal && !this.fn.isGlobal && (v.mode === 'var' || v.mode === 'varip')) js = v.js.replace(/^ctx\./, 'R.root.');
      return { js, ret: v.type, plot: v.plotHandle, hline: v.hlineHandle };
    }
    if (!this.fn.isGlobal && this.globalsUsedInFns.has(e.name)) return { js: `G.v_${e.name}`, ret: 'any' };
    if (e.name === 'na') return { js: want && want !== 'num' && want !== 'any' ? 'null' : 'NaN', ret: 'num' };
    const bv = VARIABLES[e.name];
    if (bv) return { js: bv.js, ret: bv.ret };
    if (this.udts.has(e.name)) return { js: `U_${e.name}`, ret: 'obj' };
    if (this.enums.has(e.name)) return { js: `E_${e.name}`, ret: 'obj' };
    if (e.name === 'strategy' || e.name === 'ta' || e.name === 'math') this.err(`'${e.name}' is a namespace`, e);
    this.err(`Undeclared identifier '${e.name}'`, e);
  }

  fullName(e: Expr): string | null {
    if (e.k === 'id') return this.lookup(e.name) ? null : e.name;
    if (e.k === 'member') {
      const o = this.fullName(e.obj);
      return o ? `${o}.${e.prop}` : null;
    }
    return null;
  }

  member(e: Extract<Expr, { k: 'member' }>): { js: string; ret: Ret } {
    const full = this.fullName(e);
    if (full) {
      if (VARIABLES[full]) return { js: VARIABLES[full].js, ret: VARIABLES[full].ret };
      if (CONSTANTS[full]) return { js: CONSTANTS[full], ret: 'any' };
      if (full.startsWith('color.') && COLORS[e.prop]) return { js: JSON.stringify(COLORS[e.prop]), ret: 'color' };
      const ns = full.split('.')[0];
      if (this.enums.has(ns)) return { js: JSON.stringify(full), ret: 'str' };
      if (UNSUPPORTED[full]) this.err(`${full}: ${UNSUPPORTED[full]}`, e, 'unsupported');
      if (BUILTINS[full] || SPECIAL.has(full)) this.err(`'${full}' is a function — call it with parentheses`, e);
      this.err(`Unknown built-in '${full}'`, e, 'unsupported');
    }
    const o = this.expr(e.obj);
    return { js: `(${o.js})?.${e.prop}`, ret: 'any' };
  }

  index(e: Extract<Expr, { k: 'index' }>): { js: string; ret: Ret } {
    const n = this.expr(e.index);
    if (e.index.k === 'unary' && e.index.op === '-') this.err('History references with negative offsets are not allowed (that would read future values)', e);
    // built-in series: bar-indexed arrays
    const name = this.fullName(e.obj);
    const arrays: Record<string, string> = { open: 'O', high: 'H', low: 'L', close: 'C', volume: 'V', time: 'T', time_close: 'TC' };
    if (name && arrays[name]) return { js: `R.at(${arrays[name]}, ${n.js})`, ret: 'num' };
    if (name === 'bar_index') return { js: `(i - (${n.js}))`, ret: 'num' };
    if (name && VARIABLES[name] && ['hl2', 'hlc3', 'ohlc4', 'hlcc4'].includes(name)) {
      const f = { hl2: '(R.at(H,k)+R.at(L,k))/2', hlc3: '(R.at(H,k)+R.at(L,k)+R.at(C,k))/3', ohlc4: '(R.at(O,k)+R.at(H,k)+R.at(L,k)+R.at(C,k))/4', hlcc4: '(R.at(H,k)+R.at(L,k)+2*R.at(C,k))/4' }[name]!;
      return { js: `((k) => ${f})(${n.js})`, ret: 'num' };
    }
    if (e.obj.k === 'id' && !this.fn.isGlobal && !this.lookup(e.obj.name) && this.globalsUsedInFns.has(e.obj.name)) {
      this.globalHist.set(e.obj.name, null);
      return { js: `R.root.s[\u0004GH:${e.obj.name}\u0004].get(${n.js})`, ret: 'any' };
    }
    if (e.obj.k === 'id') {
      const v = this.lookup(e.obj.name);
      if (v) {
        if (e.index.k === 'num' && e.index.v === 0) return { js: v.js, ret: v.type };
        if (v.histSlot === undefined) {
          v.obj = v.type !== 'num';
          v.histSlot = v.obj ? v.fn.obj++ : v.fn.num++;
        }
        return { js: `${this.seriesRef(v)}.get(${n.js})`, ret: v.type };
      }
    }
    // expression history: per-execution temp series in the current scope
    const val = this.expr(e.obj);
    const isNum = val.ret === 'num' || val.ret === 'bool';
    const slot = isNum ? this.fn.num++ : this.fn.obj++;
    const ref = isNum ? `ctx.s[${slot}]` : `ctx.s[${this.fn.token}+${slot}]`;
    return { js: `R.histN(${ref}, ${val.js}, ${n.js})`, ret: val.ret };
  }

  binary(e: Extract<Expr, { k: 'binary' }>): { js: string; ret: Ret } {
    const a = this.expr(e.left);
    const b = this.expr(e.right);
    const num = (a.ret === 'num' || a.ret === 'bool') && (b.ret === 'num' || b.ret === 'bool');
    switch (e.op) {
      case '+':
        if (num) return { js: `(${a.js} + ${b.js})`, ret: 'num' };
        if (a.ret === 'str' || b.ret === 'str') return { js: `R.add(${a.js}, ${b.js})`, ret: 'str' };
        return { js: `R.add(${a.js}, ${b.js})`, ret: 'any' };
      case '-':
        return { js: `(${a.js} - ${b.js})`, ret: 'num' };
      case '*':
        return { js: `(${a.js} * ${b.js})`, ret: 'num' };
      case '/':
        return { js: `R.div(${a.js}, ${b.js})`, ret: 'num' };
      case '%':
        return { js: `R.mod(${a.js}, ${b.js})`, ret: 'num' };
      case '<':
      case '>':
      case '<=':
      case '>=':
        return { js: `(${a.js} ${e.op} ${b.js})`, ret: 'bool' };
      case '==':
        if (e.right.k === 'id' && e.right.name === 'na') this.warn(e, 'Comparing with na using == is always false in Pine; use na(x) instead.', 'compat');
        return { js: num ? `(${a.js} === ${b.js})` : `R.eq(${a.js}, ${b.js})`, ret: 'bool' };
      case '!=':
        return { js: num ? `(${a.js} !== ${b.js})` : `!R.eq(${a.js}, ${b.js})`, ret: 'bool' };
      case 'and':
        // Pine v6 evaluates lazily, earlier versions evaluate both operands
        return { js: this.version >= 6 ? `(${this.boolJs(a)} && ${this.boolJs(b)})` : `R.and(${this.boolJs(a)}, ${this.boolJs(b)})`, ret: 'bool' };
      case 'or':
        return { js: this.version >= 6 ? `(${this.boolJs(a)} || ${this.boolJs(b)})` : `R.or(${this.boolJs(a)}, ${this.boolJs(b)})`, ret: 'bool' };
    }
    this.err(`Unsupported operator ${e.op}`, e);
  }

  boolJs(r: { js: string; ret: Ret }): string {
    return r.ret === 'bool' ? r.js : `R.bool(${r.js})`;
  }

  warn(node: { line: number }, message: string, kind: CompiledPine['warnings'][number]['kind']): void {
    if (!this.warnings.some((w) => w.line === node.line && w.message === message)) this.warnings.push({ line: node.line, message, kind });
  }

  // ------------------------------------------------------------------ calls

  /** Map positional + named args to a parameter list. */
  mapArgs(args: Arg[], params: string[], node: Expr): (Expr | undefined)[] {
    if (params[params.length - 1] === '...') {
      const fixed = params.slice(0, -1);
      const out: (Expr | undefined)[] = [];
      args.forEach((a, k) => {
        if (a.name) {
          const j = fixed.indexOf(a.name);
          if (j < 0) this.err(`Unknown argument '${a.name}'`, node);
          out[j] = a.value;
        } else out[k] = a.value;
      });
      return out;
    }
    const out: (Expr | undefined)[] = new Array(params.length).fill(undefined);
    let pos = 0;
    for (const a of args) {
      if (a.name) {
        const j = params.indexOf(a.name);
        if (j < 0) this.err(`Unknown argument '${a.name}' (expected one of: ${params.join(', ')})`, node);
        out[j] = a.value;
      } else {
        if (pos >= params.length) this.err(`Too many arguments (expected at most ${params.length})`, node);
        out[pos++] = a.value;
      }
    }
    return out;
  }

  /** Compile-time evaluation of literal-ish arguments. */
  /**
   * True when every bar-data series inside `e` is read with a constant offset >= 1 (e.g.
   * close[1], ta.ema(close[1], n)), which makes lookahead_on safe (no future values).
   */
  offsetSafe(e: Expr, shifted: boolean, depth: number): boolean {
    if (depth > 30) return false;
    switch (e.k) {
      case 'num':
      case 'str':
      case 'bool':
      case 'color':
        return true;
      case 'id': {
        if (BAR_SERIES.has(e.name)) return shifted;
        const init = this.staticInits.get(e.name);
        if (init && !this.reassigned.has(e.name)) return this.offsetSafe(init, shifted, depth + 1);
        return false;
      }
      case 'member':
        return e.obj.k === 'id' && (e.obj.name === 'syminfo' || e.obj.name === 'timeframe' || e.obj.name === 'color' || e.obj.name === 'math');
      case 'index': {
        const off = this.constEval(e.index);
        if (typeof off === 'number' && off >= 1) return this.offsetSafe(e.obj, true, depth + 1);
        return this.offsetSafe(e.obj, shifted, depth + 1) && this.offsetSafe(e.index, shifted, depth + 1);
      }
      case 'call':
        if (e.callee.k === 'member' && e.callee.obj.k === 'id' && e.callee.obj.name === 'input') return true;
        return e.args.every((a) => this.offsetSafe(a.value, shifted, depth + 1));
      case 'unary':
        return this.offsetSafe(e.arg, shifted, depth + 1);
      case 'binary':
        return this.offsetSafe(e.left, shifted, depth + 1) && this.offsetSafe(e.right, shifted, depth + 1);
      case 'ternary':
        return this.offsetSafe(e.test, shifted, depth + 1) && this.offsetSafe(e.then, shifted, depth + 1) && this.offsetSafe(e.else, shifted, depth + 1);
      default:
        return false;
    }
  }

  constEval(e: Expr | undefined): unknown {
    if (!e) return undefined;
    switch (e.k) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'bool':
        return e.v;
      case 'color':
        return colorLit(e.v);
      case 'unary': {
        const v = this.constEval(e.arg);
        if (typeof v === 'number') return e.op === '-' ? -v : v;
        if (e.op === 'not' && typeof v === 'boolean') return !v;
        return undefined;
      }
      case 'binary': {
        const a = this.constEval(e.left);
        const b = this.constEval(e.right);
        if (typeof a === 'number' && typeof b === 'number') {
          switch (e.op) {
            case '+':
              return a + b;
            case '-':
              return a - b;
            case '*':
              return a * b;
            case '/':
              return b ? a / b : undefined;
          }
        }
        if (e.op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
        return undefined;
      }
      case 'id':
        if (e.name === 'na') return NaN;
        return undefined;
      case 'member': {
        const full = this.fullName(e);
        if (!full) return undefined;
        if (CONSTANTS[full]) return JSON.parse(CONSTANTS[full]);
        if (full.startsWith('color.') && COLORS[e.prop]) return COLORS[e.prop];
        return undefined;
      }
      case 'call': {
        const name = this.fullName(e.callee);
        if (name === 'color.new') {
          const [c, t] = e.args.map((a) => this.constEval(a.value));
          if (typeof c === 'string' && typeof t === 'number') {
            const h = c.slice(1, 7);
            return `#${h}${Math.round((1 - t / 100) * 255).toString(16).padStart(2, '0')}`;
          }
        }
        if (name === 'color.rgb') {
          const [r, g, b, t = 0] = e.args.map((a) => this.constEval(a.value)) as number[];
          if ([r, g, b, t].every((x) => typeof x === 'number')) return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}${Math.round((1 - t / 100) * 255).toString(16).padStart(2, '0')}`;
        }
        return undefined;
      }
    }
    return undefined;
  }

  constJs(e: Expr): string {
    return this.expr(e).js;
  }

  call(e: Extract<Expr, { k: 'call' }>): { js: string; ret: Ret; plot?: number; hline?: number } {
    let name = this.fullName(e.callee);
    // method call on a value: x.method(args)
    if (!name && e.callee.k === 'member') {
      const m = e.callee.prop;
      const objE = e.callee.obj;
      // user methods first
      const user = [...this.fns.values()].find((f) => f.def.isMethod && f.def.name === m);
      if (user) {
        const args = [{ value: objE } as Arg, ...e.args];
        return this.userCall(user, args, e);
      }
      // UDT constructors via variable alias are not supported; built-in methods dispatch at runtime
      const obj = this.expr(objE);
      const argsJs = e.args.map((a) => this.expr(a.value).js);
      if (m === 'new' && obj.ret === 'obj') return { js: `${obj.js}.new(${argsJs.join(', ')})`, ret: 'obj' };
      return { js: `B.method(R, ${obj.js}, ${JSON.stringify(m)}, [${argsJs.join(', ')}])`, ret: 'any' };
    }
    if (!name) this.err('Unsupported call expression', e);
    // UDT / enum constructors
    const parts = name.split('.');
    if (parts.length === 2 && this.udts.has(parts[0])) {
      const t = this.udts.get(parts[0])!;
      if (parts[1] === 'new') {
        const mapped = this.mapArgs(e.args, t.fields.map((f) => f.name), e);
        return { js: `U_${parts[0]}.new(${mapped.map((a) => (a ? this.expr(a).js : 'undefined')).join(', ')})`, ret: 'obj' };
      }
      if (parts[1] === 'copy') return { js: `U_${parts[0]}.copy(${this.expr(e.args[0].value).js})`, ret: 'obj' };
    }
    // user function
    const uf = this.fns.get(name);
    if (uf && !uf.def.isMethod) return this.userCall(uf, e.args, e);
    // generics: array.new<float>(...) / map.new<k,v>()
    if (name === 'array.new' || name === 'map.new' || name === 'matrix.new') {
      if (name === 'matrix.new') this.err(`matrix.new: ${UNSUPPORTED['matrix.new']}`, e, 'unsupported');
    }
    if (UNSUPPORTED[name]) this.err(`${name}: ${UNSUPPORTED[name]}`, e, 'unsupported');
    if (name.startsWith('strategy.risk.')) {
      this.warn(e, `${name} is not supported and is ignored (risk-management rules are not simulated).`, 'compat');
      return { js: 'undefined', ret: 'void' };
    }
    if (name.startsWith('strategy.closedtrades.') || name.startsWith('strategy.opentrades.')) {
      const [, kind, field] = name.split('.');
      const argJs = e.args.map((a) => this.expr(a.value).js);
      return { js: `B.strat.trade(R, ${JSON.stringify(kind)}, ${JSON.stringify(field)}, ${argJs.join(', ') || '0'})`, ret: 'num' };
    }
    if (SPECIAL.has(name)) return this.special(name, e);
    const spec = BUILTINS[name];
    if (!spec) {
      if (name.startsWith('request.')) this.err(`${name} is not supported`, e, 'unsupported');
      this.err(`Unknown function '${name}'`, e, 'unsupported');
    }
    return this.builtinCall(spec, e, name);
  }

  builtinCall(spec: Spec, e: Extract<Expr, { k: 'call' }>, name: string): { js: string; ret: Ret } {
    let params = spec.params;
    let fill: Record<string, string> = {};
    const positional = e.args.filter((a) => !a.name).length;
    if (spec.short && positional === spec.short.argc && !e.args.some((a) => a.name && Object.keys(spec.short!.fill).includes(a.name))) {
      fill = spec.short.fill;
      params = params.filter((p) => !(p in fill));
    }
    let argJs: string[];
    if (params[params.length - 1] === '...') {
      const fixed = params.slice(0, -1);
      const named = e.args.filter((a) => a.name);
      const pos = e.args.filter((a) => !a.name);
      argJs = [...fixed.map((p, k) => {
        const n = named.find((a) => a.name === p);
        const v = n ? n.value : pos[k]?.value;
        return v ? this.expr(v).js : 'undefined';
      }), ...pos.slice(fixed.length).map((a) => this.expr(a.value).js)];
    } else {
      const mapped = this.mapArgs(e.args, params, e);
      argJs = spec.params.map((p) => {
        if (p in fill) return fill[p];
        const k = params.indexOf(p);
        const a = mapped[k];
        return a ? this.expr(a).js : 'undefined';
      });
      while (argJs.length && argJs[argJs.length - 1] === 'undefined') argJs.pop();
    }
    if (name === 'request.security') this.err('internal', e);
    let js: string;
    if (spec.mode === 'state') js = `${spec.impl}(R.state(ctx, ${this.fn.states++}), R${argJs.length ? `, ${argJs.join(', ')}` : ''})`;
    else if (spec.mode === 'rt') js = `${spec.impl}(R${argJs.length ? `, ${argJs.join(', ')}` : ''})`;
    else js = `${spec.impl}(${argJs.join(', ')})`;
    return { js, ret: spec.ret };
  }

  userCall(f: { def: FuncDef; scope: FnScope; js: string; paramNames: string[] }, args: Arg[], e: Expr): { js: string; ret: Ret } {
    const mapped = this.mapArgs(args, f.paramNames, e);
    for (let k = 0; k < f.def.params.length; k++) if (!mapped[k] && !f.def.params[k].def) this.err(`Missing argument '${f.def.params[k].name}' for ${f.def.name}()`, e);
    const slot = this.fn.children++;
    const sc = f.scope;
    const child = `R.child(ctx, ${slot}, ${sc.token}, \u0003O${sc.token}, \u0003V${sc.token})`;
    const argJs = mapped.map((a) => (a ? this.expr(a).js : 'undefined'));
    return { js: `${f.js}(${child}${argJs.length ? `, ${argJs.join(', ')}` : ''})`, ret: 'any' };
  }

  // ------------------------------------------------------------------ special functions

  special(name: string, e: Extract<Expr, { k: 'call' }>): { js: string; ret: Ret; plot?: number; hline?: number } {
    const P = (params: string) => this.mapArgs(e.args, params.split(','), e);
    const ev = (x: Expr | undefined) => (x ? this.expr(x).js : 'undefined');
    switch (name) {
      case 'indicator':
      case 'study':
      case 'strategy':
      case 'library': {
        if (!this.fn.isGlobal) this.err(`${name}() must be called at the top level`, e);
        if (name === 'library') this.err('Libraries cannot be run directly. Copy the functions into an indicator or strategy.', e, 'unsupported');
        const params = name === 'strategy' ? 'title,shorttitle,overlay,format,precision,scale,pyramiding,calc_on_order_fills,calc_on_every_tick,max_bars_back,backtest_fill_limits_assumption,default_qty_type,default_qty_value,initial_capital,currency,slippage,commission_type,commission_value,process_orders_on_close,close_entries_rule,margin_long,margin_short,explicit_plot_zorder,max_lines_count,max_labels_count,max_boxes_count,calc_bars_count,risk_free_rate,use_bar_magnifier,fill_orders_on_standard_ohlc,max_polylines_count,dynamic_requests,behind_chart' : 'title,shorttitle,overlay,format,precision,scale,max_bars_back,timeframe,timeframe_gaps,explicit_plot_zorder,max_lines_count,max_labels_count,max_boxes_count,calc_bars_count,max_polylines_count,dynamic_requests,behind_chart';
        const list = params.split(',');
        const mapped = this.mapArgs(e.args, list, e);
        const vals: Record<string, unknown> = {};
        list.forEach((p, k) => {
          if (mapped[k] !== undefined) vals[p] = this.constEval(mapped[k]);
        });
        this.meta = {
          type: name === 'strategy' ? 'strategy' : 'indicator',
          title: String(vals.title ?? 'Script'),
          shortTitle: String(vals.shorttitle ?? vals.title ?? 'Script'),
          overlay: !!vals.overlay,
          precision: vals.precision as number | undefined,
          format: vals.format as string | undefined,
          maxLabels: vals.max_labels_count as number | undefined,
          maxLines: vals.max_lines_count as number | undefined,
          maxBoxes: vals.max_boxes_count as number | undefined,
          strategy: name === 'strategy' ? vals : undefined,
        };
        if (name === 'strategy') this.usesStrategy = true;
        if (vals.timeframe) this.warn(e, 'The indicator() timeframe parameter is not supported; the chart timeframe is used.', 'compat');
        return { js: 'undefined', ret: 'void' };
      }
      case 'plot': {
        const [series, title, color, linewidth, style, trackprice, histbase, offset, join, editable, show_last, display, format, precision] = P('series,title,color,linewidth,style,trackprice,histbase,offset,join,editable,show_last,display,format,precision,force_overlay');
        void join;
        void editable;
        void show_last;
        const idx = this.plots.length;
        const cConst = this.constEval(color);
        const dynamic = color !== undefined && cConst === undefined;
        const disp = this.constEval(display);
        const p: PlotStatic = {
          id: `plot${idx}`,
          index: idx,
          kind: 'plot',
          title: String(this.constEval(title) ?? `Plot ${idx + 1}`),
          color: typeof cConst === 'string' ? cConst : undefined,
          colorDynamic: dynamic,
          style: String(this.constEval(style) ?? 'style_line'),
          width: Number(this.constEval(linewidth) ?? 1),
          offset: Number(this.constEval(offset) ?? 0),
          histbase: Number(this.constEval(histbase) ?? 0),
          display: disp !== 'none',
          trackPrice: !!this.constEval(trackprice),
          format: this.constEval(format) as string | undefined,
          precision: this.constEval(precision) as number | undefined,
        };
        this.plots.push(p);
        return { js: `B.out.plot(R, ${idx}, ${ev(series)}${dynamic ? `, ${ev(color)}` : ''})`, ret: 'num', plot: idx };
      }
      case 'plotshape':
      case 'plotchar':
      case 'plotarrow': {
        const params =
          name === 'plotshape'
            ? 'series,title,style,location,color,offset,text,textcolor,editable,size,show_last,display,format,precision,force_overlay'
            : name === 'plotchar'
              ? 'series,title,char,location,color,offset,text,textcolor,editable,size,show_last,display,format,precision,force_overlay'
              : 'series,title,colorup,colordown,offset,minheight,maxheight,editable,show_last,display,format,precision,force_overlay';
        const list = params.split(',');
        const m = this.mapArgs(e.args, list, e);
        const get = (k: string) => m[list.indexOf(k)];
        const idx = this.plots.length;
        const color = get('color');
        const cConst = this.constEval(color);
        const dynamic = color !== undefined && cConst === undefined;
        const p: PlotStatic = {
          id: `plot${idx}`,
          index: idx,
          kind: name === 'plotshape' ? 'shape' : name === 'plotchar' ? 'char' : 'arrow',
          title: String(this.constEval(get('title')) ?? `Shape ${idx + 1}`),
          color: typeof cConst === 'string' ? cConst : name === 'plotarrow' ? undefined : '#2196F3ff',
          colorDynamic: dynamic,
          style: String(this.constEval(get('style')) ?? (name === 'plotchar' ? 'char' : name === 'plotarrow' ? 'arrow' : 'xcross')),
          width: 1,
          offset: Number(this.constEval(get('offset')) ?? 0),
          histbase: 0,
          display: this.constEval(get('display')) !== 'none',
          trackPrice: false,
          location: String(this.constEval(get('location')) ?? 'abovebar'),
          text: this.constEval(get('text')) as string | undefined,
          char: this.constEval(get('char')) as string | undefined,
          textColor: this.constEval(get('textcolor')) as string | undefined,
          size: String(this.constEval(get('size')) ?? 'auto'),
          colorup: (this.constEval(get('colorup')) as string) || '#089981ff',
          colordown: (this.constEval(get('colordown')) as string) || '#F23645ff',
        };
        this.plots.push(p);
        return { js: `B.out.plot(R, ${idx}, ${ev(get('series'))}${dynamic ? `, ${ev(color)}` : ''})`, ret: 'num', plot: idx };
      }
      case 'plotcandle':
      case 'plotbar': {
        const list = 'open,high,low,close,title,color,wickcolor,editable,show_last,bordercolor,display,format,precision,force_overlay'.split(',');
        const m = this.mapArgs(e.args, list, e);
        const get = (k: string) => m[list.indexOf(k)];
        const idx = this.plots.length;
        const color = get('color');
        const cConst = this.constEval(color);
        const dynamic = color !== undefined && cConst === undefined;
        this.plots.push({ id: `plot${idx}`, index: idx, kind: name === 'plotcandle' ? 'candle' : 'bar', title: String(this.constEval(get('title')) ?? 'Candles'), color: typeof cConst === 'string' ? cConst : undefined, colorDynamic: dynamic, style: 'candle', width: 1, offset: 0, histbase: 0, display: true, trackPrice: false });
        return { js: `B.out.candle(R, ${idx}, ${ev(get('open'))}, ${ev(get('high'))}, ${ev(get('low'))}, ${ev(get('close'))}${dynamic ? `, ${ev(color)}` : ''})`, ret: 'void' };
      }
      case 'hline': {
        const [price, title, color, linestyle, linewidth, editable, display] = P('price,title,color,linestyle,linewidth,editable,display');
        void editable;
        const idx = this.hlines.length;
        const pc = this.constEval(price);
        this.hlines.push({
          id: `hline${idx}`,
          index: idx,
          title: String(this.constEval(title) ?? `Line ${idx + 1}`),
          price: typeof pc === 'number' ? pc : null,
          color: String(this.constEval(color) ?? '#787B86ff'),
          style: String(this.constEval(linestyle) ?? 'style_dashed').replace('style_', ''),
          width: Number(this.constEval(linewidth) ?? 1),
          display: this.constEval(display) !== 'none',
        });
        const js = typeof pc === 'number' ? 'undefined' : `B.out.hline(R, ${idx}, ${ev(price)})`;
        return { js, ret: 'void', hline: idx };
      }
      case 'fill': {
        const list = 'hline1,hline2,color,title,editable,show_last,fillgaps,display,top_value,bottom_value,top_color,bottom_color'.split(',');
        const positional = e.args.filter((a) => !a.name);
        // fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color) gradient form
        const gradient = positional.length >= 6 || e.args.some((a) => a.name === 'top_color');
        const m = this.mapArgs(gradient ? e.args.map((a, k) => (a.name ? a : k === 2 ? { name: 'top_value', value: a.value } : k === 3 ? { name: 'bottom_value', value: a.value } : k === 4 ? { name: 'top_color', value: a.value } : k === 5 ? { name: 'bottom_color', value: a.value } : a)) : e.args, list, e);
        const ref = (x: Expr | undefined): string => {
          if (!x) this.err('fill() needs two plots or hlines', e);
          const r = this.expr(x);
          if (r.plot !== undefined) return `plot${r.plot}`;
          if (r.hline !== undefined) return `hline${r.hline}`;
          this.err('fill() arguments must be values returned by plot() or hline()', e);
        };
        const a = ref(m[0]);
        const b = ref(m[1]);
        const idx = this.fills.length;
        let color = m[2];
        if (gradient) color = m[10];
        const cConst = this.constEval(color);
        const dynamic = color !== undefined && cConst === undefined;
        this.fills.push({ index: idx, a, b, color: typeof cConst === 'string' ? cConst : '#2196F333', colorDynamic: dynamic, title: String(this.constEval(m[3]) ?? 'Fill') });
        if (gradient) this.warn(e, 'Gradient fills are drawn with their top color.', 'compat');
        return { js: dynamic ? `B.out.fill(R, ${idx}, ${ev(color)})` : 'undefined', ret: 'void' };
      }
      case 'bgcolor': {
        const [color, offset] = P('color,offset,editable,show_last,title,display,force_overlay');
        void offset;
        return { js: `B.out.bg(R, ${ev(color)})`, ret: 'void' };
      }
      case 'barcolor': {
        const [color] = P('color,offset,editable,show_last,title,display');
        return { js: `B.out.barcolor(R, ${ev(color)})`, ret: 'void' };
      }
      case 'alertcondition': {
        const [cond, title, message] = P('condition,title,message');
        const idx = this.alertconds.length;
        this.alertconds.push({ index: idx, title: String(this.constEval(title) ?? `Alert ${idx + 1}`), message: String(this.constEval(message) ?? '') });
        return { js: `B.out.alertcond(R, ${idx}, ${ev(cond)})`, ret: 'void' };
      }
      case 'request.security':
      case 'request.security_lower_tf': {
        const [symbol, timeframe, expression, gaps, lookahead] = P(name === 'request.security' ? 'symbol,timeframe,expression,gaps,lookahead,ignore_invalid_symbol,currency,calc_bars_count' : 'symbol,timeframe,expression,ignore_invalid_symbol,currency,ignore_invalid_timeframe,calc_bars_count');
        const site = this.security.length;
        const la = name === 'request.security' ? this.constEval(lookahead) === 'lookahead_on' : false;
        const gp = name === 'request.security' ? this.constEval(gaps) === 'gaps_on' : false;
        const inlineStatic = (x: Expr, depth = 0): Expr => {
          if (depth > 8) return x;
          if (x.k === 'id' && this.staticInits.has(x.name)) {
            this.staticUsed.set(x.name, x.line);
            return inlineStatic(this.staticInits.get(x.name)!, depth + 1);
          }
          if (x.k === 'binary') return { ...x, left: inlineStatic(x.left, depth + 1), right: inlineStatic(x.right, depth + 1) };
          if (x.k === 'ternary') return { ...x, test: inlineStatic(x.test, depth + 1), then: inlineStatic(x.then, depth + 1), else: inlineStatic(x.else, depth + 1) };
          return x;
        };
        const staticJs = (x0: Expr | undefined, what: string) => {
          if (!x0) this.err(`request.security: missing ${what}`, e);
          const x = inlineStatic(x0);
          const r = this.expr(x);
          if (/\b(i|ctx|G|O|H|L|C|V|T|TC)\b/.test(r.js.replace(/R\.inputs\[[^\]]+\]/g, '').replace(/"[^"]*"/g, ''))) this.err(`request.security: the ${what} must be a constant, an input or syminfo/timeframe value`, x);
          return r.js;
        };
        this.security.push({ site, symJs: staticJs(symbol, 'symbol'), tfJs: staticJs(timeframe, 'timeframe'), lookahead: la, gaps: gp, lowerTf: name === 'request.security_lower_tf', line: e.line });
        if (la) {
          const usesOffset = !!expression && this.offsetSafe(expression, false, 0);
          if (!usesOffset) this.warn(e, 'Lookahead: request.security with lookahead=barmerge.lookahead_on returns higher-timeframe values before that bar has closed on historical bars (future data leak). Use expression[1] with lookahead_on, or lookahead_off.', 'lookahead');
        } else if (name === 'request.security') this.warn(e, 'Repainting: on the realtime bar request.security returns the still-forming higher-timeframe value, so historical and realtime values can differ.', 'repaint');
        return { js: `B.security(R, ${site}, ${ev(expression)})`, ret: 'any' };
      }
      case 'input':
      case 'input.int':
      case 'input.float':
      case 'input.bool':
      case 'input.string':
      case 'input.color':
      case 'input.source':
      case 'input.timeframe':
      case 'input.symbol':
      case 'input.session':
      case 'input.price':
      case 'input.time':
      case 'input.text_area':
      case 'input.enum':
        return this.input(name, e);
      case 'strategy.entry':
      case 'strategy.order': {
        this.usesStrategy = true;
        const [id, direction, qty, limit, stop, oca_name, oca_type, comment] = P('id,direction,qty,limit,stop,oca_name,oca_type,comment,alert_message,disable_alert');
        return { js: `B.strat.entry(R, ${JSON.stringify(name === 'strategy.entry' ? 'entry' : 'order')}, ${ev(id)}, ${ev(direction)}, ${ev(qty)}, ${ev(limit)}, ${ev(stop)}, ${ev(oca_name)}, ${ev(oca_type)}, ${ev(comment)})`, ret: 'void' };
      }
      case 'strategy.exit': {
        this.usesStrategy = true;
        const list = 'id,from_entry,qty,qty_percent,profit,limit,loss,stop,trail_price,trail_points,trail_offset,oca_name,comment,comment_profit,comment_loss,comment_trailing,alert_message,alert_profit,alert_loss,alert_trailing,disable_alert'.split(',');
        const m = this.mapArgs(e.args, list, e);
        const get = (k: string) => ev(m[list.indexOf(k)]);
        return { js: `B.strat.exit(R, ${get('id')}, ${get('from_entry')}, ${get('qty')}, ${get('qty_percent')}, ${get('profit')}, ${get('limit')}, ${get('loss')}, ${get('stop')}, ${get('trail_price')}, ${get('trail_points')}, ${get('trail_offset')}, ${get('oca_name')}, ${get('comment')})`, ret: 'void' };
      }
      case 'strategy.close': {
        this.usesStrategy = true;
        const [id, comment, qty, qty_percent, , immediately] = P('id,comment,qty,qty_percent,alert_message,immediately,disable_alert');
        return { js: `B.strat.close(R, ${ev(id)}, ${ev(comment)}, ${ev(qty)}, ${ev(qty_percent)}, ${ev(immediately)})`, ret: 'void' };
      }
      case 'strategy.close_all': {
        this.usesStrategy = true;
        const [comment, , immediately] = P('comment,alert_message,immediately,disable_alert');
        return { js: `B.strat.close(R, undefined, ${ev(comment)}, undefined, undefined, ${ev(immediately)})`, ret: 'void' };
      }
      case 'strategy.cancel': {
        const [id] = P('id');
        return { js: `B.strat.cancel(R, ${ev(id)})`, ret: 'void' };
      }
      case 'strategy.cancel_all':
        return { js: 'B.strat.cancel(R)', ret: 'void' };
    }
    this.err(`Unsupported function ${name}`, e, 'unsupported');
  }

  /** compiled input() calls by AST node: re-compiling the same call (static inlining) must not register a second input */
  inputCache = new Map<Expr, { js: string; ret: Ret }>();

  input(name: string, e: Extract<Expr, { k: 'call' }>): { js: string; ret: Ret } {
    const hit = this.inputCache.get(e);
    if (hit) return hit;
    const r = this.inputImpl(name, e);
    this.inputCache.set(e, r);
    return r;
  }

  inputImpl(name: string, e: Extract<Expr, { k: 'call' }>): { js: string; ret: Ret } {
    const params = name === 'input' ? 'defval,title,type,minval,maxval,confirm,step,tooltip,inline,group,options,display' : name === 'input.enum' || name === 'input.string' || name === 'input.int' || name === 'input.float' ? 'defval,title,options,minval,maxval,step,tooltip,inline,group,confirm,display' : 'defval,title,tooltip,inline,group,confirm,display,options';
    const list = params.split(',');
    // input.int(defval, title, minval, maxval, step, ...) overload without options
    let m = this.mapArgs(e.args, list, e);
    if ((name === 'input.int' || name === 'input.float') && e.args.filter((a) => !a.name).length >= 3 && !e.args.some((a) => a.name === 'options')) {
      const l2 = 'defval,title,minval,maxval,step,tooltip,inline,group,confirm,display'.split(',');
      const m2 = this.mapArgs(e.args, l2, e);
      m = list.map((p) => m2[l2.indexOf(p)]);
    }
    const get = (k: string) => m[list.indexOf(k)];
    const defE = get('defval');
    if (!defE) this.err('input() requires a default value', e);
    let defval = this.constEval(defE);
    let type: InputDef['type'];
    switch (name) {
      case 'input.int':
        type = 'int';
        break;
      case 'input.float':
      case 'input.price':
        type = 'float';
        break;
      case 'input.bool':
        type = 'bool';
        break;
      case 'input.color':
        type = 'color';
        break;
      case 'input.source':
        type = 'source';
        break;
      case 'input.timeframe':
        type = 'timeframe';
        break;
      case 'input.symbol':
        type = 'symbol';
        break;
      case 'input.session':
        type = 'session';
        break;
      case 'input.time':
        type = 'time';
        break;
      case 'input.text_area':
        type = 'text_area';
        break;
      case 'input.enum':
        type = 'enum';
        break;
      case 'input.string':
        type = 'string';
        break;
      default: {
        const t = this.constEval(get('type'));
        if (defE.k === 'id' || (defE.k === 'member' && !this.constEval(defE))) type = 'source';
        else if (typeof defval === 'boolean') type = 'bool';
        else if (typeof defval === 'string') type = defval.startsWith('#') ? 'color' : 'string';
        else type = t === 'integer' || (defE.k === 'num' && defE.isInt) ? 'int' : 'float';
      }
    }
    if (type === 'source') {
      const srcName = defE.k === 'id' ? defE.name : defE.k === 'member' ? this.fullName(defE) : String(defval ?? 'close');
      defval = srcName;
    }
    if (type === 'enum' && defE.k === 'member') defval = this.fullName(defE);
    if (defval === undefined) this.err('input() default value must be a constant', defE);
    const idx = this.inputs.length;
    const key = `in${idx}`;
    const optsE = get('options');
    let options: unknown[] | undefined;
    if (optsE && optsE.k === 'tuple') options = optsE.items.map((x) => (x.k === 'member' ? this.fullName(x) : this.constEval(x)));
    if (type === 'enum') {
      const en = String(defval).split('.')[0];
      options = (this.enums.get(en) || []).map((m2) => `${en}.${m2.name}`);
    }
    this.inputs.push({
      key,
      index: idx,
      type,
      title: String(this.constEval(get('title')) ?? `Input ${idx + 1}`),
      defval,
      min: this.constEval(get('minval')) as number | undefined,
      max: this.constEval(get('maxval')) as number | undefined,
      step: this.constEval(get('step')) as number | undefined,
      options,
      tooltip: this.constEval(get('tooltip')) as string | undefined,
      group: this.constEval(get('group')) as string | undefined,
      inline: this.constEval(get('inline')) as string | undefined,
      line: e.line,
    });
    const dv = JSON.stringify(defval);
    switch (type) {
      case 'int':
        return { js: `B.inInt(R, ${JSON.stringify(key)}, ${dv})`, ret: 'num' };
      case 'float':
        return { js: `B.inFloat(R, ${JSON.stringify(key)}, ${dv})`, ret: 'num' };
      case 'bool':
        return { js: `B.inBool(R, ${JSON.stringify(key)}, ${dv})`, ret: 'bool' };
      case 'source':
        return { js: `B.src(R, B.inAny(R, ${JSON.stringify(key)}, ${dv}), i)`, ret: 'num' };
      case 'color':
        return { js: `B.inAny(R, ${JSON.stringify(key)}, ${dv})`, ret: 'color' };
      case 'time':
        return { js: `B.inFloat(R, ${JSON.stringify(key)}, ${dv})`, ret: 'num' };
      default:
        return { js: `B.inAny(R, ${JSON.stringify(key)}, ${dv})`, ret: 'str' };
    }
  }
}

export { PineError };
