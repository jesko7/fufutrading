"""
Host-side glue for running user Python scripts inside FuFu (called from JavaScript).
Not part of the public API.
"""
from __future__ import annotations

import inspect
import sys
import traceback
import types

import numpy as np

import fufu
from fufu import _ctx, _Input, Bars

SCRIPT_FILE = '<script>'


class ScriptError(Exception):
    def __init__(self, message, line=None, kind='python', tb=''):
        super().__init__(message)
        self.line = line
        self.kind = kind
        self.tb = tb


def _err_payload(e: BaseException):
    if isinstance(e, ScriptError):
        return dict(message=str(e), line=e.line, kind=e.kind, traceback=e.tb)
    line = None
    if isinstance(e, SyntaxError):
        return dict(message=f'SyntaxError: {e.msg}', line=e.lineno, col=e.offset, kind='syntax', traceback='')
    tb = traceback.extract_tb(e.__traceback__)
    for fr in reversed(tb):
        if fr.filename == SCRIPT_FILE:
            line = fr.lineno
            break
    lines = [l for l in traceback.format_exception(type(e), e, e.__traceback__)]
    # keep only frames from the user's script to make the traceback readable
    user = [l for l in lines if SCRIPT_FILE in l or not l.startswith('  File')]
    return dict(message=f'{type(e).__name__}: {e}', line=line, kind='python', traceback=''.join(user)[-4000:])


def _load(code: str):
    """Execute the user module and return the declared target."""
    fufu._declared.clear()
    fufu._Input._seq = 0
    _ctx.outputs = {}
    _ctx.need = set()
    mod = types.ModuleType('user_script')
    mod.__dict__['__file__'] = SCRIPT_FILE
    compiled = compile(code, SCRIPT_FILE, 'exec')
    exec('from fufu import *', mod.__dict__)
    exec(compiled, mod.__dict__)
    decls = list(fufu._declared)
    if not decls:
        raise ScriptError('No @indicator function or @strategy class found. Decorate your main function with @indicator("Name") or your Strategy subclass with @strategy("Name").', kind='compile')
    return decls[-1], mod


def _inputs_of(decl):
    out = []
    if decl.kind == 'indicator':
        sig = inspect.signature(decl.target)
        params = list(sig.parameters.values())[1:]
        for p in params:
            d = p.default
            if isinstance(d, _Input):
                out.append((p.name, d))
            elif d is not inspect.Parameter.empty and isinstance(d, (int, float, bool, str)):
                t = 'bool' if isinstance(d, bool) else 'int' if isinstance(d, int) else 'float' if isinstance(d, float) else 'string'
                out.append((p.name, _Input(t, d, p.name)))
    else:
        items = []
        for klass in reversed(decl.target.__mro__):
            for k, v in vars(klass).items():
                if isinstance(v, _Input):
                    items.append((v.order, k, v))
        seen = set()
        for _, k, v in sorted(items):
            if k in seen:
                continue
            seen.add(k)
            out.append((k, v))
    return out


def analyze(code: str):
    try:
        decl, _ = _load(code)
        ins = _inputs_of(decl)
        return dict(ok=True, meta=dict(type=decl.kind, title=decl.title, shortTitle=decl.short_title, overlay=decl.overlay, precision=decl.precision, scale=list(decl.scale) if decl.scale else None, options=decl.options), inputs=[i.describe(k) for k, i in ins])
    except BaseException as e:  # noqa: BLE001
        return dict(ok=False, error=_err_payload(e))


def _np(v):
    if hasattr(v, 'to_py'):
        v = v.to_py()
    if isinstance(v, (memoryview, bytes, bytearray)):
        return np.frombuffer(v, dtype=np.float64).copy()
    return np.asarray(v, dtype=np.float64)


def _bars(cols: dict, meta: dict) -> Bars:
    conv = {k: _np(v) for k, v in (cols.to_py() if hasattr(cols, 'to_py') else cols).items()}
    m = meta.to_py() if hasattr(meta, 'to_py') else dict(meta)
    m['htf'] = {key: {k: _np(v) for k, v in d.items()} for key, d in (m.get('htf') or {}).items()}
    return Bars(conv, m)


def _params(ins, values):
    v = values.to_py() if hasattr(values, 'to_py') else dict(values or {})
    out = {}
    for k, inp in ins:
        out[k] = inp.coerce(v.get(k))
    return out


def _resolve_sources(params, ins, data: Bars):
    for k, inp in ins:
        if inp.type == 'source' and isinstance(params[k], str):
            params[k] = data[params[k]]
    return params


def _pack_outputs():
    o = _ctx.outputs
    res = dict(plots=[], hlines=o.get('hlines', []), fills=o.get('fills', []), bgcolors=o.get('bgcolors'), barcolors=o.get('barcolors'), alerts=[], logs=o.get('logs', []))
    for p in o.get('plots', []):
        q = dict(p)
        q['values'] = np.ascontiguousarray(p['values'], dtype=np.float64).tobytes()
        res['plots'].append(q)
    for a in o.get('alerts', []):
        res['alerts'].append(dict(title=a['title'], message=a['message'], values=np.ascontiguousarray(a['values'], dtype=np.float64).tobytes()))
    return res


def run_indicator(code: str, cols, meta, input_values):
    try:
        decl, _ = _load(code)
        if decl.kind != 'indicator':
            raise ScriptError('This script is a strategy. Run it in the Strategy Tester or add it to a chart as a strategy.', kind='compile')
        data = _bars(cols, meta)
        _ctx.data = data
        _ctx.n = len(data._cols['close'])
        _ctx.i = -1
        ins = _inputs_of(decl)
        params = _resolve_sources(_params(ins, input_values), ins, data)
        decl.target(data, **params)
        return dict(ok=True, outputs=_pack_outputs(), need=sorted(_ctx.need))
    except BaseException as e:  # noqa: BLE001
        return dict(ok=False, error=_err_payload(e), outputs=_pack_outputs(), need=sorted(_ctx.need))


class _StrategyRun:
    """Holds a strategy instance while JavaScript drives the bar loop."""

    def __init__(self, code, cols, meta, input_values, broker):
        decl, _ = _load(code)
        if decl.kind != 'strategy':
            raise ScriptError('This script is an indicator, not a strategy.', kind='compile')
        self.decl = decl
        self.data = _bars(cols, meta)
        _ctx.data = self.data
        _ctx.n = len(self.data._cols['close'])
        _ctx.i = -1
        ins = _inputs_of(decl)
        params = _resolve_sources(_params(ins, input_values), ins, self.data)
        self.strat = decl.target(self.data, params, broker)
        self.strat.init()
        # plot registered indicators (full arrays: visual only)
        for v, title, show, color in self.strat._indicators:
            if show:
                fufu.plot(v._arr, title or v.name, color=color)

    def step(self, i: int):
        _ctx.i = int(i)
        self.strat._state = None
        self.strat.next()

    def finish(self):
        _ctx.i = -1
        out = _pack_outputs()
        out['need'] = sorted(_ctx.need)
        return out


def start_strategy(code, cols, meta, input_values, broker):
    try:
        run = _StrategyRun(code, cols, meta, input_values, broker)
        return dict(ok=True, run=run, need=sorted(_ctx.need))
    except BaseException as e:  # noqa: BLE001
        return dict(ok=False, error=_err_payload(e), need=sorted(_ctx.need))


def strategy_options(code):
    decl, _ = _load(code)
    return decl.options


def step_strategy(run: _StrategyRun, i: int):
    try:
        run.step(i)
        return None
    except BaseException as e:  # noqa: BLE001
        _ctx.i = -1
        return _err_payload(e)


# ------------------------------------------------------------------ debugger


class Debugger:
    """sys.settrace debugger for the user's script. `pause(info)` blocks in the host until resumed."""

    def __init__(self, pause_fn, breakpoints=(), break_on_next=False):
        self.pause_fn = pause_fn
        self.breakpoints = set(int(b) for b in breakpoints)
        self.mode = 'run'  # run | step | over | out
        self.break_on_next = break_on_next
        self.depth = 0
        self.target_depth = 0
        self.stopped = False

    def set_breakpoints(self, lines):
        self.breakpoints = set(int(b) for b in lines)

    def _snapshot(self, frame):
        def r(v):
            try:
                if isinstance(v, np.ndarray):
                    tail = v[-5:]
                    return f'ndarray(shape={v.shape}) …{np.array2string(tail, precision=4)}'
                if isinstance(v, fufu.SeriesView):
                    return f'Series[{len(v)}] last={v.last:.6g}' if len(v) else 'Series[0]'
                s = repr(v)
                return s if len(s) < 200 else s[:200] + '…'
            except Exception:  # noqa: BLE001
                return '<unreprable>'

        loc = {k: r(v) for k, v in frame.f_locals.items() if not k.startswith('__') and not inspect.ismodule(v) and not inspect.isclass(v) and not inspect.isfunction(v)}
        if 'self' in frame.f_locals and isinstance(frame.f_locals['self'], fufu.Strategy):
            st = frame.f_locals['self']
            try:
                loc['self.position'] = repr(st.position)
                loc['self.equity'] = f'{st.equity:.2f}'
            except Exception:  # noqa: BLE001
                pass
        stack = []
        f = frame
        while f is not None:
            if f.f_code.co_filename == SCRIPT_FILE:
                stack.append(dict(fn=f.f_code.co_name, line=f.f_lineno))
            f = f.f_back
        return dict(line=frame.f_lineno, fn=frame.f_code.co_name, bar=_ctx.i, locals=loc, stack=stack)

    def _pause(self, frame, reason):
        cmd = self.pause_fn(self._snapshot(frame), reason)
        cmd = str(cmd)
        if cmd == 'stop':
            self.stopped = True
            raise ScriptError('Debugging stopped', kind='python')
        if cmd in ('step', 'over', 'out'):
            self.mode = cmd
            self.target_depth = self.depth
        else:
            self.mode = 'run'

    def trace(self, frame, event, arg):
        if frame.f_code.co_filename != SCRIPT_FILE:
            return self.trace
        if event == 'call':
            self.depth += 1
            if self.break_on_next and frame.f_code.co_name == 'next':
                self.mode = 'step'
                self.target_depth = 0
        elif event == 'return':
            self.depth -= 1
        elif event == 'line':
            hit = frame.f_lineno in self.breakpoints
            if hit:
                self._pause(frame, 'breakpoint')
            elif self.mode == 'step':
                self._pause(frame, 'step')
            elif self.mode == 'over' and self.depth <= self.target_depth:
                self._pause(frame, 'step')
            elif self.mode == 'out' and self.depth < self.target_depth:
                self._pause(frame, 'step')
        return self.trace

    def install(self):
        sys.settrace(self.trace)

    def uninstall(self):
        sys.settrace(None)
