/** Starting points for new scripts. */

export interface Template {
  id: string;
  label: string;
  language: 'pine' | 'python';
  description: string;
  code: string;
}

export const TEMPLATES: Template[] = [
  {
    id: 'pine-indicator',
    label: 'Pine indicator',
    language: 'pine',
    description: 'Overlay indicator with inputs and a plot',
    code: `//@version=6
indicator("My indicator", overlay=true)

length = input.int(20, "Length", minval=1)
src = input.source(close, "Source")

basis = ta.ema(src, length)
plot(basis, "Basis", color=color.blue, linewidth=2)
`,
  },
  {
    id: 'pine-oscillator',
    label: 'Pine oscillator',
    language: 'pine',
    description: 'Separate pane with levels and an alert',
    code: `//@version=6
indicator("My oscillator", overlay=false, precision=2)

length = input.int(14, "Length", minval=1)
upper = input.float(70, "Upper level")
lower = input.float(30, "Lower level")

value = ta.rsi(close, length)
plot(value, "Value", color=#7E57C2)
hline(upper, "Upper", color=color.gray)
hline(lower, "Lower", color=color.gray)

alertcondition(ta.crossover(value, upper), "Crossed above upper", "Value crossed above the upper level")
`,
  },
  {
    id: 'pine-strategy',
    label: 'Pine strategy',
    language: 'pine',
    description: 'Entries, exits, stop-loss and take-profit',
    code: `//@version=6
strategy("My strategy", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100, commission_type=strategy.commission.percent, commission_value=0.1)

fastLen = input.int(20, "Fast EMA", minval=1)
slowLen = input.int(50, "Slow EMA", minval=2)
stopPct = input.float(2.0, "Stop loss %", minval=0.1, step=0.1)
takePct = input.float(4.0, "Take profit %", minval=0.1, step=0.1)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "Fast", color=color.teal)
plot(slow, "Slow", color=color.orange)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)

if strategy.position_size > 0
    entry = strategy.position_avg_price
    strategy.exit("Exit", "Long", stop=entry * (1 - stopPct / 100), limit=entry * (1 + takePct / 100))

if ta.crossunder(fast, slow)
    strategy.close("Long")
`,
  },
  {
    id: 'py-indicator',
    label: 'Python indicator',
    language: 'python',
    description: 'NumPy indicator: arrays in, plots out',
    code: `from fufu import *


@indicator("My Python indicator", overlay=True)
def main(data, length=input.int(20, "Length", min=1), src=input.source("close")):
    # src is a numpy array of the chosen source; ta.* matches Pine exactly
    basis = ta.ema(src, length)
    dev = ta.stdev(src, length)
    plot(basis, "Basis", color=color.blue, width=2)
    plot(basis + 2 * dev, "Upper", color=color.gray)
    plot(basis - 2 * dev, "Lower", color=color.gray)
`,
  },
  {
    id: 'py-strategy',
    label: 'Python strategy',
    language: 'python',
    description: 'init() precomputes, next() decides — no lookahead possible',
    code: `from fufu import *


@strategy("My Python strategy", initial_capital=10000, default_qty_type="percent_of_equity", default_qty_value=100, commission=0.001)
class MyStrategy(Strategy):
    fast = input.int(20, "Fast EMA", min=1)
    slow = input.int(50, "Slow EMA", min=2)
    stop_pct = input.float(2.0, "Stop loss %", step=0.1)

    def init(self):
        close = self.data.close
        self.f = self.I(ta.ema(close, self.fast), "Fast", color=color.teal)
        self.s = self.I(ta.ema(close, self.slow), "Slow", color=color.orange)

    def next(self):
        # inside next() every series ends at the current bar: [-1] = now, [-2] = previous bar
        price = self.data.close[-1]
        if crossover(self.f, self.s) and not self.position:
            self.buy(sl=price * (1 - self.stop_pct / 100))
        elif crossunder(self.f, self.s):
            self.close_all()
`,
  },
];
