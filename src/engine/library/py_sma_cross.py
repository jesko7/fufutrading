# @name Python: SMA Cross Strategy
# @category Python
# @description Class-based strategy: indicators precomputed in init(), decisions in next() (no lookahead possible).
from fufu import *


@strategy("Python SMA Cross", initial_capital=10000, default_qty_type="percent_of_equity", default_qty_value=100, commission=0.001)
class SmaCross(Strategy):
    fast = input.int(20, "Fast length", min=1)
    slow = input.int(50, "Slow length", min=2)
    allow_short = input.bool(False, "Allow shorts")

    def init(self):
        close = self.data.close
        self.f = self.I(ta.sma(close, self.fast), "Fast", color=color.teal)
        self.s = self.I(ta.sma(close, self.slow), "Slow", color=color.orange)

    def next(self):
        if crossover(self.f, self.s):
            self.entry("Long", long)
        elif crossunder(self.f, self.s):
            if self.allow_short:
                self.entry("Short", short)
            else:
                self.close("Long")
