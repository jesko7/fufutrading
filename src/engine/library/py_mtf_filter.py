# @name Python: Multi-Timeframe Trend Filter
# @category Python
# @description Trades chart-timeframe EMA crosses only in the direction of the 4h trend (HTF values without lookahead).
from fufu import *


@strategy("Python MTF Trend", initial_capital=10000, default_qty_type="percent_of_equity", default_qty_value=100, commission=0.001)
class MtfTrend(Strategy):
    htf = input.timeframe("4h", "Trend timeframe")
    htf_len = input.int(50, "Trend EMA length", min=2)
    fast = input.int(9, "Fast EMA", min=1)
    slow = input.int(21, "Slow EMA", min=2)

    def init(self):
        c = self.data.close
        htf_close = self.data.htf(self.htf, "close")
        # EMA over the higher-timeframe series as seen from each chart bar (no future values)
        self.trend = self.I(ta.ema(np.nan_to_num(htf_close, nan=c[0]), self.htf_len), "HTF trend", color=color.purple)
        self.f = self.I(ta.ema(c, self.fast), "Fast", color=color.teal)
        self.s = self.I(ta.ema(c, self.slow), "Slow", color=color.orange)

    def next(self):
        up = self.data.close[-1] > self.trend.last
        if crossover(self.f, self.s) and up:
            self.entry("Long", long)
        elif crossunder(self.f, self.s):
            self.close("Long")
