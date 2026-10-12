/** Pine Script abstract syntax tree. */

export interface Pos {
  line: number;
  col: number;
}

export interface TypeRef {
  name: string; // int, float, bool, string, color, label, line, box, table, array, map, matrix, UDT name...
  args?: TypeRef[];
  qualifier?: 'series' | 'simple' | 'const' | 'input';
  isArray?: boolean; // legacy float[] syntax
}

export type Expr =
  | ({ k: 'num'; v: number; isInt: boolean } & Pos)
  | ({ k: 'str'; v: string } & Pos)
  | ({ k: 'bool'; v: boolean } & Pos)
  | ({ k: 'color'; v: string } & Pos)
  | ({ k: 'id'; name: string } & Pos)
  | ({ k: 'member'; obj: Expr; prop: string } & Pos)
  | ({ k: 'call'; callee: Expr; args: Arg[]; generics?: TypeRef[]; id: number } & Pos)
  | ({ k: 'index'; obj: Expr; index: Expr; id: number } & Pos)
  | ({ k: 'unary'; op: string; arg: Expr } & Pos)
  | ({ k: 'binary'; op: string; left: Expr; right: Expr } & Pos)
  | ({ k: 'ternary'; test: Expr; then: Expr; else: Expr } & Pos)
  | ({ k: 'tuple'; items: Expr[] } & Pos)
  | ({ k: 'ifx'; node: IfStmt } & Pos)
  | ({ k: 'switchx'; node: SwitchStmt } & Pos)
  | ({ k: 'forx'; node: ForStmt | ForInStmt | WhileStmt } & Pos);

export interface Arg {
  name?: string;
  value: Expr;
}

export interface Param {
  name: string;
  type?: TypeRef;
  def?: Expr;
}

export type Stmt =
  | ({ k: 'decl'; mode: 'normal' | 'var' | 'varip'; type?: TypeRef; name: string; value: Expr; id: number } & Pos)
  | ({ k: 'tupledecl'; names: string[]; value: Expr; id: number } & Pos)
  | ({ k: 'assign'; target: Expr; op: string; value: Expr } & Pos)
  | ({ k: 'expr'; e: Expr } & Pos)
  | IfStmt
  | ForStmt
  | ForInStmt
  | WhileStmt
  | SwitchStmt
  | ({ k: 'break' } & Pos)
  | ({ k: 'continue' } & Pos)
  | FuncDef
  | ({ k: 'typedef'; name: string; fields: { name: string; type: TypeRef; def?: Expr }[]; exported: boolean } & Pos)
  | ({ k: 'enumdef'; name: string; members: { name: string; title?: string }[] } & Pos)
  | ({ k: 'import'; path: string; alias: string } & Pos);

export interface IfStmt extends Pos {
  k: 'if';
  test: Expr;
  then: Stmt[];
  elifs: { test: Expr; body: Stmt[] }[];
  else?: Stmt[];
}

export interface ForStmt extends Pos {
  k: 'for';
  name: string;
  from: Expr;
  to: Expr;
  step?: Expr;
  body: Stmt[];
}

export interface ForInStmt extends Pos {
  k: 'forin';
  names: string[];
  iter: Expr;
  body: Stmt[];
}

export interface WhileStmt extends Pos {
  k: 'while';
  test: Expr;
  body: Stmt[];
}

export interface SwitchStmt extends Pos {
  k: 'switch';
  subject?: Expr;
  cases: { test?: Expr; body: Stmt[] }[];
}

export interface FuncDef extends Pos {
  k: 'func';
  name: string;
  params: Param[];
  body: Stmt[];
  isMethod: boolean;
  exported: boolean;
}

export interface Program {
  body: Stmt[];
  version: number | null;
  annotations: Record<string, string>;
}
