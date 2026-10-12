# @name Python: RSI Dip Buyer with Brackets
# @category Python
# @description Buys RSI dips in an uptrend with an ATR stop-loss and take-profit attached to every entry.
from fufu import *


@strategy("Python RSI Dip Buyer", initial_capital=10000, default_qty_type="percent_of_equity", default_qty_value=50, commission=0.001)
class RsiDip(Strategy):
    rsi_len = input.int(14, "RSI length", min=2)
    oversold = input.int(30, "Oversold", min=1, max=50)
    trend_len = input.int(200, "Trend SMA", min=2)
    sl_atr = input.float(2.0, "Stop (ATR)", step=0.1)
    tp_atr = input.float(3.0, "Target (ATR)", step=0.1)

    def init(self):
        c = self.data.close
        self.rsi = self.I(ta.rsi(c, self.rsi_len), "RSI", plot=False)
        self.trend = self.I(ta.sma(c, self.trend_len), "Trend", color=color.orange)
        self.atr = self.I(ta.atr(14), "ATR", plot=False)

    def next(self):
        if self.position:
            return
        price = self.data.close[-1]
        if price > self.trend.last and crossunder(self.rsi, self.oversold):
            a = self.atr.last
            self.buy(sl=price - self.sl_atr * a, tp=price + self.tp_atr * a)
