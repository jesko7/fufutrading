/**
 * Compatibility corpus: community-style scripts and broad built-in sweeps that TradingView users
 * paste into the editor. Every script must compile and run without errors on plain candles.
 */
import { describe, it, expect } from 'vitest';
import { runPine, compileCached, securityRequests } from '../../src/engine/pine';
import { parseTimeframe, tfDurationMs } from '../../src/shared/timeframes';
import type { BarSeries, RunContext } from '../../src/engine/types';

const MIN = 60000;
function bars(n: number): BarSeries {
  const t = new Float64Array(n);
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  const tc = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i++) {
    t[i] = Date.UTC(2026, 0, 5) + i * 15 * MIN;
    tc[i] = t[i] + 15 * MIN;
    o[i] = p;
    p = p * (1 + Math.sin(i / 9) * 0.004 + Math.cos(i / 23) * 0.003);
    c[i] = p;
    h[i] = Math.max(o[i], c[i]) * (1 + 0.002 + (i % 4) * 0.0005);
    l[i] = Math.min(o[i], c[i]) * (1 - 0.002 - (i % 3) * 0.0005);
    v[i] = 100 + (i % 11) * 13;
  }
  return { t, o, h, l, c, v, tc, length: n };
}

const ctx: RunContext = { symbol: 'BTCUSDT', market: 'spot', tf: '15', chartType: 'candles', mintick: 0.01, base: 'BTC', quote: 'USDT' };

export const CORPUS: Record<string, string> = {
  'Fair value gaps with boxes (v5)': `//@version=5
indicator("FVG", overlay=true, max_boxes_count=500, max_labels_count=100)
thresh = input.float(0.0, "Threshold %", minval=0, step=0.1) / 100
extendBars = input.int(20, "Extend")
showMit = input.bool(true, "Remove mitigated")
bullCol = input.color(color.new(color.teal, 70), "Bullish")
bearCol = input.color(color.new(color.red, 70), "Bearish")
type FVG
    float top
    float btm
    bool bull
    box bx
var fvgs = array.new<FVG>()
bullGap = low > high[2] and close[1] > high[2] and (low - high[2]) / high[2] > thresh
bearGap = high < low[2] and close[1] < low[2] and (low[2] - high) / high > thresh
if bullGap
    fvgs.unshift(FVG.new(low, high[2], true, box.new(bar_index - 2, low, bar_index + extendBars, high[2], border_color=na, bgcolor=bullCol)))
if bearGap
    fvgs.unshift(FVG.new(low[2], high, false, box.new(bar_index - 2, low[2], bar_index + extendBars, high, border_color=na, bgcolor=bearCol)))
if fvgs.size() > 0
    for i = fvgs.size() - 1 to 0
        f = fvgs.get(i)
        f.bx.set_right(bar_index + extendBars)
        mitigated = f.bull ? close < f.btm : close > f.top
        if mitigated and showMit
            f.bx.delete()
            fvgs.remove(i)
while fvgs.size() > 50
    fvgs.pop().bx.delete()
plot(fvgs.size(), "open gaps", display=display.data_window)`,

  'Pivot liquidity lines (v5)': `//@version=5
indicator("Liquidity swings", overlay=true, max_lines_count=500, max_labels_count=500)
len = input.int(14, "Pivot lookback", minval=1)
area = input.string("Wick Extremity", "Swing area", options=["Wick Extremity", "Full Range"])
ph = ta.pivothigh(len, len)
pl = ta.pivotlow(len, len)
var line phLine = na
var label phLbl = na
var float phTop = na
var int phCount = 0
if not na(ph)
    phTop := high[len]
    phCount := 0
    phLine := line.new(bar_index - len, phTop, bar_index, phTop, color=color.red, width=1)
    phLbl := label.new(bar_index - len, phTop, "", style=label.style_label_down, color=color.new(color.red, 100), textcolor=color.red, size=size.small)
else if not na(phLine)
    line.set_x2(phLine, bar_index)
    if high > phTop
        phCount += 1
        label.set_text(phLbl, str.tostring(phCount))
var float plBtm = na
if not na(pl)
    plBtm := area == "Wick Extremity" ? low[len] : math.min(close[len], open[len])
    line.new(bar_index - len, plBtm, bar_index + 1, plBtm, color=color.teal, style=line.style_dashed, extend=extend.right)
plot(phTop, "swing high", color.red, style=plot.style_stepline)
plot(plBtm, "swing low", color.teal, style=plot.style_stepline)
alertcondition(ta.crossover(high, phTop), "Swing high swept", "High swept")`,

  'Session levels and anchored VWAP (v5)': `//@version=5
indicator("Sessions", overlay=true)
sess = input.session("0800-1600", "London")
tz = input.string("UTC", "Timezone")
inSess = not na(time(timeframe.period, sess, tz))
newDay = ta.change(time("D")) != 0
var float sHigh = na
var float sLow = na
if inSess and not inSess[1]
    sHigh := high
    sLow := low
else if inSess
    sHigh := math.max(sHigh, high)
    sLow := math.min(sLow, low)
plot(sHigh, "session high", color.orange, style=plot.style_linebr)
plot(sLow, "session low", color.orange, style=plot.style_linebr)
[vw, upper, lower] = ta.vwap(hlc3, newDay, 2)
plot(vw, "vwap", color.purple)
p1 = plot(upper, "upper", color.new(color.purple, 50))
p2 = plot(lower, "lower", color.new(color.purple, 50))
fill(p1, p2, color.new(color.purple, 92), "band")
t0 = timestamp("UTC", year, month, dayofmonth, 0, 0)
plot((time - t0) / 60000, "minutes into day", display=display.data_window)
ltfCloses = request.security_lower_tf(syminfo.tickerid, "1", close)
plot(array.size(ltfCloses) > 0 ? array.avg(ltfCloses) : na, "ltf avg", display=display.none)
rows = 24
var prof = array.new_float(rows, 0)
hi = ta.highest(high, 100)
lo = ta.lowest(low, 100)
if barstate.islast and hi > lo
    for k = 0 to 99
        idx = math.min(rows - 1, math.floor((close[k] - lo) / (hi - lo) * rows))
        array.set(prof, idx, array.get(prof, idx) + volume[k])
plot(array.max(prof), "profile max", display=display.data_window)
bgcolor(inSess ? color.new(color.blue, 94) : na)
barcolor(newDay ? color.yellow : na)`,

  'CM Williams Vix Fix (v3)': `//@version=3
study("CM_Williams_Vix_Fix Finds Market Bottoms", overlay=false, shorttitle="CM_WVF")
pd = input(22, title="LookBack Period Standard Deviation High")
bbl = input(20, title="Bolinger Band Length")
mult = input(2.0    , minval=1, maxval=5, title="Bollinger Band Standard Devaition Up")
lb = input(50  , title="Look Back Period Percentile High")
ph = input(.85, title="Highest Percentile - 0.90=90%, 0.95=95%, 0.99=99%")
pl = input(1.01, title="Lowest Percentile - 1.10=90%, 1.05=95%, 1.01=99%")
hp = input(false, title="Show High Range - Based on Percentile and LookBack Period?")
sd = input(false, title="Show Standard Deviation Line?", type=bool)
len = input(14, type=integer, title="Length")
res = input("D", type=resolution, title="Resolution")
wvf = ((highest(close, pd)-low)/(highest(close, pd)))*100
sDev = mult * stdev(wvf, bbl)
midLine = sma(wvf, bbl)
lowerBand = midLine - sDev
upperBand = midLine + sDev
rangeHigh = (highest(wvf, lb)) * ph
rangeLow = (lowest(wvf, lb)) * pl
col = wvf >= upperBand or wvf >= rangeHigh ? lime : gray
plot(hp and rangeHigh ? rangeHigh : na, title="Range High Percentile", style=line, linewidth=4, color=orange)
plot(hp and rangeLow ? rangeLow : na, title="Range Low Percentile", style=line, linewidth=4, color=orange)
plot(wvf, title="Williams Vix Fix", style=histogram, linewidth = 4, color=col)
plot(sd and upperBand ? upperBand : na, title="Upper Band", style=line, linewidth = 3, color=aqua)
bgcolor(n % 50 == 0 ? silver : na, transp=80)
plot(security(tickerid, period, close) - close, title="Same TF", color=blue)`,

  'Squeeze Momentum (v4)': `//@version=4
study(shorttitle = "SQZMOM_LB", title="Squeeze Momentum Indicator [LazyBear]", overlay=false)
length = input(20, title="BB Length")
mult = input(2.0,title="BB MultFactor")
lengthKC=input(20, title="KC Length")
multKC = input(1.5, title="KC MultFactor")
useTrueRange = input(true, title="Use TrueRange (KC)", type=input.bool)
source = close
basis = sma(source, length)
dev = multKC * stdev(source, length)
upperBB = basis + dev
lowerBB = basis - dev
ma = sma(source, lengthKC)
range = useTrueRange ? tr : (high - low)
rangema = sma(range, lengthKC)
upperKC = ma + rangema * multKC
lowerKC = ma - rangema * multKC
sqzOn  = (lowerBB > lowerKC) and (upperBB < upperKC)
sqzOff = (lowerBB < lowerKC) and (upperBB > upperKC)
noSqz  = (sqzOn == false) and (sqzOff == false)
val = linreg(source  -  avg(avg(highest(high, lengthKC), lowest(low, lengthKC)),sma(close,lengthKC)), lengthKC,0)
bcolor = iff( val > 0, iff( val > nz(val[1]), color.lime, color.green), iff( val < nz(val[1]), color.red, color.maroon))
scolor = noSqz ? color.blue : sqzOn ? color.black : color.gray
plot(val, color=bcolor, style=plot.style_histogram, linewidth=4)
plot(0, color=scolor, style=plot.style_cross, linewidth=2)`,

  'SuperTrend (v4)': `//@version=4
study("Supertrend", overlay = true, format=format.price, precision=2, resolution="")
Periods = input(title="ATR Period", type=input.integer, defval=10)
src = input(hl2, title="Source")
Multiplier = input(title="ATR Multiplier", type=input.float, step=0.1, defval=3.0)
changeATR= input(title="Change ATR Calculation Method ?", type=input.bool, defval=true)
showsignals = input(title="Show Buy/Sell Signals ?", type=input.bool, defval=true)
highlighting = input(title="Highlighter On/Off ?", type=input.bool, defval=true)
atr2 = sma(tr, Periods)
atr= changeATR ? atr(Periods) : atr2
up=src-(Multiplier*atr)
up1 = nz(up[1],up)
up := close[1] > up1 ? max(up,up1) : up
dn=src+(Multiplier*atr)
dn1 = nz(dn[1], dn)
dn := close[1] < dn1 ? min(dn, dn1) : dn
trend = 1
trend := nz(trend[1], trend)
trend := trend == -1 and close > dn1 ? 1 : trend == 1 and close < up1 ? -1 : trend
upPlot = plot(trend == 1 ? up : na, title="Up Trend", style=plot.style_linebr, linewidth=2, color=color.green)
buySignal = trend == 1 and trend[1] == -1
plotshape(buySignal ? up : na, title="UpTrend Begins", location=location.absolute, style=shape.circle, size=size.tiny, color=color.green, transp=0)
plotshape(buySignal and showsignals ? up : na, title="Buy", text="Buy", location=location.absolute, style=shape.labelup, size=size.tiny, color=color.green, textcolor=color.white, transp=0)
dnPlot = plot(trend == 1 ? na : dn, title="Down Trend", style=plot.style_linebr, linewidth=2, color=color.red)
sellSignal = trend == -1 and trend[1] == 1
plotshape(sellSignal ? dn : na, title="DownTrend Begins", location=location.absolute, style=shape.circle, size=size.tiny, color=color.red, transp=0)
mPlot = plot(ohlc4, title="", style=plot.style_circles, linewidth=0)
longFillColor = highlighting ? (trend == 1 ? color.green : color.white) : color.white
shortFillColor = highlighting ? (trend == -1 ? color.red : color.white) : color.white
fill(mPlot, upPlot, title="UpTrend Highligter", color=longFillColor)
fill(mPlot, dnPlot, title="DownTrend Highligter", color=shortFillColor)
alertcondition(buySignal, title="SuperTrend Buy", message="SuperTrend Buy!")
alertcondition(sellSignal, title="SuperTrend Sell", message="SuperTrend Sell!")
changeCond = trend != trend[1]
alertcondition(changeCond, title="SuperTrend Direction Change", message="SuperTrend has changed direction!")`,

  'WaveTrend (v4)': `//@version=4
study(title="WaveTrend [LazyBear]", shorttitle="WT_LB")
n1 = input(10, "Channel Length")
n2 = input(21, "Average Length")
obLevel1 = input(60, "Over Bought Level 1")
osLevel1 = input(-60, "Over Sold Level 1")
ap = hlc3
esa = ema(ap, n1)
d = ema(abs(ap - esa), n1)
ci = (ap - esa) / (0.015 * d)
tci = ema(ci, n2)
wt1 = tci
wt2 = sma(wt1,4)
plot(0, color=color.gray)
plot(obLevel1, color=color.red)
plot(osLevel1, color=color.green)
plot(wt1, color=color.green)
plot(wt2, color=color.red, style=plot.style_circles)
plot(wt1-wt2, color=color.blue, style=plot.style_area, transp=80)
plot(cross(wt1, wt2) ? wt2 : na, color = color.black , style = plot.style_circles, linewidth = 3)
barcolor(cross(wt1, wt2) ? (wt2 - wt1 > 0 ? color.aqua : color.yellow) : na)`,

  'UT Bot Alerts (v4)': `//@version=4
study(title="UT Bot Alerts", overlay = true)
a = input(1,     title = "Key Vaule. 'This changes the sensitivity'")
c = input(10,    title = "ATR Period")
h = input(false, title = "Signals from Heikin Ashi Candles")
xATR  = atr(c)
nLoss = a * xATR
src = h ? security(heikinashi(syminfo.tickerid), timeframe.period, close, lookahead = false) : close
xATRTrailingStop = 0.0
xATRTrailingStop := iff(src > nz(xATRTrailingStop[1], 0) and src[1] > nz(xATRTrailingStop[1], 0), max(nz(xATRTrailingStop[1]), src - nLoss),
   iff(src < nz(xATRTrailingStop[1], 0) and src[1] < nz(xATRTrailingStop[1], 0), min(nz(xATRTrailingStop[1]), src + nLoss),
   iff(src > nz(xATRTrailingStop[1], 0), src - nLoss, src + nLoss)))
pos = 0
pos :=	iff(src[1] < nz(xATRTrailingStop[1], 0) and src > nz(xATRTrailingStop[1], 0), 1,
   iff(src[1] > nz(xATRTrailingStop[1], 0) and src < nz(xATRTrailingStop[1], 0), -1, nz(pos[1], 0)))
xcolor = pos == -1 ? color.red: pos == 1 ? color.green : color.blue
ema   = ema(src,1)
above = crossover(ema, xATRTrailingStop)
below = crossover(xATRTrailingStop, ema)
buy  = src > xATRTrailingStop and above
sell = src < xATRTrailingStop and below
barbuy  = src > xATRTrailingStop
barsell = src < xATRTrailingStop
plotshape(buy,  title = "Buy",  text = 'Buy',  style = shape.labelup,   location = location.belowbar, color= color.green, textcolor = color.white, transp = 0, size = size.tiny)
plotshape(sell, title = "Sell", text = 'Sell', style = shape.labeldown, location = location.abovebar, color= color.red,   textcolor = color.white, transp = 0, size = size.tiny)
barcolor(barbuy  ? color.green : na)
barcolor(barsell ? color.red   : na)
alertcondition(buy,  "UT Long",  "UT Long")
alertcondition(sell, "UT Short", "UT Short")`,

  'Range Filter (v4)': `//@version=4
study(title="Range Filter - B&S Signals", shorttitle="RF - B&S Signals", overlay=true)
src = input(defval=close, title="Source")
per = input(defval=100, minval=1, title="Sampling Period")
mult = input(defval=3.0, minval=0.1, title="Range Multiplier")
smoothrng(x, t, m)=>
    wper      = (t*2) - 1
    avrng     = ema(abs(x - x[1]), t)
    smoothrng = ema(avrng, wper)*m
    smoothrng
smrng = smoothrng(src, per, mult)
rngfilt(x, r)=>
    rngfilt  = x
    rngfilt := x > nz(rngfilt[1]) ? ((x - r) < nz(rngfilt[1]) ? nz(rngfilt[1]) : (x - r)) : ((x + r) > nz(rngfilt[1]) ? nz(rngfilt[1]) : (x + r))
    rngfilt
filt = rngfilt(src, smrng)
upward   = 0.0
upward  := filt > filt[1] ? nz(upward[1]) + 1 : filt < filt[1] ? 0 : nz(upward[1])
downward = 0.0
downward := filt < filt[1] ? nz(downward[1]) + 1 : filt > filt[1] ? 0 : nz(downward[1])
hband = filt + smrng
lband = filt - smrng
filtcolor = upward > 0 ? color.lime : downward > 0 ? color.red : color.orange
filtplot = plot(filt, color=filtcolor, linewidth=3, title="Range Filter")
hbandplot = plot(hband, color=color.aqua, transp=100, title="High Target")
lbandplot = plot(lband, color=color.fuchsia, transp=100, title="Low Target")
fill(hbandplot, filtplot, color=color.aqua, title="High Target Range")
fill(lbandplot, filtplot, color=color.fuchsia, title="Low Target Range")
longCond = bool(na)
shortCond = bool(na)
longCond := src > filt and src > src[1] and upward > 0 or src > filt and src < src[1] and upward > 0
shortCond := src < filt and src < src[1] and downward > 0 or src < filt and src > src[1] and downward > 0
CondIni = 0
CondIni := longCond ? 1 : shortCond ? -1 : CondIni[1]
longCondition = longCond and CondIni[1] == -1
shortCondition = shortCond and CondIni[1] == 1
plotshape(longCondition, title = "Buy Signal", text ="BUY", textcolor = color.white, style=shape.labelup, size = size.normal, location=location.belowbar, color = color.green, transp = 0)
plotshape(shortCondition, title = "Sell Signal", text ="SELL", textcolor = color.white, style=shape.labeldown, size = size.normal, location=location.abovebar, color = color.red, transp = 0)
alertcondition(longCondition, title="Buy Alert", message = "BUY")
alertcondition(shortCondition, title="Sell Alert", message = "SELL")`,

  'QQE (v4)': `//@version=4
study("QQE MOD")
RSI_Period = input(6, title='RSI Length')
SF = input(5, title='RSI Smoothing')
QQE = input(3, title='Fast QQE Factor')
ThreshHold = input(3, title="Thresh-hold")
src = input(close, title="RSI Source")
Wilders_Period = RSI_Period * 2 - 1
Rsi = rsi(src, RSI_Period)
RsiMa = ema(Rsi, SF)
AtrRsi = abs(RsiMa[1] - RsiMa)
MaAtrRsi = ema(AtrRsi, Wilders_Period)
dar = ema(MaAtrRsi, Wilders_Period) * QQE
longband = 0.0
shortband = 0.0
trend = 0
DeltaFastAtrRsi = dar
RSIndex = RsiMa
newshortband = RSIndex + DeltaFastAtrRsi
newlongband = RSIndex - DeltaFastAtrRsi
longband := RSIndex[1] > longband[1] and RSIndex > longband[1] ? max(longband[1], newlongband) : newlongband
shortband := RSIndex[1] < shortband[1] and RSIndex < shortband[1] ? min(shortband[1], newshortband) : newshortband
cross_1 = cross(longband[1], RSIndex)
trend := cross(RSIndex, shortband[1]) ? 1 : cross_1 ? -1 : nz(trend[1], 1)
FastAtrRsiTL = trend == 1 ? longband : shortband
length = input(50, minval=1, title="Bollinger Length")
mult = input(0.35, minval=0.001, maxval=5, step=0.1, title="BB Multiplier")
basis = sma(FastAtrRsiTL - 50, length)
dev = mult * stdev(FastAtrRsiTL - 50, length)
upper = basis + dev
lower = basis - dev
color_bar = RsiMa - 50 > upper ? #00c3ff : RsiMa - 50 < lower ? #ff0062 : color.gray
QQEzlong = 0
QQEzlong := nz(QQEzlong[1])
QQEzshort = 0
QQEzshort := nz(QQEzshort[1])
QQEzlong := RSIndex >= 50 ? QQEzlong + 1 : 0
QQEzshort := RSIndex < 50 ? QQEzshort + 1 : 0
Zero = hline(0, color=color.white, linestyle=hline.style_dotted, linewidth=1)
plot(FastAtrRsiTL - 50, title='QQE Line', color=color.white, transp=0, linewidth=2)
plot(RsiMa - 50, color=color_bar, title='Histo2', style=plot.style_columns, transp=50)`,

  'Hull Suite (v4)': `//@version=4
study("Hull Suite by InSilico", overlay=true)
src = input(close, title="Source")
modeSwitch = input("Hma", title="Hull Variation", options=["Hma", "Thma", "Ehma"])
length = input(55, title="Length(180-200 for floating S/R , 55 for swing entry)")
switchColor = input(true, "Color Hull according to trend?")
HMA(_src, _length) =>  wma(2 * wma(_src, _length / 2) - wma(_src, _length), round(sqrt(_length)))
EHMA(_src, _length) =>  ema(2 * ema(_src, _length / 2) - ema(_src, _length), round(sqrt(_length)))
THMA(_src, _length) =>  wma(wma(_src,_length / 3) * 3 - wma(_src, _length / 2) - wma(_src, _length), _length)
Mode(modeSwitch, src, len) =>
      modeSwitch == "Hma"  ? HMA(src, len) :
      modeSwitch == "Ehma" ? EHMA(src, len) :
      modeSwitch == "Thma" ? THMA(src, len/2) : na
_hull = Mode(modeSwitch, src, int(length))
HULL = _hull
MHULL = HULL[0]
SHULL = HULL[2]
hullColor = switchColor ? (HULL > HULL[2] ? #00ff00 : #ff0000) : #ff9800
Fi1 = plot(MHULL, title="MHULL", color=hullColor, linewidth=1, transp=50)
Fi2 = plot(SHULL, title="SHULL", color=hullColor, linewidth=1, transp=50)
fill(Fi1, Fi2, title="Band Filler", color=hullColor, transp=40)
barcolor(color = hullColor)`,

  'Chandelier Exit (v5)': `//@version=5
indicator('Chandelier Exit', shorttitle='CE', overlay=true)
length = input(title='ATR Period', defval=22)
mult = input.float(title='ATR Multiplier', step=0.1, defval=3.0)
showLabels = input(title='Show Buy/Sell Labels ?', defval=true)
useClose = input(title='Use Close Price for Extremums ?', defval=true)
highlightState = input(title='Highlight State ?', defval=true)
atr = mult * ta.atr(length)
longStop = (useClose ? ta.highest(close, length) : ta.highest(length)) - atr
longStopPrev = nz(longStop[1], longStop)
longStop := close[1] > longStopPrev ? math.max(longStop, longStopPrev) : longStop
shortStop = (useClose ? ta.lowest(close, length) : ta.lowest(length)) + atr
shortStopPrev = nz(shortStop[1], shortStop)
shortStop := close[1] < shortStopPrev ? math.min(shortStop, shortStopPrev) : shortStop
var int dir = 1
dir := close > shortStopPrev ? 1 : close < longStopPrev ? -1 : dir
var color longColor = color.green
var color shortColor = color.red
longStopPlot = plot(dir == 1 ? longStop : na, title='Long Stop', style=plot.style_linebr, linewidth=2, color=color.new(longColor, 0))
buySignal = dir == 1 and dir[1] == -1
plotshape(buySignal ? longStop : na, title='Long Stop Start', location=location.absolute, style=shape.circle, size=size.tiny, color=color.new(longColor, 0))
plotshape(buySignal and showLabels ? longStop : na, title='Buy Label', text='Buy', location=location.absolute, style=shape.labelup, size=size.tiny, color=color.new(longColor, 0), textcolor=color.new(color.white, 0))
shortStopPlot = plot(dir == 1 ? na : shortStop, title='Short Stop', style=plot.style_linebr, linewidth=2, color=color.new(shortColor, 0))
sellSignal = dir == -1 and dir[1] == 1
midPricePlot = plot(ohlc4, title='', style=plot.style_circles, linewidth=0, display=display.none, editable=false)
longFillColor = highlightState ? dir == 1 ? longColor : na : na
shortFillColor = highlightState ? dir == -1 ? shortColor : na : na
fill(midPricePlot, longStopPlot, title='Long State Filling', color=longFillColor)
fill(midPricePlot, shortStopPlot, title='Short State Filling', color=shortFillColor)
changeCond = dir != dir[1]
alertcondition(changeCond, title='Alert: CE Direction Change', message='Chandelier Exit has changed direction!')
alertcondition(buySignal, title='Alert: CE Buy', message='Chandelier Exit Buy!')
alertcondition(sellSignal, title='Alert: CE Sell', message='Chandelier Exit Sell!')`,

  'v5 ta sweep': `//@version=5
indicator("ta sweep", overlay=false, max_labels_count=50)
[macdLine, signalLine, hist] = ta.macd(close, 12, 26, 9)
[bbm, bbu, bbl] = ta.bb(close, 20, 2)
[kcm, kcu, kcl] = ta.kc(close, 20, 1.5)
[diplus, diminus, adx] = ta.dmi(14, 14)
[st, stDir] = ta.supertrend(3, 10)
k = ta.sma(ta.stoch(close, high, low, 14), 3)
plot(macdLine + signalLine + hist, "macd")
plot(bbu - bbl + kcu - kcl + ta.bbw(close, 20, 2) + ta.kcw(close, 20, 1.5), "bands")
plot(adx + diplus - diminus, "dmi")
plot(st * stDir, "st")
plot(k + ta.cci(close, 20) + ta.mfi(hlc3, 14) + ta.wpr(14) + ta.cmo(close, 9) + ta.tsi(close, 13, 25), "osc")
plot(ta.obv + ta.pvt + ta.wvad + ta.accdist + ta.nvi + ta.pvi + ta.iii + ta.wad, "volume")
plot(ta.vwma(close, 20) + ta.hma(close, 9) + ta.alma(close, 9, 0.85, 6) + ta.swma(close) + ta.rma(close, 14) + ta.wma(close, 9) + ta.linreg(close, 20, 0), "mas")
plot(ta.dev(close, 20) + ta.variance(close, 20) + ta.stdev(close, 20) + ta.median(close, 20) + ta.mode(close, 20) + ta.range(close, 20), "stats")
plot(ta.percentrank(close, 20) + ta.percentile_linear_interpolation(close, 20, 50) + ta.percentile_nearest_rank(close, 20, 50) + ta.correlation(close, volume, 20), "rank")
plot(ta.cog(close, 10) + ta.mom(close, 10) + ta.roc(close, 10) + ta.change(close) + ta.tr(true) + ta.atr(14) + ta.sar(0.02, 0.02, 0.2), "misc")
ph = ta.pivothigh(high, 5, 5)
pl = ta.pivotlow(low, 5, 5)
plot(nz(ph) + nz(pl) + ta.valuewhen(ta.crossover(close, ta.sma(close, 20)), close, 0) + ta.barssince(close > open) + ta.cum(volume) / 1e6, "events")
plot(ta.highestbars(high, 10) + ta.lowestbars(low, 10) + (ta.rising(close, 3) ? 1 : 0) + (ta.falling(close, 3) ? 1 : 0) + (ta.cross(close, open) ? 1 : 0), "bars")
plot(ta.vwap(hlc3), "vwap")`,

  'v5 strategy with tables and drawings': `//@version=5
strategy("v5 kitchen sink", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.1, pyramiding=1)
fastLen = input.int(9, "Fast", minval=1, group="MAs", inline="ma")
slowLen = input.int(21, "Slow", minval=1, group="MAs", inline="ma")
src = input.source(close, "Source")
useHtf = input.bool(true, "HTF filter")
htf = input.timeframe("60", "HTF")
sess = input.session("0000-2400", "Session")
[htfClose, htfEma] = request.security(syminfo.tickerid, htf, [close, ta.ema(close, 50)], lookahead=barmerge.lookahead_off)
inSession = not na(time(timeframe.period, sess))
fast = ta.ema(src, fastLen)
slow = ta.ema(src, slowLen)
bull = ta.crossover(fast, slow) and (not useHtf or htfClose > htfEma) and inSession
bear = ta.crossunder(fast, slow)
atr = ta.atr(14)
if bull
    strategy.entry("L", strategy.long, comment="long")
    strategy.exit("LX", "L", stop=close - 2 * atr, limit=close + 3 * atr, trail_points=atr / syminfo.mintick, trail_offset=atr / syminfo.mintick / 2)
if bear
    strategy.close("L", comment="cross down")
var table t = table.new(position.top_right, 2, 3, bgcolor=color.new(color.black, 80), border_width=1)
if barstate.islast
    table.cell(t, 0, 0, "Trades", text_color=color.white)
    table.cell(t, 1, 0, str.tostring(strategy.closedtrades), text_color=color.white)
    table.cell(t, 0, 1, "Net", text_color=color.white)
    table.cell(t, 1, 1, str.tostring(strategy.netprofit, format.mintick), text_color=color.white)
    table.cell(t, 0, 2, "TF", text_color=color.white)
    table.cell(t, 1, 2, timeframe.period + " " + str.tostring(timeframe.in_seconds()) + "s", text_color=color.white)
if bull
    label.new(bar_index, low, "▲", style=label.style_label_up, color=color.green, textcolor=color.white, size=size.tiny)
var line lvl = na
if ta.change(ta.highest(high, 20)) != 0
    line.delete(lvl)
    lvl := line.new(bar_index - 20, ta.highest(high, 20), bar_index, ta.highest(high, 20), color=color.orange, extend=extend.right)
var box b = na
if bar_index % 50 == 0
    b := box.new(bar_index, high, bar_index + 10, low, border_color=color.blue, bgcolor=color.new(color.blue, 90))
plot(fast, "fast", color.new(color.teal, 0))
plot(slow, "slow", color.new(color.orange, 0))
bgcolor(inSession ? na : color.new(color.gray, 90))
plotchar(bull, "bull", "▲", location.belowbar, color.green, size=size.tiny)`,

  'v6 types, methods, maps, enums': `//@version=6
indicator("v6 features", overlay=false)
enum Mode
    fast = "Fast"
    slow = "Slow"
mode = input.enum(Mode.fast, "Mode")
type Pivot
    float price
    int bar
    string kind = "high"
method age(Pivot p) => bar_index - p.bar
var pivots = array.new<Pivot>()
var counts = map.new<string, int>()
ph = ta.pivothigh(high, 3, 3)
if not na(ph)
    pivots.push(Pivot.new(ph, bar_index - 3))
    counts.put("high", counts.get("high") + 1)
if pivots.size() > 10
    pivots.shift()
len = switch mode
    Mode.fast => 10
    Mode.slow => 30
float lastAge = pivots.size() > 0 ? pivots.last().age() : na
s = 0.0
for p in pivots
    s += p.price
avgPrice = pivots.size() > 0 ? s / pivots.size() : na
plot(lastAge, "age")
plot(avgPrice, "avg")
plot(ta.sma(close, len), "ma")
plot(nz(counts.get("high")), "count")
txt = str.format("{0} pivots, last {1,number,#.##}", pivots.size(), nz(avgPrice))
if barstate.islast
    label.new(bar_index, close, txt)
arr = array.from(3.0, 1.0, 2.0)
arr.sort(order.descending)
plot(arr.get(0) + arr.sum() + array.avg(arr) + arr.max() + arr.min() + arr.indexof(2.0) + arr.median() + arr.stdev(), "arr")
plot(math.sum(close, 5) + math.avg(1, 2, 3) + math.round(close, 2) + math.round_to_mintick(close) + math.sign(close - open) + math.log10(close), "math")
c = color.from_gradient(ta.rsi(close, 14), 30, 70, color.red, color.green)
plot(ta.rsi(close, 14), "rsi", c)`,

  'v5 strings, time and request': `//@version=5
indicator("strings and time")
s = str.split("a,b,c", ",")
plot(array.size(s) + (str.contains("hello", "ell") ? 1 : 0) + str.length("abc") + str.pos("abc", "c") + (str.startswith("abc", "a") ? 1 : 0), "str")
plot(str.tonumber("1.5") + (str.upper("a") == "A" ? 1 : 0) + (str.replace_all("a-b", "-", "") == "ab" ? 1 : 0), "str2")
plot(dayofweek + hour + minute + month + year % 100 + weekofyear + dayofmonth, "time")
isMonday = dayofweek(time) == dayofweek.monday
plot(isMonday ? 1 : 0, "monday")
d = request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_on)
w = request.security("BINANCE:ETHUSDT", "240", ta.sma(close, 10))
plot(d + w, "sec")
plot(timeframe.multiplier + (timeframe.isintraday ? 1 : 0) + (timeframe.isdaily ? 1 : 0), "tf")
plot(time_close - time, "dur")
var float sumv = 0
sumv += volume
plot(sumv, "cumvol")`,
};

/** Higher-timeframe bars aggregated from the chart bars (good enough to exercise request.security). */
function aggregate(b: BarSeries, ms: number): BarSeries {
  const idx: number[][] = [];
  let key = NaN;
  for (let i = 0; i < b.length; i++) {
    const k = Math.floor(b.t[i] / ms);
    if (k !== key) {
      idx.push([]);
      key = k;
    }
    idx[idx.length - 1].push(i);
  }
  const n = idx.length;
  const out = { t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n), l: new Float64Array(n), c: new Float64Array(n), v: new Float64Array(n), tc: new Float64Array(n), length: n };
  idx.forEach((g, k) => {
    out.t[k] = Math.floor(b.t[g[0]] / ms) * ms;
    out.tc[k] = out.t[k] + ms;
    out.o[k] = b.o[g[0]];
    out.c[k] = b.c[g[g.length - 1]];
    out.h[k] = Math.max(...g.map((i) => b.h[i]));
    out.l[k] = Math.min(...g.map((i) => b.l[i]));
    out.v[k] = g.reduce((a, i) => a + b.v[i], 0);
  });
  return out;
}

describe('Pine compatibility corpus', () => {
  const data = bars(1200);
  for (const [name, code] of Object.entries(CORPUS)) {
    it(name, () => {
      const c = compileCached(code);
      const security: Record<string, BarSeries> = {};
      for (const q of securityRequests(c, {}, ctx)) security[q.key] = aggregate(data, Math.max(15 * MIN, tfDurationMs(parseTimeframe(q.tf)!)));
      const r = runPine(code, { data, ctx, inputs: {}, security });
      if (r.error) throw new Error(`${r.error.kind}: ${r.error.message} (line ${r.error.line})`);
      expect(r.ok).toBe(true);
      // some plots are hidden by default inputs; the script must produce values somewhere
      const withValues = r.plots.filter((p) => Array.from(p.values).some((v) => Number.isFinite(v)));
      expect(withValues.length, `${name}: plots with values`).toBeGreaterThan(0);
    });
  }
});

describe('Pine v4 semantics match v5', () => {
  const data = bars(800);
  const values = (code: string, title: string) => {
    const r = runPine(code, { data, ctx, inputs: {}, security: {} });
    if (r.error) throw new Error(r.error.message);
    return Array.from(r.plots.find((p) => p.title === title)!.values);
  };
  it('built-ins without namespaces, iff() and offset() give the v5 values', () => {
    const v4 = values(`//@version=4\nstudy("a")\nx = iff(close > sma(close, 20), rsi(close, 14), -stdev(close, 10))\nplot(x + offset(close, 2) + max(high, low) + tr + atr(5), "p")`, 'p');
    const v5 = values(`//@version=5\nindicator("a")\nx = close > ta.sma(close, 20) ? ta.rsi(close, 14) : -ta.stdev(close, 10)\nplot(x + close[2] + math.max(high, low) + ta.tr + ta.atr(5), "p")`, 'p');
    expect(v4.length).toBe(v5.length);
    for (let i = 0; i < v4.length; i++) Number.isNaN(v5[i]) ? expect(v4[i]).toBeNaN() : expect(v4[i]).toBeCloseTo(v5[i], 9);
  });

  it('a variable may shadow a v4 function name (atr = atr(14))', () => {
    const v4 = values(`//@version=4\nstudy("a")\natr = atr(14)\nplot(atr * 2, "p")`, 'p');
    const v5 = values(`//@version=5\nindicator("a")\na = ta.atr(14)\nplot(a * 2, "p")`, 'p');
    expect(v4[500]).toBeCloseTo(v5[500], 9);
  });

  it('strategy calls with when= trade like if-blocks', () => {
    const v4 = runPine(`//@version=4\nstrategy("s", overlay=true)\nf = ema(close, 9)\ns = ema(close, 21)\nstrategy.entry("L", strategy.long, when = crossover(f, s))\nstrategy.close("L", when = crossunder(f, s))`, { data, ctx, inputs: {} });
    const v5 = runPine(`//@version=5\nstrategy("s", overlay=true)\nf = ta.ema(close, 9)\ns = ta.ema(close, 21)\nif ta.crossover(f, s)\n    strategy.entry("L", strategy.long)\nif ta.crossunder(f, s)\n    strategy.close("L")`, { data, ctx, inputs: {} });
    expect(v4.error).toBeUndefined();
    const a = v4.strategy!.trades.map((t) => [t.entryBar, t.exitBar]);
    expect(a.length).toBeGreaterThan(3);
    expect(a).toEqual(v5.strategy!.trades.map((t) => [t.entryBar, t.exitBar]));
  });

  it('transp becomes the colour alpha; study(resolution) is accepted', () => {
    const r = runPine(`//@version=4\nstudy("t", resolution="")\nplot(close, title="p", color=color.red, transp=80)\nbgcolor(color.green, 90)`, { data, ctx, inputs: {} });
    expect(r.error).toBeUndefined();
    const p = r.plots.find((x) => x.title === 'p')!;
    expect(String(p.color)).toMatch(/,\s*0\.2\)$/);
  });
});

describe('Pine drawings: points, linefills, polylines, setters', () => {
  const data = bars(400);
  it('draws with chart.point overloads, linefill and polyline', () => {
    const code = `//@version=5
indicator("draw", overlay=true, max_lines_count=100)
var points = array.new<chart.point>()
if bar_index % 20 == 0
    points.push(chart.point.from_index(bar_index, close))
if points.size() > 8
    points.shift()
var line up = line.new(chart.point.from_index(0, 0), chart.point.from_index(1, 0), color=color.green)
var line dn = line.new(0, 0, 1, 0, color=color.red)
var linefill lf = linefill.new(up, dn, color.new(color.blue, 80))
line.set_first_point(up, chart.point.from_index(bar_index - 10, high))
line.set_second_point(up, chart.point.now(high))
line.set_xy1(dn, bar_index - 10, low)
line.set_xy2(dn, bar_index, low)
var box bx = box.new(chart.point.from_index(0, 1), chart.point.from_index(1, 0), border_color=color.orange, border_style=line.style_dashed)
box.set_top_left_point(bx, chart.point.from_index(bar_index - 5, high))
box.set_bottom_right_point(bx, chart.point.from_index(bar_index, low))
box.set_border_width(bx, 2)
var label lb = label.new(chart.point.now(close), "hi", style=label.style_label_up)
label.set_point(lb, chart.point.now(close))
var table t = table.new(position.top_right, 2, 2)
table.set_bgcolor(t, color.black)
table.cell(t, 0, 0, "x")
table.merge_cells(t, 0, 0, 1, 0)
if barstate.islast
    polyline.new(points, curved=true, closed=false, line_color=color.purple)
sorted = array.from(1.0, 2.0, 2.0, 4.0)
plot(array.binary_search_leftmost(sorted, 2.0) + array.binary_search_rightmost(sorted, 2.0) * 10 + array.binary_search_leftmost(sorted, 3.0) * 100 + array.binary_search_rightmost(sorted, 3.0) * 1000, "bs")
plot(line.get_y1(dn), "y1")`;
    const r = runPine(code, { data, ctx, inputs: {} });
    if (r.error) throw new Error(`${r.error.message} (line ${r.error.line})`);
    // leftmost(2)=1, rightmost(2)=2, leftmost(3)=2 (next smaller), rightmost(3)=3 (next larger)
    expect(r.plots.find((p) => p.title === 'bs')!.values[10]).toBe(1 + 20 + 200 + 3000);
    expect(r.lines.length).toBe(2);
    // line.set_first_point moved the line to 10 bars back
    expect(r.lines.some((l) => l.x1 === data.length - 11)).toBe(true);
    expect(r.polys?.length).toBe(2);
    expect(r.polys!.some((p) => p.closed && p.fill)).toBe(true);
    expect(r.polys!.some((p) => p.curved && p.stroke && p.pts.length >= 8)).toBe(true);
    expect(r.boxes[0].style).toBe('dashed');
    expect(r.boxes[0].left).toBe(data.length - 1 - 5);
    expect(r.labels[0].x).toBe(data.length - 1);
  });

  it('strategy.default_entry_qty follows the default size', () => {
    const r = runPine(`//@version=5\nstrategy("q", initial_capital=10000, default_qty_type=strategy.cash, default_qty_value=1000)\nplot(strategy.default_entry_qty(close), "q")`, { data, ctx, inputs: {} });
    if (r.error) throw new Error(r.error.message);
    const q = r.plots[0].values;
    expect(q[100]).toBeCloseTo(1000 / data.c[100], 4);
  });
});
