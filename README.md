# StonkFun Holder Rewards Scanner

This tool finds the StonkFun holder payouts a Solana wallet received and shows them by day and by token, with their value in US dollars. It runs entirely on your computer: a small local dashboard in your browser, your own free Helius API key, and a database file in your user folder. It never asks you to connect a wallet, sign anything or share a private key; it only reads public blockchain data for the address you paste. It is unofficial and not affiliated with StonkFun or Helius.

## Quick start

1. **Install Node.js.** Download the LTS installer from [nodejs.org](https://nodejs.org) (version 24.15 or newer) and install it with the default options.
2. **Download the scanner.** Open the [Releases page](https://github.com/Memes0nline/stonkfun-rewards/releases), download the latest release's **Source code (zip)** and extract it to a folder you will keep, such as `Documents\StonkFun Rewards`.
3. **Start it.** On Windows, double-click **Start Rewards Dashboard.cmd**. On Mac or Linux, open a terminal in the folder and run `sh start.sh`. The first start installs what the dashboard needs, which takes a few minutes and needs the internet, then opens the dashboard at http://127.0.0.1:4317. Keep the launcher window open while you use the dashboard; closing it stops the dashboard.
4. **Get a free Helius API key.** Sign up at [helius.dev](https://www.helius.dev), open the dashboard's API Keys page and copy your key.
5. **Scan your wallet.** Paste your public wallet address into the box at the top of the dashboard and click **Scan wallet**. The first time, the dashboard asks for your Helius key: paste it, tick **Remember on this computer** if you want it kept for next time, click **Save**, then click **Scan wallet** again.

The first scan covers the **last 7 days** and usually takes a minute or two. Older history, back to **2026-08-01** (StonkFun launched in early August 2026), loads with **Load earlier history**, 7 days at a time. Afterwards, **Refresh rewards** checks from your last scan up to now. Each button shows the UTC dates it will read, and the scan window shows the day it is reading. Every day a scan reads is checked against a second list of its transactions from Helius, and anything the first read missed is fetched. Days loaded before that check existed read **Read once** on the Coverage tab; **Rescan dates** checks up to 7 of them at a time and adds anything missed, without counting a saved payout twice.

A **free Helius plan is enough**: the tool was built and tested on one.

## What the numbers mean

- **Payouts count when received.** A payout stays in your totals even if you later sell, swap or send those tokens; selling does not reduce the total.
- **USD is at current prices**, the latest price saved for each token, not the price on the day you were paid. Tokens with no price are listed apart and never counted as zero.
- **Attributed** payouts came from a trusted StonkFun distributor's own account, but no official StonkFun record names the transaction. **Verified** payouts, when a wallet has any, are confirmed against official StonkFun distribution records and are shown on their own. The two are never added together. The **Trust** tab explains both in full.
- Times and days are UTC.

## Where your data lives

- **The database** holds everything the scanner has saved, so saved reports open without the internet:
  - Windows: `%LOCALAPPDATA%\stonkfun-rewards\scanner.sqlite`
  - Mac and Linux: `~/.local/share/stonkfun-rewards/scanner.sqlite`
- **Your Helius key** stays on your computer. The local server keeps it in memory and uses it only for its own requests to Helius. With **Remember on this computer** ticked, it is also saved in a file named `.env` in the scanner folder. It is never sent to the browser page, written to a report or shared anywhere else. To forget a remembered key, delete that `.env` file.

## Updating

1. Close the launcher window.
2. **Back up the data folder first:** copy the `stonkfun-rewards` folder above somewhere safe. A new version may upgrade the database, and the database only moves forward: an older version cannot open it afterwards, so the backup is your way back.
3. Download and extract the new release's zip from the [Releases page](https://github.com/Memes0nline/stonkfun-rewards/releases). If you used Remember, copy the `.env` file from the old scanner folder into the new one.
4. Start the new version. The launcher installs anything that changed.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| **Port 4317 is already used by another program** | The dashboard may already be open: the launcher opens it for you when it is. Otherwise close the other program, or start on another port: `"Start Rewards Dashboard.cmd" --port 4327` on Windows, `sh start.sh --port 4327` on Mac or Linux. |
| **Helius rejected your API key** | Click **Re-enter API key**, paste the key exactly as your Helius dashboard shows it, and click **Retry**. |
| **Helius is limiting requests, slowing down** | Nothing to do: the scan waits and continues on its own. If a scan stopped for this, wait a minute and click **Retry**. |
| **Helius refused the request… monthly credits** | Your Helius plan has used its monthly credits. Check usage in your Helius dashboard, then wait for the monthly reset or change plan. Completed days are saved; **Retry** continues from there. |
| **StonkFun's API did not respond** | StonkFun is unreachable for now. Try again in a few minutes; saved reports stay viewable. |
| **Node.js is not installed** or **needs Node.js 24.15 or newer** | Install the LTS version from [nodejs.org](https://nodejs.org), then start the launcher again. |

To check a computer without starting anything, run the launcher with `--check` from a terminal: `"Start Rewards Dashboard.cmd" --check` or `sh start.sh --check`.

Tested on Windows 11. Mac and Linux run in continuous integration only.

## For developers

Requires Node 24.15 or newer and pnpm 10. SQLite comes with Node.

```sh
git clone https://github.com/Memes0nline/stonkfun-rewards.git
cd stonkfun-rewards
pnpm install --frozen-lockfile
pnpm rewards:web                 # build and start the dashboard
pnpm rewards demo                # synthetic demo, no network requests
pnpm rewards scan <public-wallet>
pnpm rewards scan <public-wallet> --earlier
pnpm rewards report <public-wallet>
pnpm rewards --help
pnpm check                       # tests, type checks and lint
pnpm test:browser                # Playwright against synthetic fixtures
```

The CLI reads `HELIUS_API_KEY` from the environment or the ignored `.env` ([.env.example](.env.example) names it). Keep the key out of command arguments, reports and commits.

### Scan speed

Each provider has a token bucket shared by every stage and process on the same database. Rate limits are waited out (Retry-After, or a 1–30 s backoff), and 5xx, network and timeout failures retry up to three times.

| Setting | Flag (CLI and `pnpm rewards:web --`) | Environment | Default |
| --- | --- | --- | --- |
| Helius requests per second | `--helius-rps N` | `SCANNER_HELIUS_RPS` | 8 |
| Helius burst | `--helius-burst N` | `SCANNER_HELIUS_BURST` | 10 |
| StonkFun requests per second | `--stonkfun-rps N` | `SCANNER_STONKFUN_RPS` | 4 |
| StonkFun burst | `--stonkfun-burst N` | `SCANNER_STONKFUN_BURST` | 5 |
| Hydrations and prices in flight | `--concurrency N` | `SCANNER_CONCURRENCY` | 4 |

A flag beats the environment, which beats the default. Rates run from 0.1 to 100 a second; bursts are whole numbers from 1 to 100 and the worker count from 1 to 16.

### Documentation

- [docs/DASHBOARD.md](docs/DASHBOARD.md): the dashboard, its local API and its tests.
- [docs/SCANNER.md](docs/SCANNER.md): the scan engine, storage, providers, report, and how attributed payouts are established.
- [docs/PAYOUT_EVIDENCE.md](docs/PAYOUT_EVIDENCE.md), [docs/NORMALIZATION.md](docs/NORMALIZATION.md) and [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md): evidence rules and provider sources.

## License

[MIT](LICENSE)
