# Tiny Trend Bot — Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/muhamadfajar160299-ctrl/makefun-entry-tiny-bot-20261126/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/muhamadfajar160299-ctrl/makefun-entry-tiny-bot-20261126/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Entry for [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) — see the [leaderboard](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) on make.fun.

## What it does

`main.ts` is a standalone trading bot speaking the `agent-fun/bars-replay/v1`
line protocol over stdin/stdout (one JSON message per line, one reply per
batch, echoing the batch `seq`). It runs on Node 22 with no dependencies and
no network access.

Strategy, in short:

- **Multi-symbol trend-following with confirmation.** A symbol is only bought
  when its fast smoothing line sits above its slow line, the close sits above
  the fast line, the gap between the lines is wide relative to recent
  volatility, and the slow line itself is sloping upward. All four readings
  must agree; weak or single-signal moves are ignored.
- **Volatility-sized positions.** Each trade risks about 1% of equity if the
  price falls one stop-distance against it, and no symbol ever holds more
  than 20% of equity. Cash is always kept in reserve for the other symbols.
- **Tight exits.** Every position carries a hard stop (entry minus 2.5× ATR),
  a trailing stop (peak minus 3× ATR), and a trend-break exit (fast line
  crossing back below the slow line). Exits are evaluated before any new
  entry each bar.

The goal is to beat buy-and-hold on the replay while staying robust outside
the dev window: it rides confirmed trends, sits out chop, and cuts losers
fast instead of overfitting to any one stretch of data.

## Run

```sh
node main.ts
```
