# @name Python: Book Walls
# @category Order book
# @description The largest bid and ask resting in the order book near the price, per bar: a dot at the price of each wall that holds at least the chosen share of its side. The forming bar shows the live book; history needs order-book recordings (Data → Order books).
from fufu import *


@indicator("Book Walls", short_title="Walls", overlay=True, precision=2)
def main(data, pct=input.float(1.0, "Within % of the mid", min=0.05, step=0.05), share=input.float(5.0, "Minimum share of the side (%)", min=0.0, step=0.5)):
    book = data.book
    bid_p, bid_q = book.wall('bid', pct)
    ask_p, ask_q = book.wall('ask', pct)
    bid_all = book.depth('bid', pct)
    ask_all = book.depth('ask', pct)
    with np.errstate(invalid='ignore', divide='ignore'):
        bid_share = 100 * bid_q / bid_all
        ask_share = 100 * ask_q / ask_all
    plot(np.where(bid_share >= share, bid_p, np.nan), "Bid wall", color="#26a69a", width=3, style="circles")
    plot(np.where(ask_share >= share, ask_p, np.nan), "Ask wall", color="#ef5350", width=3, style="circles")
    plot(bid_q, "Bid wall size", color="#26a69a", display=False)
    plot(ask_q, "Ask wall size", color="#ef5350", display=False)
