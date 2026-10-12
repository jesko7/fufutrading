# @name Python: Z-Score Bands
# @category Python
# @description NumPy indicator: rolling z-score with colored histogram and alert when it leaves the band.
from fufu import *


@indicator("Python Z-Score", short_title="PyZ", overlay=False, precision=2)
def main(data, length=input.int(50, "Length", min=2), band=input.float(2.0, "Band", step=0.1), src=input.source("close")):
    mean = ta.sma(src, length)
    sd = ta.stdev(src, length)
    z = (src - mean) / sd
    colors = [color.new(color.green, 30) if v >= 0 else color.new(color.red, 30) for v in np.nan_to_num(z)]
    plot(z, "Z", color=colors, style="columns")
    hline(band, "Upper", color=color.gray)
    hline(-band, "Lower", color=color.gray)
    alertcondition(ta.crossover(z, band) | ta.crossunder(z, -band), "Z-score outside band", "Z-score left the band")
