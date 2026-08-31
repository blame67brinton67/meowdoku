---
name: testing-meowdoku
description: How to run and end-to-end test the MeowDoku app (Node/Express + Socket.IO) locally, including single-player, admin level generation, and two-player multiplayer flows in the browser.
---

# Testing MeowDoku locally

## Start the server
```bash
cd <repo> && npm install
nohup node server.js >> /tmp/meowdoku.log 2>&1 & disown
sleep 3 && curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/levels   # expect 200
```
- Do **not** start the server with a plain backgrounded `exec` call that also runs other commands;
  the process may be reaped when the shell call ends. Use `nohup ... & disown` (or a dedicated
  persistent shell) and always verify with `curl` before touching the browser.
- Port 3000 conflicts fail silently from the browser's point of view: an EADDRINUSE crash of the
  *new* server leaves the *old* one serving, so test toggles (env vars) appear not to work.
  Always `ps aux | grep "[n]ode server.js"` after a restart and kill the old PID first.
- `data/` (levels + single-player scores) is gitignored; delete it to force fresh generation.
  Multiplayer rooms are in-memory only — restarting the server orphans open room screens in the
  browser (clients keep rendering the old room), so reload both windows after any restart.

## Two browser contexts
Player identity is a localStorage `visitorId`, so a normal Chrome window and an Incognito window
are two distinct players. Tile them side by side (each ~half screen) so a single screenshot shows
both boards. Maximize/tile before recording.

## Admin level generation
Top-right 管理關卡 → key `meowdoku-admin` (or `ADMIN_KEY` env) → name + size → 產生並發布唯一解關卡.
Clear the name field fully (ctrl+a) before typing; leftover text silently truncates the level name.
Reference timings: 7×7 ≈ 2 ms, 10×10 ≈ 140 ms per puzzle (measurable directly via
`node -e "console.time('g');require('./puzzle').generatePuzzle(10);console.timeEnd('g')"`).

## Knowing where the cats are
The client never receives the solution. For deterministic clicking, either read
`data/levels.json` (single player) or temporarily add a server log when a match starts:
```js
console.log('TESTLOG solution', room.code, JSON.stringify(room.puzzle.solution));
```
Revert temp instrumentation and confirm `git status --porcelain` is empty before reporting.
Keep a pristine copy first (`cp server.js /tmp/server.js.orig`).

## Making fast local behaviour observable
Optimistic UI states (e.g. `.cell.pending`) resolve in <5 ms on localhost. Temporarily add an
artificial delay in the socket handler to photograph them:
```js
if (process.env.MEOW_TEST_DELAY) await new Promise(r => setTimeout(r, Number(process.env.MEOW_TEST_DELAY)));
```
then run with `MEOW_TEST_DELAY=1200 node server.js`.

## UI landmarks (Traditional Chinese)
- Home: 選擇關卡 (solo), 進入多人遊戲 (multiplayer), 繼續解題 → (next level).
- Multiplayer: 建立房間 → lobby 地圖已封印 / 開始這局 → 3s countdown 即將開始！ → playing.
- Room panel: 已解 N / 7, 已淘汰, 觀戰, 用原房號再來一局 (rematch), ← 離開房間.
- End of match: 本局結束！ overlay with podium and 我知道了! dismiss button.
- Left click = confirm cat (wrong click eliminates in multiplayer); right click / right-button drag
  = personal pencil marks. For drag marks, hold the button (`xdotool mousedown 3` … `mouseup 3`)
  and screenshot **while still held** to capture the marks.

## Known cosmetic quirks (verify before reporting as new bugs)
- A spectator's status line still reads 找到 0 / 7 隻貓咪 rather than a spectating label.
- After a server restart, an open room screen stays on screen until reloaded.
