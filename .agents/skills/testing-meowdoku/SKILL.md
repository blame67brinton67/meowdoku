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
  persistent shell) and always verify with `curl` before touching the browser. If the first
  `nohup ... & disown; sleep; curl` one-liner returns nothing / no log file, re-run the `nohup`
  line alone inside a dedicated persistent shell (`exec` with a `shell_id`).
- Port 3000 conflicts fail silently from the browser's point of view: an EADDRINUSE crash of the
  *new* server leaves the *old* one serving, so test toggles (env vars) appear not to work.
  Always `ps aux | grep "[n]ode server.js"` after a restart and kill the old PID first.
- `data/` (levels + single-player scores) is gitignored; delete it to force fresh generation.
  Multiplayer rooms are in-memory only — restarting the server orphans open room screens in the
  browser (clients keep rendering the old room), so reload both windows after any restart.

## Two browser contexts
Player identity is a localStorage `visitorId`, so a normal Chrome window and an Incognito window
are two distinct players. Tile them side by side (each ~half screen) so a single screenshot shows
both boards. Maximize/tile before recording. On this box the display is `:0` at 1600×1200; tile with
```bash
DISPLAY=:0 wmctrl -l                                   # find window ids
DISPLAY=:0 wmctrl -i -r <id> -e 0,0,0,800,1200         # left half
DISPLAY=:0 google-chrome --incognito --new-window http://localhost:3000
DISPLAY=:0 wmctrl -i -r <id2> -e 0,800,0,800,1200      # right half
```
In newer builds there is no nickname field: a signed-in player shows their account name and a guest
gets a server-assigned `神秘貓奴・…` alias, so sign in as different accounts when podium rows have to
be attributable.

## Accounts and admin (newer builds)
- Newer snapshots need `npm install` before anything (native `better-sqlite3`; accounts/sessions and
  history live in `data/meowdoku.db`). `data/` is no longer disposable — do not delete it blindly.
- Register through the header 帳號 / 登入 dialog. Password validation may be length-only (1–72
  chars), so a 1-character password like `a` can be a valid test credential; read `auth.js`
  (`PASSWORD_MIN` / `PASSWORD_MAX`) for the current rule instead of assuming 8+.
- Admin is `users.is_admin` in newer builds, not a shared key: register the account in the UI first,
  then restart with `ADMIN_BOOTSTRAP_USER=<username> node server.js`; only then does 管理關卡 appear.
  Older builds still use the `meowdoku-admin` key.
- Signed-in users get account-bound settings (theme / recentThemes / colorScheme / vibrate) through
  `POST /api/settings` and `GET /api/auth/me` (`user.settings`). To prove they are server-backed
  rather than localStorage, log in as the same account in an Incognito/second profile and check the
  palette plus the 最近使用 row (`#recent-themes` / `#recent-theme-list`). Guests must keep working
  from localStorage only and must not call `/api/settings` — assert with a `fetch` wrapper counter.

## Room settings dialog (newer builds)
Board size / 房間類型 / 房間密碼 may live in the host settings dialog (`#sprint-dialog`, opened by
the gear `#sprint-settings-button`) as `#room-size` / `#room-visibility` / `#room-password` /
`#room-password-save` / `#room-password-clear`, alongside the sprint controls. Things to check that
have broken before:
- `syncSprintDialog()` must target `[data-sprint-mode]`, not the first `.sprint-setting` (the room
  summary reuses that class and the controls then render blank / `undefined`). Always open the gear
  dialog on a fresh room and assert `#sprint-mode.value` and `#sprint-value.value` are real values
  before testing anything else in that dialog.
- The room panel rerenders on every broadcast, so type an unsaved password, force a broadcast
  (chat message from the other client) and confirm the field keeps its text and the selects stay
  current.
- Non-hosts must not see `#room-group` (and get no gear button at all).

## Layout / no-scroll checks
Measure `document.scrollingElement.scrollHeight - clientHeight` per state instead of eyeballing
scrollbars, and check the board really has size: `.board-wrap` uses `container-type: size` and
`.board { width: min(100cqw, 100cqh) }`, so a zero-height wrapper silently collapses every cell to
0×0 and the play area looks like an empty panel. Assert
`document.querySelector('.board').getBoundingClientRect()` is non-trivial in every viewport, in
particular at ≤900px width where the portrait media query switches `.game-layout` to
`grid-template-rows: auto minmax(0, 1fr)`.

## Admin level generation
Top-right 管理關卡 → key `meowdoku-admin` (or `ADMIN_KEY` env) → name + size → 產生並發布唯一解關卡.
Clear the name field fully (ctrl+a) before typing; leftover text silently truncates the level name.
Reference timings: 7×7 ≈ 2 ms, 10×10 ≈ 140 ms per puzzle (measurable directly via
`node -e "console.time('g');require('./puzzle').generatePuzzle(10);console.timeEnd('g')"`).

## Knowing where the cats are
The client never receives the solution. For deterministic clicking, either read
`data/levels.json` (single player) or temporarily add a server log when a match starts (inside the
`start-room` countdown `setTimeout`, right after `room.startedAt = Date.now()`):
```js
console.log('TESTLOG solution', room.code, 'mode=' + room.sprintMode, 'seconds=' + room.sprintSeconds, 'factor=' + room.sprintFactor, JSON.stringify(room.puzzle.solution));
```
Revert temp instrumentation and confirm `git status --porcelain` is empty before reporting.
Keep a pristine copy first (`cp server.js /tmp/server.js.orig`). Keep temp test-plan/notes files
outside the repo (e.g. `/tmp`) so the tree stays clean.

## Clicking board cells from screenshots
With a 800×1200 tiled Chrome window on the left half of a 1600×1200 screen (tool coords 1024×768),
a 7×7 multiplayer board renders with cell centres at roughly `x = 50 + 34.8·col`,
`y = 256 + 34.3·row` (tool coordinates; the older `x = 44 + 36.5·col`, `y = 243 + 36.5·row` also
lands inside the cells). Verify with one click first (a wrong click eliminates you); the
`找到 N / 7` counter and the `aria-label="第 R 行第 C 列"` cell text confirm the mapping.
Docking devtools shrinks the page and invalidates these coordinates — close devtools (ctrl+shift+j)
before clicking board cells, then reopen it afterwards (console history survives).

## Transient `#game-message` text
Status messages passed to `renderGame(message)` (e.g. `第一位完成！N 秒最後衝刺開始。`) land in
`#game-message` and are overwritten within milliseconds by the next `emitRoom`-driven `patchGame`,
so they are effectively impossible to photograph. To prove the text, register an extra listener in
the page console before triggering it (app handlers run first, so the DOM already has the message):
```js
socket.on('final-sprint', p => console.log(JSON.stringify(p), document.querySelector('#game-message').textContent));
```
The persistent `最後衝刺 <b data-deadline>` counter in `.game-status` *is* photographable and is
the better evidence for countdown-duration assertions.

## Sound: proving playSfx fired (audio cannot be recorded)
Wrap the global before the action, in the page console:
```js
(()=>{const o=window.playSfx;window.playSfx=n=>{console.log('SFX',n,new Date().toISOString());return o(n)}})()
```
`sprint` is logged once at the first completion; `tick` is logged once per second for the last 5 s
of the sprint and once per second during the 3 s pre-match countdown.

## 最後衝刺 (sprint) room setting
- Host-only, lobby-only control in `.sprint-setting` inside `.room-panel`: mode `<select
  id="sprint-mode">` (`固定秒數` / `第一名用時 ×`) + typed `<input id="sprint-value">` + hint
  (`1 – 9999 秒` / `倍數 0.1 – 9999`). Non-hosts/spectators see a read-only line
  `最後衝刺：<n> 秒` or `最後衝刺：第一名用時 × <f>` — use it as the independent read-back of what
  the server actually stored after typing a value in the host window.
- Socket event: `set-sprint-setting` `{code, playerId, mode, value}`. Rejections come back through
  the ack and are shown via `alert` (`只有房主可以調整最後衝刺時間`,
  `倒數開始後不能再調整最後衝刺時間`, `請輸入有效的秒數（1 – 9999）`,
  `請輸入有效的倍數（0.1 – 9999）`). The value is committed on `change` (blur / Tab), not on
  keystroke, and the field is force-reset to the server value in the ack.
- The control is hidden outside the lobby, so to test the "locked after countdown" path drive it
  from the page console and photograph the ack:
  `socket.emit('set-sprint-setting',{code:state.room.code,playerId:state.visitorId,mode:'fixed',value:99},console.log)`
- In multiply mode the concrete duration only exists when the first player completes; log it
  server-side next to the elapsed time to have a ground truth for the countdown assertion:
  `console.log('TESTLOG sprint', room.code, 'elapsedMs=' + (Date.now() - room.startedAt), 'resolvedSeconds=' + sprintSeconds);`
  The podium `time` value (e.g. `74.2s`) is the same solve time, so `counter ≈ factor × podium time`
  is verifiable purely from screenshots.
- `restart-room` (用原房號再來一局) intentionally does not reset the sprint mode/value, so it
  persists across rematches.

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

## Room chat (房間聊天)
- Lives in `.side-panels` under the player list in multiplayer only: `#chat-log`, `#chat-input`
  (textarea, `maxlength=200`), 送出 submit button, `#chat-notice` under the form.
  Enter sends, Shift+Enter inserts a newline — but the server strips control chars, so a
  multi-line message arrives flattened into one line with spaces.
- Server (`chat-message`) trims, caps at 200 chars, rate-limits to 5 msgs / 5 s with a 400 ms
  minimum gap, and answers a rejection through the ack callback → 「訊息太頻繁，先喝口水吧」 in
  `#chat-notice`. The notice clears itself after ~1.8 s: screenshot in the *same* tool call that
  sends the flood, or you will miss it.
- Rejected sends leave the text in the textarea, so typed follow-ups concatenate (`f2f3f4…`).
  `ctrl+a` before retyping.
- To prove the *server* cap rather than the textarea `maxlength`, remove the attribute and set the
  value from the console, then click 送出 through the UI, and measure the received text with
  `document.querySelectorAll('#chat-log .chat-line p').at(-1).textContent.length` (expect 200).
- `chat-backlog` is emitted on join and on `resume-room`. To prove it is server-driven, wipe the
  client copy first (`state.chat = []; document.querySelector('#chat-log').textContent = '';`)
  and only then `socket.disconnect(); setTimeout(() => socket.connect(), 1000)` — a bare reconnect
  would repaint from client state and prove nothing. Note `state` and `socket` are reachable as
  page globals in the console.
- Page reload does NOT resume a room (`state.resumeCode` is only set by the disconnect handler),
  so use the socket disconnect/connect trick instead of F5 for reconnect tests.
- `browser_console` / `read_dom` attach to the **normal** Chrome window even when the Incognito
  window is focused. Run DOM assertions in the normal window, or verify the Incognito side from
  screenshots only.

## Theme / colour-scheme testing (外觀 dialog)
Path: header 設定 (`#theme-button`) → `#color-scheme` (跟隨系統 / 亮色 / 暗色) → preset buttons
`[data-theme-preset]` → hint `#theme-preset-hint` (`目前：<name>` vs `目前：自訂`) → single-colour
pickers `[data-theme-key="boardLine"]` / `[data-theme-key="paper"]` → `#reset-theme` (重設顏色).
Recent presets: `#recent-themes` / `#recent-theme-list`.
- Objective assertion per state (fine to read in the console; do the clicking in the UI):
  `getComputedStyle(document.documentElement).getPropertyValue('--paper')` and `--board-line`,
  plus `getComputedStyle(document.body).backgroundColor` for the painted page, and
  `document.documentElement.dataset.theme` for the resolved scheme.
- Newer builds give every preset in `public/themes.js` a `dark: { boardLine, paper }` pair; a
  preset must stay `aria-checked` (hint not 自訂) when the stored pair matches EITHER scheme, and
  the preset buttons preview the active scheme's paper via `--paper-swatch`.
- Persistence: `localStorage.meowdokuTheme` / `meowdokuColorScheme` / `meowdokuRecentThemes`;
  signed-in users also `POST /api/settings` (read back from `GET /api/auth/me`), so cross-profile
  checks need ~1 s before logging in elsewhere.
- Native `<input type="color">` dialogs are painful to drive. To set up a *stored* colour pair
  precondition (e.g. "light pair stored while dark scheme is active"), seed
  `localStorage.meowdokuTheme` + `meowdokuColorScheme` and reload, then perform the actual edit
  under test through the picker UI. Disclose that seeding in the report.
- Regression worth repeating: solo `.board` bounding box must be non-zero in BOTH schemes, and in
  dark mode the 貓咪守則 rule card goes dark-bg/light-ink while the 💡 HINT card stays cream with
  dark ink — check both, they use different tokens.

## Getting cat / × / error visuals without racing (legibility screenshots)
Practice mode is the cheapest way to photograph a 🐈, a personal × mark and the red wrong-click
ring on one large board: play any multiplayer match (even losing instantly), then 首頁 →
對戰紀錄（重新解題）→ 重新解這張圖. Practice replays the exact board, wrong clicks only warn
(`這格沒有貓咪，再想想。`) instead of eliminating, so a handful of spread-out left-clicks reliably
yields both cats and red error cells; right-click adds the white × mark. 💡 提示 gives a technique
tip, not a revealed cat, and is limited to 3/day.

## Multiplayer room / reconnect testing
- Room codes are 5 chars; the room URL is `/multi/<CODE>` and the server serves that path, so a
  direct load or F5 on it is a valid test of the client's deep-link join.
- Watch for uncaught page errors with a hook installed in the console-bound window:
  `window.__pageErrors=[]; addEventListener('error',e=>__pageErrors.push(String(e.message)));`
  plus an `unhandledrejection` listener. Re-check `typeof window.__pageErrors` before trusting an
  empty array — the hook can silently disappear (page re-created), in which case reinstall it and
  also read the plain console log.
- Reloading `/multi/<CODE>` **mid-match** does not restore the seat: `joinRoom()` deletes and
  recreates the player with empty `found`/`marks`, and `join-room` forces
  `spectator: room.status !== 'lobby'`. So the returning player paints the room but appears as 觀戰
  with no cats/× marks. Expect this (it may be intended reconnect behaviour); do not read it as a
  rendering/blank-page bug, but do call it out when a task expects marks to come back.
- Stale-board checks across rounds: compare `state.room.puzzle.id` **and** a region signature
  (`state.room.puzzle.regions.flat().join('')`) before/after 換一張新地圖 / 重開, and screenshot both
  windows — region colours differ per theme, so compare the *grouping shape*, not the hues.
- Private room + password: create with 房間類型 = 私人房間, then the room gear ⚙ (`aria-label="房間設定"`)
  → 房間密碼 → 設定密碼 (summary flips to `🔒 需要密碼`). Joining by key then triggers a native
  `window.prompt`; a wrong value produces a native alert `房間密碼不正確`. Drive both with
  type + click on the dialog buttons.

## Known cosmetic quirks (verify before reporting as new bugs)
- A spectator's status line still reads 找到 0 / 7 隻貓咪 rather than a spectating label.
- After a server restart, an open room screen stays on screen until reloaded.
