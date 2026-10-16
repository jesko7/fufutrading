# @name Python: Cumulative Volume Delta
# @category Volume
# @description Exact volume delta from Binance's taker volume: market buys minus market sells per bar and their running total (CVD), optionally reset every UTC day. Charts elsewhere estimate this from candle colors; Binance klines carry the real taker split.
from fufu import *


@indicator("Cumulative Volume Delta", short_title="CVD", overlay=False, precision=2)
def main(data, mode=input.string("CVD", "Show", options=["CVD", "Delta per bar"]), reset_daily=input.bool(True, "Reset every day (UTC)")):
    buy = data.taker_buy_volume
    # market buys minus market sells, in the base asset
    delta = 2 * buy - data.volume
    if mode == "Delta per bar":
        colors = [color.new(color.teal, 30) if d >= 0 else color.new(color.red, 30) for d in np.nan_to_num(delta)]
        plot(delta, "Delta", color=colors, style="columns")
    else:
        cs = np.cumsum(np.nan_to_num(delta))
        if reset_daily and len(cs):
            day = np.floor(data.time / 86400000)
            starts = np.flatnonzero(np.concatenate([[True], day[1:] != day[:-1]]))
            # subtract the running total before each day's first bar
            base = cs[starts] - np.nan_to_num(delta)[starts]
            cs = cs - np.repeat(base, np.diff(np.append(starts, len(cs))))
        plot(cs, "CVD", color=color.blue, width=2)
    hline(0, "Zero", color=color.gray)
