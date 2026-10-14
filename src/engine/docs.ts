/**
 * Reference text generated from the engine itself (so it never drifts from what actually runs):
 * the Pine Script built-ins, variables and unsupported features. Used by the AI tools and the
 * written documentation.
 */
import { BUILTINS, SPECIAL, UNSUPPORTED, VARIABLES } from './pine/builtins/registry';

/** Pine built-ins grouped by namespace with their parameter names. */
export function pineFunctionReference(): string {
  const groups = new Map<string, string[]>();
  const add = (name: string, sig: string) => {
    const ns = name.includes('.') ? name.split('.')[0] : 'core';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns)!.push(sig);
  };
  for (const [name, spec] of Object.entries(BUILTINS)) add(name, `${name}(${spec.params.join(', ')})`);
  for (const name of SPECIAL) if (!BUILTINS[name]) add(name, `${name}(…)`);
  const order = ['core', 'ta', 'math', 'str', 'array', 'map', 'color', 'input', 'request', 'strategy', 'label', 'line', 'box', 'table', 'log', 'timeframe', 'syminfo'];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const lines: string[] = ['# Supported Pine Script built-ins (generated from the engine)', ''];
  for (const k of keys) {
    lines.push(`## ${k === 'core' ? 'Core functions' : `${k}.*`}`);
    lines.push(groups.get(k)!.sort().join('\n'));
    lines.push('');
  }
  lines.push('## Built-in variables');
  lines.push(Object.keys(VARIABLES).sort().join(', '));
  lines.push('');
  lines.push('## Not supported (compile error with this reason)');
  for (const [k, v] of Object.entries(UNSUPPORTED)) lines.push(`- ${k}: ${v}`);
  lines.push('- import of TradingView libraries: paste the functions into the script instead.');
  lines.push('- Anything not listed above is reported as "Unknown built-in" at compile time — never silently ignored.');
  return lines.join('\n');
}
