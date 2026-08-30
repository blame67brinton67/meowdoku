const view = document.querySelector('#view');
const nameInput = document.querySelector('#player-name');
const socket = io();
const state = {
  visitorId: localStorage.visitorId || crypto.randomUUID(),
  name: localStorage.meowdokuName || '',
  mode: 'home', single: null, room: null, marks: new Set(), cats: new Set(), dragged: false, dragMarking: false
};
localStorage.visitorId = state.visitorId;
nameInput.value = state.name;
nameInput.addEventListener('input', () => { state.name = nameInput.value.trim(); localStorage.meowdokuName = state.name; });
const palette = ['#ff5d4a', '#ffb000', '#34c759', '#218cff', '#9656e8', '#ec3e8a', '#81cf27', '#00a6a6', '#ff7a00', '#d84a73'];
const api = async (url, options) => {
  const response = await fetch(url, options); const data = await response.json();
  if (!response.ok) throw new Error(data.error || '發生錯誤'); return data;
};
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]);
const playerName = () => state.name || '神秘貓奴';

document.querySelector('#home-button').addEventListener('click', home);
document.querySelector('#admin-button').addEventListener('click', () => document.querySelector('#admin-dialog').showModal());
// Right-click is reserved for puzzle annotation, not the browser context menu.
document.addEventListener('contextmenu', event => event.preventDefault());
document.querySelector('#admin-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = document.querySelector('#publish-level'), message = document.querySelector('#admin-message');
  button.disabled = true; message.textContent = '正在確認唯一解…';
  try {
    const level = await api('/api/admin/levels', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': document.querySelector('#admin-key').value }, body: JSON.stringify({ name: document.querySelector('#level-name').value, size: document.querySelector('#level-size').value }) });
    message.textContent = `已發布「${level.name}」！`; setTimeout(() => document.querySelector('#admin-dialog').close(), 900);
  } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
});

async function home() {
  state.mode = 'home'; state.single = null; state.room = null; state.cats.clear(); state.marks.clear();
  const [levels, leaderboard] = await Promise.all([api('/api/levels'), api('/api/leaderboard')]);
  view.innerHTML = `
    <section class="hero"><div><p class="eyebrow">A LITTLE LOGIC GAME</p><h1>幫每隻貓咪<br><em>找到牠的地盤</em></h1><p>每行、每列與每個色塊都只能住一隻貓。不要點錯，貓咪的尊嚴很脆弱。</p></div><div class="hero-cat" aria-hidden="true">=^･ω･^=</div></section>
    <section class="mode-grid"><article class="mode-card solo"><span class="mode-icon">⌁</span><p class="eyebrow">SOLO MODE</p><h2>獨自推理</h2><p>挑一個關卡，慢慢找到唯一的答案。</p><button class="primary" id="open-solo">選擇關卡</button></article>
    <article class="mode-card multi"><span class="mode-icon">♟</span><p class="eyebrow">MULTIPLAYER</p><h2>貓奴同樂會</h2><p>建立房間、邀朋友進來，一起衝刺。</p><button class="dark-button" id="open-multi">進入多人遊戲</button></article></section>
    <section class="lower-grid"><article class="panel"><div class="section-title"><div><p class="eyebrow">SINGLE PLAYER</p><h2>最新關卡</h2></div><button class="link-button" id="open-solo-2">查看全部</button></div><div class="level-list">${levels.slice(-3).reverse().map((level, i) => `<button class="level-row" data-level="${level.id}"><span class="level-number">${String(levels.length - i).padStart(2, '0')}</span><strong>${escapeHtml(level.name)}</strong><span>${level.size} × ${level.size}</span><b>開始 →</b></button>`).join('')}</div></article>
    <article class="panel leaderboard"><div><p class="eyebrow">CAT HALL OF FAME</p><h2>單人排行榜</h2></div>${leaderboard.length ? `<ol>${leaderboard.slice(0, 5).map((entry, i) => `<li><span>${i + 1}</span><strong>${escapeHtml(entry.name)}</strong><b>${entry.cleared} 關</b></li>`).join('')}</ol>` : '<p class="empty">第一位破關的人，會留在這裡。</p>'}</article></section>`;
  document.querySelector('#open-solo').onclick = showLevels; document.querySelector('#open-solo-2').onclick = showLevels;
  document.querySelector('#open-multi').onclick = showMultiplayer;
  document.querySelectorAll('[data-level]').forEach(button => button.onclick = () => startSingle(button.dataset.level));
}
async function showLevels() {
  const levels = await api('/api/levels'); state.mode = 'levels';
  view.innerHTML = `<section class="page-heading"><button class="back-button" id="back">← 首頁</button><p class="eyebrow">SOLO MODE</p><h1>挑一盒貓罐罐</h1><p>每個關卡都經過唯一解驗證。</p></section><section class="level-catalog">${levels.map((level, index) => `<article class="catalog-card"><span>LEVEL ${String(index + 1).padStart(2, '0')}</span><h2>${escapeHtml(level.name)}</h2><p>${level.size} × ${level.size}，${level.size} 隻貓咪</p><button class="primary" data-level="${level.id}">開始推理</button></article>`).join('')}</section>`;
  document.querySelector('#back').onclick = home; document.querySelectorAll('[data-level]').forEach(button => button.onclick = () => startSingle(button.dataset.level));
}
async function startSingle(id) {
  state.single = await api(`/api/levels/${id}`); state.mode = 'single'; resetBoard(); renderGame();
}
function resetBoard() { state.cats.clear(); state.marks.clear(); state.dragged = false; }
function currentPuzzle() { return state.mode === 'single' ? state.single : state.room?.puzzle; }
function renderGame(message = '') {
  const puzzle = currentPuzzle(); if (!puzzle) return;
  const room = state.room, me = room?.players.find(p => p.id === state.visitorId), isSpectator = me?.spectator;
  const waitingForRoom = state.mode === 'multi' && room.status === 'lobby';
  const footer = state.mode === 'single'
    ? `<p class="hint">左鍵放置貓咪；右鍵標記叉叉。右鍵拖曳可以快速標記。</p>`
    : `<p class="hint">${waitingForRoom ? '房主按下開始前，地圖會保持保密。' : isSpectator ? '觀戰中：可查看大家的進度與排名。' : '左鍵確認貓咪，點錯就淘汰；右鍵僅作個人筆記。'}</p>`;
  const boardArea = waitingForRoom
    ? `<div class="hidden-map"><span>♟</span><h2>地圖已封印</h2><p>房主開始遊戲後，所有人會同時看到題目。</p></div>`
    : `<div class="board-wrap">${renderBoard(puzzle, Boolean(isSpectator || (state.mode === 'multi' && room.status !== 'playing') || me?.alive === false))}</div>`;
  view.innerHTML = `<section class="game-layout"><div class="game-main"><div class="game-top"><button class="back-button" id="quit">← ${state.mode === 'single' ? '關卡列表' : '離開房間'}</button><div>${state.mode === 'single' ? `<p class="eyebrow">SOLO • ${puzzle.size} × ${puzzle.size}</p><h1>${escapeHtml(puzzle.name)}</h1>` : `<p class="eyebrow">ROOM ${room.code}</p><h1>${escapeHtml(room.name)}</h1>`}</div></div><div class="game-status">${state.mode === 'single' ? `<span>找出 <b>${state.cats.size} / ${puzzle.size}</b> 隻貓咪</span>` : gameStatus(room, me)}<span id="game-message">${message}</span></div>${boardArea}${footer}</div>${state.mode === 'multi' ? renderRoomPanel(room, me) : '<aside class="rule-card"><p class="eyebrow">RULES</p><h2>貓咪守則</h2><ul><li>每種顏色恰有一隻貓</li><li>每行、每列恰有一隻貓</li><li>貓咪之間不能相鄰</li><li>點錯一格，挑戰失敗</li></ul></aside>'}</section>`;
  document.querySelector('#quit').onclick = state.mode === 'single' ? showLevels : leaveRoom;
  bindBoard(); bindRoomButtons();
}
function renderBoard(puzzle, locked) {
  return `<div class="board ${locked ? 'locked' : ''}" style="--n:${puzzle.size}">${puzzle.regions.map((region, cell) => {
    const row = Math.floor(cell / puzzle.size), col = cell % puzzle.size, key = `${row}:${col}`;
    return `<button class="cell ${state.cats.has(key) ? 'cat' : ''} ${state.marks.has(key) ? 'mark' : ''}" style="--region:${palette[region % palette.length]}" data-row="${row}" data-col="${col}" aria-label="第 ${row + 1} 行第 ${col + 1} 列">${state.cats.has(key) ? '🐈' : state.marks.has(key) ? '×' : ''}</button>`;
  }).join('')}</div>`;
}
function gameStatus(room, me) {
  const status = room.status === 'lobby' ? '等待房主開始' : room.status === 'finished' ? '本局已結束' : me?.alive === false ? '你已被淘汰，改為觀戰' : `找到 ${state.cats.size} / ${room.puzzle.size} 隻貓咪`;
  return `<span>${status}</span>${room.deadline ? `<span class="sprint">最後衝刺 <b data-deadline="${room.deadline}">60</b>s</span>` : ''}`;
}
function renderRoomPanel(room, me) {
  const isHost = room.hostId === state.visitorId;
  return `<aside class="room-panel"><div><p class="eyebrow">${room.status.toUpperCase()}</p><h2>房間成員</h2></div><div class="people">${room.players.map(player => `<div class="person ${player.id === room.hostId ? 'host' : ''}"><span>${player.spectator ? '◉' : player.alive ? '♟' : '×'}</span><strong>${escapeHtml(player.name)}${player.id === state.visitorId ? '（你）' : ''}</strong><small>${player.id === room.hostId ? '房主' : player.spectator ? '觀戰' : player.completedAt ? '已完成' : `${player.found} / ${room.puzzle.size}`}</small></div>`).join('')}</div>${room.status === 'lobby' ? (isHost ? '<button class="primary wide" id="start-room">開始這局</button>' : '<p class="waiting">等待房主開始遊戲…</p>') : ''}${room.status === 'finished' ? `<div class="results"><p class="eyebrow">RESULTS</p>${(window.lastResults || []).map(row => `<p><b>#${row.rank}</b> ${escapeHtml(row.name)} <span>${row.time}s</span></p>`).join('') || '<p>沒有完成者</p>'}</div>` : ''}<button class="copy-button" id="copy-room">複製房間碼 ${room.code}</button></aside>`;
}
function bindBoard() {
  const cells = document.querySelectorAll('.cell');
  cells.forEach(cell => {
    cell.addEventListener('click', () => chooseCell(cell));
    cell.addEventListener('contextmenu', event => event.preventDefault());
    cell.addEventListener('pointerdown', event => {
      if (event.button !== 2 || cell.closest('.locked')) return;
      event.preventDefault();
      const key = `${cell.dataset.row}:${cell.dataset.col}`;
      state.dragged = true; state.dragMarking = !state.marks.has(key); applyMark(cell, state.dragMarking);
    });
  });
  document.onpointermove = event => {
    if (!state.dragged) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.cell');
    if (cell && !cell.closest('.locked')) applyMark(cell, state.dragMarking);
  };
  document.onpointerup = () => { state.dragged = false; };
}
function applyMark(cell, shouldMark) {
  if (cell.classList.contains('cat')) return;
  const key = `${cell.dataset.row}:${cell.dataset.col}`;
  if (shouldMark) state.marks.add(key); else state.marks.delete(key);
  cell.classList.toggle('mark', shouldMark); cell.textContent = shouldMark ? '×' : '';
}
async function chooseCell(cell) {
  if (cell.closest('.locked')) return;
  const row = Number(cell.dataset.row), col = Number(cell.dataset.col), key = `${row}:${col}`;
  if (state.cats.has(key)) return;
  if (state.mode === 'multi') { socket.emit('guess', { code: state.room.code, playerId: state.visitorId, row, col }); return; }
  const correct = state.single.solution.some(cat => cat.row === row && cat.col === col);
  if (!correct) { renderGame('這格沒有貓咪，挑戰失敗！'); document.querySelector('.board').classList.add('shake', 'locked'); return; }
  state.cats.add(key); state.marks.delete(key);
  if (state.cats.size === state.single.size) {
    await api('/api/single-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visitorId: state.visitorId, name: playerName(), levelId: state.single.id }) });
    renderGame('完美！這盒罐罐是你的了。'); document.querySelector('.board').classList.add('locked');
  } else renderGame('答對了！');
}

function showMultiplayer() {
  state.mode = 'multiplayer';
  view.innerHTML = `<section class="page-heading"><button class="back-button" id="back">← 首頁</button><p class="eyebrow">MULTIPLAYER</p><h1>揪朋友來解題</h1><p>開一間房，傳房間碼，或以觀戰者身分加入。</p></section><section class="lobby-grid"><form class="lobby-card" id="create-room"><p class="eyebrow">CREATE ROOM</p><h2>開新房間</h2><label>房間名稱<input name="roomName" maxlength="40" value="${escapeHtml(playerName())} 的貓咪派對" /></label><label>地圖尺寸<select name="size"><option value="7" selected>7 × 7</option><option value="8">8 × 8</option><option value="9">9 × 9</option><option value="10">10 × 10</option></select></label><button class="primary wide">建立房間</button></form><form class="lobby-card dark" id="join-room"><p class="eyebrow">JOIN ROOM</p><h2>加入朋友房間</h2><label>房間碼<input name="code" maxlength="5" placeholder="例如 AB12C" required /></label><label class="check"><input type="checkbox" name="spectator" /> 以觀戰者身分加入</label><button class="light-button wide">加入房間</button></form></section>`;
  document.querySelector('#back').onclick = home;
  document.querySelector('#create-room').onsubmit = event => { event.preventDefault(); const form = new FormData(event.target); socket.emit('create-room', { name: playerName(), playerId: state.visitorId, roomName: form.get('roomName'), size: form.get('size') }, result => result.error ? alert(result.error) : null); };
  document.querySelector('#join-room').onsubmit = event => { event.preventDefault(); const form = new FormData(event.target); socket.emit('join-room', { code: form.get('code'), name: playerName(), playerId: state.visitorId, spectator: form.has('spectator') }, result => { if (result.error) alert(result.error); }); };
}
function bindRoomButtons() {
  document.querySelector('#start-room')?.addEventListener('click', () => socket.emit('start-game', { code: state.room.code, playerId: state.visitorId }, result => result?.error && alert(result.error)));
  document.querySelector('#copy-room')?.addEventListener('click', async () => { await navigator.clipboard.writeText(state.room.code); const button = document.querySelector('#copy-room'); button.textContent = '已複製！'; setTimeout(() => button.textContent = `複製房間碼 ${state.room.code}`, 1200); });
}
function leaveRoom() { socket.disconnect(); window.location.reload(); }

socket.on('room-state', room => { state.room = room; state.mode = 'multi'; if (room.status === 'playing' && !state.room.players.find(p => p.id === state.visitorId)?.spectator && !state.cats.size) state.marks.clear(); renderGame(); });
socket.on('guess-result', ({ row, col, hit }) => { const key = `${row}:${col}`; if (hit) { state.cats.add(key); state.marks.delete(key); renderGame('答對了！'); } else renderGame('這格沒有貓咪，你被淘汰了。'); });
socket.on('final-sprint', ({ deadline }) => { state.room.deadline = deadline; renderGame('第一位完成！60 秒最後衝刺開始。'); });
socket.on('game-finished', ({ results }) => { window.lastResults = results; renderGame('本局結束！'); showFinishNotice(results); });
setInterval(() => document.querySelectorAll('[data-deadline]').forEach(node => { node.textContent = Math.max(0, Math.ceil((Number(node.dataset.deadline) - Date.now()) / 1000)); }), 250);

function showFinishNotice(results) {
  document.querySelector('#finish-notice')?.remove();
  const notice = document.createElement('section');
  notice.id = 'finish-notice'; notice.className = 'finish-notice'; notice.setAttribute('role', 'alertdialog');
  const podium = results.length
    ? results.slice(0, 3).map(row => `<li><b>#${row.rank}</b><span>${escapeHtml(row.name)}</span><small>${row.time}s</small></li>`).join('')
    : '<li><span>這局還沒有完成者。</span></li>';
  notice.innerHTML = `<span class="finish-cat">🎉</span><p class="eyebrow">GAME FINISHED</p><h2>本局結束！</h2><p>快來看看這次誰最快找到貓咪。</p><ol>${podium}</ol><button class="primary" type="button">查看完整排名</button>`;
  notice.querySelector('button').addEventListener('click', () => notice.remove());
  document.body.append(notice);
}
home();
