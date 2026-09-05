const view = document.querySelector('#view');
const nameInput = document.querySelector('#player-name');
// The socket handshake carries the identity cookie, so it only connects once
// /api/auth/me has made sure that cookie exists.
const socket = io({ autoConnect: false });
const state = {
  // Server-issued identity; the id is what rooms and records are keyed by.
  playerId: null, user: null, guest: null,
  name: localStorage.meowdokuName || '',
  mode: 'home', single: null, room: null, practice: null, practiceStartedAt: 0, practiceMs: null, marks: new Set(), cats: new Set(), pending: new Set(), chat: [], dragged: false, dragMarking: false,
  singleStartedAt: 0, singleMistakes: 0, singleAttemptId: null,
  touchTimer: null, touchStartedAt: 0, touchPointerId: null, lastTouchKey: null, lastTouchAt: 0, suppressClickUntil: 0, watchingPlayerId: null, cleared: new Set(), levels: [], singleCompleted: false, nextSingleId: null, wrong: new Set(), deathFlashId: null, deathFlashRendered: false, connectionLost: false, resumeCode: null, idleNotice: '',
  hintQuota: null, hint: null, hintLevel: 0, hintBusy: false, hintMessage: '', boardView: 'fastest'
};
const anonymousTag = localStorage.meowdokuAnonTag || String(Math.floor(Math.random() * 9000) + 1000);
localStorage.meowdokuAnonTag = anonymousTag;
nameInput.value = state.name;
nameInput.addEventListener('input', () => { state.name = nameInput.value.trim(); localStorage.meowdokuName = state.name; });
// Deep, hue *and* lightness varied so neighbouring regions stay apart even at
// 10 × 10; consecutive entries differ most because region ids grow by BFS.
const DEFAULT_PALETTE = ['#c4423d', '#2b6cb0', '#c07c12', '#2c7a4b', '#6b4b9e', '#8aa625', '#b83f7d',
                         '#159490', '#8a4a1f', '#4b5768', '#7a2f4e', '#1f6f8b'];
const DEFAULT_THEME = { palette: DEFAULT_PALETTE, boardLine: '#c7cad1', paper: '#fffaf1' };
const VALID_COLOR = /^#[0-9a-f]{6}$/i;
const validColor = value => typeof value === 'string' && VALID_COLOR.test(value) ? value : null;
function readTheme() {
  let stored = {};
  try { stored = JSON.parse(localStorage.meowdokuTheme) || {}; } catch {}
  return {
    palette: DEFAULT_PALETTE.map((color, index) => validColor(stored.palette?.[index]) || color),
    boardLine: validColor(stored.boardLine) || DEFAULT_THEME.boardLine,
    paper: validColor(stored.paper) || DEFAULT_THEME.paper
  };
}
const theme = readTheme();
let palette = theme.palette.slice();
function saveTheme() { localStorage.meowdokuTheme = JSON.stringify(theme); }
function applyTheme() {
  const root = document.documentElement;
  root.style.setProperty('--board-line', theme.boardLine);
  root.style.setProperty('--paper', theme.paper);
  palette = theme.palette.slice();
  document.querySelectorAll('.cell').forEach(cell => cell.style.setProperty('--region', palette[Number(cell.dataset.region) % palette.length]));
}
// The selected preset is whichever theme the current colours match exactly, so
// a single tweaked swatch reads as 自訂 without a second piece of stored state.
const sameColor = (a, b) => a.toLowerCase() === b.toLowerCase();
const currentPreset = () => BOARD_THEMES.find(preset => sameColor(preset.boardLine, theme.boardLine) && sameColor(preset.paper, theme.paper) && preset.palette.every((color, index) => sameColor(color, theme.palette[index]))) || null;
function applyPreset(preset) { theme.palette = preset.palette.slice(); theme.boardLine = preset.boardLine; theme.paper = preset.paper; saveTheme(); syncThemeInputs(); applyTheme(); }
function syncThemeInputs() {
  document.querySelectorAll('[data-theme-palette]').forEach(input => { input.value = theme.palette[Number(input.dataset.themePalette)]; });
  document.querySelector('[data-theme-key="boardLine"]').value = theme.boardLine;
  document.querySelector('[data-theme-key="paper"]').value = theme.paper;
  const active = currentPreset();
  document.querySelectorAll('[data-theme-preset]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.themePreset === active?.id)));
  document.querySelector('#theme-preset-hint').textContent = active ? `目前：${active.name}。點選後仍可在下方微調單一顏色。` : '目前：自訂。點選主題會覆蓋下方的顏色。';
}
const api = async (url, options) => {
  const response = await fetch(url, options); const data = await response.json();
  if (!response.ok) throw new Error(data.error || '發生錯誤'); return data;
};
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]);
// A level's rating (difficulty.js) is what orders the ladder, so it is shown
// wherever a level is: stars for the feel, the technique for what to look for.
const stars = rating => '★'.repeat(rating.stars) + '☆'.repeat(5 - rating.stars);
const ratingLine = rating => rating ? `<span class="rating"><b>${stars(rating)}</b>${escapeHtml(rating.hardestName)} · ${rating.score} 分</span>` : '';
// Ladder rungs carry chapter/stage data; admin levels fall back to their place
// in the sorted catalogue so both kinds read as "which level is this".
const stageLabel = (level, fallbackIndex) => level.ladder ? `第 ${level.ladder.stage} 關 · ${escapeHtml(level.ladder.chapter)} ${level.ladder.chapterStage}/${level.ladder.chapterLength}` : `LEVEL ${String(fallbackIndex + 1).padStart(3, '0')}`;
const playerName = () => state.name || state.user?.displayName || `神祕貓奴 #${anonymousTag}`;
// Practice (upsolve) borrows the whole single-player board, only the scoring
// and the wrong-click rule differ.
const soloMode = () => state.mode === 'single' || state.mode === 'practice';
const matchDate = value => new Date(value).toLocaleString('zh-Hant', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const outcomeLabel = outcome => outcome.status === 'solved' ? `第 ${outcome.rank} 名 · ${outcome.time}s` : outcome.status === 'eliminated' ? '被淘汰' : '時間到未完成';
const DEFAULT_AVATAR = '🐱';
const FRAME_ID = /^[a-z]+$/;
// Frames are CSS classes; the id is whitelisted so a stray value cannot
// smuggle in another class name.
const avatarHtml = (avatar, frame, extra = '') => `<span class="avatar frame-${FRAME_ID.test(frame || '') ? frame : 'plain'} ${extra}" aria-hidden="true">${escapeHtml(avatar || DEFAULT_AVATAR)}</span>`;

document.querySelector('#home-button').addEventListener('click', home);
document.querySelector('#admin-button').addEventListener('click', () => { adminFeedback(); document.querySelector('#admin-dialog').showModal(); if (document.querySelector('#admin-form').dataset.tab === 'order') loadLevelOrder(); });
document.querySelectorAll('[data-admin-tab]').forEach(button => button.addEventListener('click', () => setAdminTab(button.dataset.adminTab)));
function setAdminTab(tab) {
  document.querySelectorAll('[data-admin-tab]').forEach(button => button.classList.toggle('active', button.dataset.adminTab === tab));
  document.querySelectorAll('[data-admin-pane]').forEach(pane => { pane.hidden = pane.dataset.adminPane !== tab; });
  document.querySelector('#admin-form').dataset.tab = tab;
  adminFeedback();
  if (tab === 'order') loadLevelOrder();
}
document.querySelector('#admin-dialog .close').addEventListener('click', () => document.querySelector('#admin-dialog').close());
document.querySelector('#auth-button').addEventListener('click', () => { setAuthTab('login'); document.querySelector('#auth-message').textContent = ''; document.querySelector('#auth-dialog').showModal(); });
document.querySelector('#auth-dialog .close').addEventListener('click', () => document.querySelector('#auth-dialog').close());
document.querySelectorAll('[data-auth-tab]').forEach(button => button.addEventListener('click', () => setAuthTab(button.dataset.authTab)));
function setAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach(button => button.classList.toggle('active', button.dataset.authTab === tab));
  document.querySelector('#auth-form').dataset.mode = tab;
  document.querySelector('#auth-submit').textContent = tab === 'register' ? '註冊帳號' : '登入';
  document.querySelector('#auth-username').focus();
}
// The top bar tells a guest what is at stake: nothing of theirs survives a
// closed tab until they sign in.
function renderAuth() {
  const button = document.querySelector('#auth-button'), account = document.querySelector('#account');
  const isUser = Boolean(state.user);
  button.hidden = isUser; account.hidden = !isUser;
  if (isUser) { document.querySelector('#account-name').textContent = state.user.displayName; document.querySelector('#account-avatar').innerHTML = avatarHtml(state.user.avatar, state.user.frame, 'small'); }
  document.querySelector('#admin-button').hidden = !state.user?.isAdmin;
  document.querySelector('#guest-notice').textContent = state.guest?.notice || '';
}
async function loadIdentity() {
  const me = await api('/api/auth/me');
  state.user = me.user; state.guest = me.guest; state.playerId = me.user?.id || me.guest?.id || null;
  renderAuth();
}
document.querySelector('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, mode = form.dataset.mode === 'register' ? 'register' : 'login', message = document.querySelector('#auth-message'), button = document.querySelector('#auth-submit');
  button.disabled = true; message.textContent = mode === 'register' ? '正在建立帳號…' : '正在登入…';
  try {
    await api(`/api/auth/${mode}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: document.querySelector('#auth-username').value.trim(), password: document.querySelector('#auth-password').value }) });
    message.textContent = mode === 'register' ? '註冊成功！' : '登入成功！';
    // Signing in swaps the identity cookie, so the socket and every cached
    // view start over from a reload.
    window.location.reload();
  } catch (error) { message.textContent = error.message; button.disabled = false; }
});
document.querySelector('#profile-button').addEventListener('click', showProfile);
document.querySelector('#logout-button').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  window.location.reload();
});
document.querySelector('#theme-button').addEventListener('click', () => { syncThemeInputs(); document.querySelector('#theme-dialog').showModal(); });
document.querySelector('#theme-dialog .close').addEventListener('click', () => document.querySelector('#theme-dialog').close());
document.querySelector('#theme-preset-list').innerHTML = BOARD_THEMES.map(preset => `<button type="button" role="radio" aria-checked="false" data-theme-preset="${preset.id}" style="--paper-swatch:${preset.paper}"><span class="preset-swatches">${preset.palette.slice(0, 6).map(color => `<i style="background:${color}"></i>`).join('')}</span>${escapeHtml(preset.name)}</button>`).join('');
document.querySelectorAll('[data-theme-preset]').forEach(button => button.addEventListener('click', () => applyPreset(BOARD_THEMES.find(preset => preset.id === button.dataset.themePreset))));
document.querySelectorAll('[data-theme-palette]').forEach(input => input.addEventListener('input', () => { theme.palette[Number(input.dataset.themePalette)] = input.value; saveTheme(); syncThemeInputs(); applyTheme(); }));
document.querySelectorAll('[data-theme-key]').forEach(input => input.addEventListener('input', () => { theme[input.dataset.themeKey] = input.value; saveTheme(); syncThemeInputs(); applyTheme(); }));
document.querySelector('#reset-theme').addEventListener('click', () => applyPreset(DEFAULT_THEME));
applyTheme();
// Right-click is reserved for puzzle annotation, not the browser context menu.
document.addEventListener('contextmenu', event => event.preventDefault());
// Errors from the admin API carry the full list of problems, not just the
// first, so the dialog shows them as a list and keeps the single-line message
// for progress and success.
function adminFeedback(message = '', errors = [], preview = null) {
  document.querySelector('#admin-message').textContent = message;
  const list = document.querySelector('#admin-errors');
  list.hidden = !errors.length; list.innerHTML = errors.map(error => `<li>${escapeHtml(error)}</li>`).join('');
  const box = document.querySelector('#admin-preview');
  box.hidden = !preview;
  box.innerHTML = preview ? `${previewBoard(preview)}<div><strong>${escapeHtml(preview.name || `${preview.size} × ${preview.size}`)}</strong><small>${preview.size} × ${preview.size}，${preview.size} 隻貓咪</small>${ratingLine(preview.rating)}</div>` : '';
}
// A miniature, inert board for the admin dialog: spans instead of buttons so
// nothing inside the form can submit it.
function previewBoard(puzzle) {
  const cats = new Set((puzzle.solution || []).map(cat => `${cat.row}:${cat.col}`));
  return `<div class="board locked" style="--n:${puzzle.size}">${puzzle.regions.map((region, cell) => {
    const key = `${Math.floor(cell / puzzle.size)}:${cell % puzzle.size}`;
    return `<span class="cell ${cats.has(key) ? 'cat' : ''}" style="--region:${palette[region % palette.length]}" data-region="${region}">${cats.has(key) ? '🐈' : ''}</span>`;
  }).join('')}</div>`;
}
const adminPost = (url, body, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => {
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '發生錯誤'), { errors: data.errors || [] });
  return data;
});
const publishedLine = (verb, level) => `${verb}「${level.name}」！${level.rating ? ` 難度 ${stars(level.rating)}（${level.rating.hardestName}，${level.rating.score} 分）` : ''}`;
document.querySelector('#admin-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (document.querySelector('#admin-form').dataset.tab !== 'generate') return;
  const button = document.querySelector('#publish-level');
  button.disabled = true; adminFeedback('正在產生并確認唯一解…');
  try {
    const level = await adminPost('/api/admin/levels', { name: document.querySelector('#level-name').value, size: document.querySelector('#level-size').value });
    adminFeedback(publishedLine('已發布', level), [], level);
  } catch (error) { adminFeedback(error.message, error.errors); } finally { button.disabled = false; }
});
const importBody = () => ({ name: document.querySelector('#import-name').value, size: document.querySelector('#import-size').value, text: document.querySelector('#map-text').value });
document.querySelector('#validate-level').addEventListener('click', async () => {
  const button = document.querySelector('#validate-level');
  button.disabled = true; adminFeedback('正在檢驗地圖…');
  try {
    const result = await adminPost('/api/admin/levels/validate', importBody());
    adminFeedback('地圖合法，可以發布。', [], { ...result, name: document.querySelector('#import-name').value });
  } catch (error) { adminFeedback(error.errors?.length > 1 ? `地圖有 ${error.errors.length} 個問題：` : '地圖不合法：', error.errors?.length ? error.errors : [error.message]); } finally { button.disabled = false; }
});
document.querySelector('#import-level').addEventListener('click', async () => {
  const button = document.querySelector('#import-level');
  button.disabled = true; adminFeedback('正在檢驗并發布地圖…');
  try {
    const level = await adminPost('/api/admin/levels/import', importBody());
    adminFeedback(publishedLine('已發布', level), [], level);
  } catch (error) { adminFeedback(error.errors?.length > 1 ? `地圖有 ${error.errors.length} 個問題，尚未發布：` : '地圖不合法，尚未發布：', error.errors?.length ? error.errors : [error.message]); } finally { button.disabled = false; }
});
// The order pane edits a local copy; nothing changes on the server until saved.
let orderDraft = [];
async function loadLevelOrder() {
  orderDraft = await api('/api/levels');
  renderLevelOrder();
}
function moveLevel(from, to) {
  if (to < 0 || to >= orderDraft.length || from === to) return;
  const [level] = orderDraft.splice(from, 1); orderDraft.splice(to, 0, level);
  renderLevelOrder();
}
function renderLevelOrder() {
  const list = document.querySelector('#level-order');
  list.innerHTML = orderDraft.map((level, index) => `<li draggable="true" data-index="${index}"><span>${String(index + 1).padStart(3, '0')}</span><div>${escapeHtml(level.name)}<small>${level.size} × ${level.size}${level.rating ? ` · ${stars(level.rating)} ${level.rating.score} 分` : ''}</small></div><button type="button" data-move="-1" aria-label="上移" ${index === 0 ? 'disabled' : ''}>▲</button><button type="button" data-move="1" aria-label="下移" ${index === orderDraft.length - 1 ? 'disabled' : ''}>▼</button></li>`).join('') || '<li><small>還沒有關卡。</small></li>';
  list.querySelectorAll('[data-move]').forEach(button => button.onclick = () => { const index = Number(button.closest('li').dataset.index); moveLevel(index, index + Number(button.dataset.move)); });
  let dragging = null;
  list.querySelectorAll('li[draggable]').forEach(item => {
    item.ondragstart = event => { dragging = Number(item.dataset.index); item.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; };
    item.ondragend = () => { dragging = null; list.querySelectorAll('li').forEach(row => row.classList.remove('dragging', 'drop-before', 'drop-after')); };
    // offsetY is relative to whichever child was hit, so measure against the row.
    const upperHalf = event => { const box = item.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; };
    item.ondragover = event => {
      if (dragging === null) return;
      event.preventDefault();
      const before = upperHalf(event);
      list.querySelectorAll('li').forEach(row => row.classList.remove('drop-before', 'drop-after'));
      item.classList.add(before ? 'drop-before' : 'drop-after');
    };
    item.ondrop = event => {
      event.preventDefault();
      if (dragging === null) return;
      const target = Number(item.dataset.index), before = upperHalf(event);
      let to = before ? target : target + 1;
      if (dragging < to) to--;
      moveLevel(dragging, to);
    };
  });
}
document.querySelector('#reload-order').addEventListener('click', () => { adminFeedback(); loadLevelOrder(); });
document.querySelector('#save-order').addEventListener('click', async () => {
  const button = document.querySelector('#save-order');
  button.disabled = true; adminFeedback('正在儲存順序…');
  try {
    orderDraft = await adminPost('/api/admin/levels/order', { ids: orderDraft.map(level => level.id) }, 'PUT');
    renderLevelOrder(); adminFeedback('關卡順序已儲存。');
    if (state.mode === 'home') home(); else if (state.mode === 'levels') showLevels();
  } catch (error) { adminFeedback(error.message, error.errors); } finally { button.disabled = false; }
});

async function home() {
  state.mode = 'home'; state.single = null; state.room = null; state.practice = null; state.cats.clear(); state.marks.clear();
  const [levels, leaderboard, progress] = await Promise.all([api('/api/levels'), api('/api/leaderboard'), api('/api/progress/me')]);
  state.levels = levels; state.cleared = new Set(progress.cleared);
  const nextIndex = levels.findIndex(level => !state.cleared.has(level.id));
  const nextLevel = levels[nextIndex === -1 ? levels.length - 1 : nextIndex] || null;
  const continueLabel = !nextLevel ? '關卡正在準備' : nextIndex === -1 ? '全部通關！再玩一次' : stageLabel(nextLevel, nextIndex);
  view.innerHTML = `
    <section class="hero"><div><p class="eyebrow">A LITTLE LOGIC GAME</p><h1>幫每隻貓咪<br><em>找到牠的地盤</em></h1><p>每行、每列與每個色塊都只能住一隻貓。不要點錯，貓咪的尊嚴很脆弱。</p></div><div class="hero-cat" aria-hidden="true">=^･ω･^=</div></section>
    <section class="mode-grid"><article class="mode-card solo"><span class="mode-icon">⌁</span><p class="eyebrow">SOLO MODE</p><h2>獨自推理</h2><p>挑一個關卡，慢慢找到唯一的答案。</p><button class="primary" id="open-solo">選擇關卡</button></article>
    <article class="mode-card multi"><span class="mode-icon">♟</span><p class="eyebrow">MULTIPLAYER</p><h2>貓奴同樂會</h2><p>建立房間、邀朋友進來，一起衝刺。</p><button class="dark-button" id="open-multi">進入多人遊戲</button><button class="link-button" id="open-history">對戰紀錄（重新解題）</button></article></section>
    <section class="lower-grid"><article class="panel continue-panel"><div><p class="eyebrow">SINGLE PLAYER</p><h2>接著挑戰</h2><p>${!nextLevel ? '難度階梯正在產生，稍等幾秒再回來。' : nextIndex === -1 ? '所有罐罐都找到了，真是傳奇貓奴。' : '解完前一關，下一盒罐罐正在等你。'}</p></div><div class="continue-level"><span>${continueLabel}</span><strong>${nextLevel ? escapeHtml(nextLevel.name) : '尚未有關卡'}</strong><small>${nextLevel ? `${nextLevel.size} × ${nextLevel.size}` : '貓咪還在畫地圖'}</small>${nextLevel ? ratingLine(nextLevel.rating) : ''}</div><button class="primary" id="continue-solo" ${nextLevel ? '' : 'disabled'}>${nextIndex === -1 ? '再次挑戰 →' : '繼續解題 →'}</button><button class="link-button" id="open-solo-2">查看全部關卡</button></article>
    <article class="panel leaderboard"><div><p class="eyebrow">CAT HALL OF FAME</p><h2>單人排行榜</h2></div>${leaderboard.top.length ? `<ol>${leaderboard.top.map(entry => `<li class="${entry.me ? 'me' : ''}"><span>${entry.rank}</span>${avatarHtml(entry.avatar, entry.frame, 'small')}<strong>${escapeHtml(entry.name)}${entry.me ? '（你）' : ''}</strong><b>${entry.cleared} 關</b></li>`).join('')}</ol>` : '<p class="empty">第一位破關的人，會留在這裡。</p>'}${myRankLine(leaderboard)}</article></section>`;
  document.querySelector('#open-solo').onclick = showLevels; document.querySelector('#open-solo-2').onclick = showLevels;
  document.querySelector('#open-multi').onclick = showMultiplayer;
  document.querySelector('#open-history').onclick = showHistory;
  if (nextLevel) document.querySelector('#continue-solo').onclick = () => startSingle(nextLevel.id);
}
// The rank comes from the server; a guest is told to sign in rather than
// shown a number that would vanish with the cookie.
function myRankLine(leaderboard) {
  if (!leaderboard.me) return '<p class="my-rank">登入才會有排名。</p>';
  if (leaderboard.me.inTop) return '';
  return `<p class="my-rank">你目前第 <b>${leaderboard.me.rank}</b> 名 / 共 ${leaderboard.me.total} 人（${leaderboard.me.cleared} 關）</p>`;
}
async function showLevels() {
  const [levels, progress] = await Promise.all([api('/api/levels'), api('/api/progress/me')]);
  state.levels = levels; state.cleared = new Set(progress.cleared); state.mode = 'levels';
  const clearedCount = levels.filter(level => state.cleared.has(level.id)).length;
  view.innerHTML = `<section class="page-heading"><button class="back-button" id="back">← 首頁</button><p class="eyebrow">SOLO MODE</p><h1>一步一腳印解鎖</h1><p>已通過 <b>${clearedCount}</b> / ${levels.length} 關。關卡依難度排序，完成前一關才能打開下一盒罐罐。</p></section>${levels.length ? '' : '<section class="panel"><p class="empty">難度階梯正在產生，稍等幾秒再重新整理。</p></section>'}<section class="level-catalog">${levels.map((level, index) => {
    // A level already cleared stays replayable even when a newly rated level
    // sorts in front of it and pushes an uncleared board in between.
    const cleared = state.cleared.has(level.id), unlocked = cleared || index === 0 || state.cleared.has(levels[index - 1].id);
    return `<article class="catalog-card ${cleared ? 'cleared' : ''} ${unlocked ? '' : 'locked-level'}"><span>${stageLabel(level, index)}</span><h2>${escapeHtml(level.name)}</h2><p>${level.size} × ${level.size}，${level.size} 隻貓咪</p>${ratingLine(level.rating)}<button class="primary" ${unlocked ? `data-level="${level.id}"` : 'disabled'}>${cleared ? '✓ 已通過，再玩一次' : unlocked ? '開始推理' : '🔒 尚未解鎖'}</button></article>`;
  }).join('')}</section>`;
  document.querySelector('#back').onclick = home; document.querySelectorAll('[data-level]').forEach(button => button.onclick = () => startSingle(button.dataset.level));
}
async function startSingle(id) {
  if (!state.levels.length) state.levels = await api('/api/levels');
  state.single = await api(`/api/levels/${id}`); state.mode = 'single'; state.singleCompleted = false; state.nextSingleId = null;
  // Mistakes accumulate across retries of the same level until it is cleared.
  if (state.singleAttemptId !== id) { state.singleAttemptId = id; state.singleMistakes = 0; }
  state.singleStartedAt = Date.now();
  resetBoard(); renderGame(); loadHintQuota();
}
async function showHistory() {
  const records = await api('/api/history/me');
  state.mode = 'history'; state.room = null; state.practice = null;
  view.innerHTML = `<section class="page-heading"><button class="back-button" id="back">← 首頁</button><p class="eyebrow">MATCH HISTORY</p><h1>對戰紀錄</h1><p>點選任一場對戰，重新打開那張地圖慢慢解。練習不計入單人進度與排行榜。</p></section><section class="level-catalog">${records.length ? records.map(record => `<article class="catalog-card"><span>${escapeHtml(matchDate(record.finishedAt))} · ROOM ${escapeHtml(record.code)}</span><h2>${escapeHtml(record.roomName)}</h2><p>${record.size} × ${record.size}，你：${escapeHtml(outcomeLabel(record.outcome))}；冠軍：${record.results[0] ? `${escapeHtml(record.results[0].name)} ${record.results[0].time}s` : '無人完成'}</p><button class="primary" data-match="${escapeHtml(record.matchId)}">重新解這張圖</button></article>`).join('') : '<p class="empty">還沒有對戰紀錄。去多人房間跑一場，這裡就會留下地圖。</p>'}</section>`;
  document.querySelector('#back').onclick = home;
  document.querySelectorAll('[data-match]').forEach(button => button.onclick = () => startPractice(records.find(record => record.matchId === button.dataset.match)));
}
function startPractice(record) {
  if (!record) return;
  state.practice = record; state.mode = 'practice'; state.singleCompleted = false; state.practiceMs = null; state.practiceStartedAt = Date.now();
  state.single = { id: record.matchId, name: record.roomName, size: record.size, regions: record.regions, solution: record.solution };
  resetBoard(); renderGame(); loadHintQuota();
}
function resetBoard() { state.cats.clear(); state.marks.clear(); state.wrong.clear(); state.pending.clear(); state.dragged = false; state.hint = null; state.hintLevel = 0; state.hintMessage = ''; }
function currentPuzzle() { return soloMode() ? state.single : state.room?.puzzle; }
// Re-creating the whole view costs a full board rebuild plus a fresh set of
// listeners on every cell. In a room that happens on every broadcast, which is
// why a click used to feel sticky, so anything that leaves the page structure
// intact takes the patch path instead.
let renderedLayout = '';
function renderGame(message = '') {
  const puzzle = currentPuzzle(); if (!puzzle) return;
  const room = state.room, me = room?.players.find(p => p.id === state.playerId), isSpectator = me?.spectator;
  // Finished players are spectators too: their own board is frozen, while
  // they can switch to any remaining player's live board.
  const isViewing = Boolean(isSpectator || me?.alive === false || me?.completedAt);
  const waitingForRoom = state.mode === 'multi' && (room.status === 'lobby' || room.status === 'countdown');
  const footer = soloMode()
    ? `<p class="hint">左鍵放置貓咪；右鍵標記叉叉。右鍵拖曳可以快速標記。${state.mode === 'practice' ? '這是練習，點錯不會結束，繼續推理就好。' : ''}</p>`
    : `<p class="hint">${room.status === 'countdown' ? '準備好了嗎？所有玩家會同時開局。' : waitingForRoom ? '房主按下開始前，地圖會保持保密。' : isViewing ? '點選右側玩家名稱，即可查看他的即時棋盤與標記。' : '左鍵確認貓咪，點錯就淘汰；右鍵僅作個人筆記。'}</p>`;
  const boardArea = waitingForRoom
    ? `<div class="hidden-map"><span>${room.status === 'countdown' ? '<b data-countdown="' + room.countdownEnds + '">3</b>' : '♟'}</span><h2>${room.status === 'countdown' ? '即將開始！' : '地圖已封印'}</h2><p>${room.status === 'countdown' ? '倒數結束後，題目會同時揭曉。' : '房主開始遊戲後，所有人會同時看到題目。'}</p></div>`
    : `<div class="board-wrap">${renderBoard(puzzle, Boolean(isViewing || state.connectionLost || (state.mode === 'multi' && room.status !== 'playing')), viewedBoard(me, isViewing))}</div>`;
  const nextAction = state.mode === 'practice' ? practiceAction() : state.mode === 'single' && state.singleCompleted ? `<div class="next-action">${state.nextSingleId ? '<button class="primary" id="next-level">前往下一關 →</button>' : '<button class="primary" id="next-level">回到關卡列表</button>'}</div>` : '';
  const layout = [state.mode, room?.code || '', puzzle.id || '', puzzle.size, room?.status || '', waitingForRoom, Boolean(isViewing), state.singleCompleted, state.nextSingleId, state.connectionLost].join('|');
  if (layout === renderedLayout && document.querySelector('.game-layout')) {
    patchGame(puzzle, room, me, isViewing, message);
    return;
  }
  renderedLayout = layout;
  view.innerHTML = `<section class="game-layout"><div class="game-main"><div class="game-top"><button class="back-button" id="quit">← ${state.mode === 'practice' ? '對戰紀錄' : state.mode === 'single' ? '關卡列表' : '離開房間'}</button><div>${soloMode() ? `<p class="eyebrow">${state.mode === 'practice' ? `PRACTICE • ROOM ${escapeHtml(state.practice.code)}` : puzzle.ladder ? stageLabel(puzzle) : 'SOLO'} • ${puzzle.size} × ${puzzle.size}</p><h1>${escapeHtml(puzzle.name)}</h1>${ratingLine(puzzle.rating)}` : `<p class="eyebrow">ROOM ${room.code}</p><h1>${escapeHtml(room.name)}</h1>`}</div></div><div class="game-status">${statusBar(puzzle, room, me)}<span id="game-message">${message}</span></div>${boardArea}${footer}${soloMode() ? `<div class="hint-panel" id="hint-panel">${renderHintPanel()}</div>` : ''}${nextAction}</div>${state.mode === 'multi' ? `<div class="side-panels">${renderRoomPanel(room, me)}${renderChatPanel()}</div>` : `<aside class="rule-card"><p class="eyebrow">RULES</p><h2>貓咪守則</h2><ul><li>每種顏色恰有一隻貓</li><li>每行、每列恰有一隻貓</li><li>貓咪之間不能相鄰</li><li>${state.mode === 'practice' ? '練習模式：點錯不會結束' : '點錯一格，挑戰失敗'}</li></ul></aside>`}</section>`;
  document.querySelector('#quit').onclick = state.mode === 'practice' ? showHistory : state.mode === 'single' ? showLevels : leaveRoom;
  document.querySelector('#next-level')?.addEventListener('click', () => state.nextSingleId ? startSingle(state.nextSingleId) : showLevels());
  bindPracticeButtons(); bindHintPanel();
  bindBoard(); bindRoomButtons(); bindChat();
  applyHintHighlight();
}
// Hints are solo-only. One request buys a three-layer hint; the layers are
// revealed locally, so reading all the way down never costs more. Highlights
// are CSS classes toggled on the existing cells — the board is never rebuilt.
async function loadHintQuota() {
  try { const quota = await api('/api/hints/quota'); state.hintQuota = quota.remaining; }
  catch { state.hintQuota = null; }
  refreshHintPanel();
}
function renderHintPanel() {
  const remaining = state.hintQuota;
  const label = remaining === null ? '提示' : `提示（今天還有 ${remaining} 次）`;
  const disabled = state.hintBusy || state.singleCompleted || remaining === 0;
  const tiers = state.hint ? state.hint.tiers.slice(0, state.hintLevel) : [];
  const more = state.hint && state.hintLevel < state.hint.tiers.length ? '<button class="link-button" id="hint-more">再說詳細一點 →</button>' : '';
  return `<div class="hint-actions"><button class="quiet-button" id="hint-button" ${disabled ? 'disabled' : ''}>💡 ${label}</button>${remaining === 0 ? '<small class="hint-note">今天的提示用完了，明天再來領 3 次</small>' : ''}<small class="hint-note" id="hint-message">${escapeHtml(state.hintMessage)}</small></div>${tiers.length ? `<div class="hint-card"><p class="eyebrow">HINT · ${escapeHtml(state.hint.ruleName)}</p>${tiers.map(tier => `<p class="hint-tier">${escapeHtml(tier.text)}</p>`).join('')}${more}</div>` : ''}`;
}
function refreshHintPanel() {
  const panel = document.querySelector('#hint-panel'); if (!panel || !soloMode()) return;
  panel.innerHTML = renderHintPanel(); bindHintPanel(); applyHintHighlight();
}
function bindHintPanel() {
  document.querySelector('#hint-button')?.addEventListener('click', requestHint);
  document.querySelector('#hint-more')?.addEventListener('click', () => { if (state.hint && state.hintLevel < state.hint.tiers.length) { state.hintLevel++; refreshHintPanel(); } });
}
async function requestHint() {
  if (!soloMode() || state.hintBusy || !state.single) return;
  state.hintBusy = true; state.hintMessage = ''; refreshHintPanel();
  const body = { cats: [...state.cats], marks: [...state.marks], ...(state.mode === 'practice' ? { matchId: state.single.id } : { levelId: state.single.id }) };
  try {
    const result = await api('/api/hints', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    state.hint = result.hint; state.hintLevel = 1; state.hintQuota = result.quota?.remaining ?? state.hintQuota;
  } catch (error) { state.hintMessage = error.message; }
  finally { state.hintBusy = false; refreshHintPanel(); }
}
function clearHint() { if (!state.hint && !state.hintMessage) return; state.hint = null; state.hintLevel = 0; state.hintMessage = ''; refreshHintPanel(); }
function applyHintHighlight() {
  const cells = document.querySelectorAll('.cell'); if (!cells.length) return;
  const focus = soloMode() && state.hint ? state.hint.tiers[state.hintLevel - 1]?.focus : null;
  const rows = new Set(focus?.rows || []), cols = new Set(focus?.cols || []), regions = new Set(focus?.regions || []);
  const exact = new Set((focus?.cells || []).map(cell => `${cell.row}:${cell.col}`));
  const any = rows.size || cols.size || regions.size || exact.size;
  document.querySelector('.board')?.classList.toggle('hinting', Boolean(any));
  for (const cell of cells) {
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    cell.classList.toggle('hl-unit', Boolean(any) && (rows.has(Number(cell.dataset.row)) || cols.has(Number(cell.dataset.col)) || regions.has(Number(cell.dataset.region))));
    cell.classList.toggle('hl-cell', exact.has(key));
  }
}
// Practice keeps the live single-player counter and adds its own clock; the
// match comparison only appears once the board is solved.
function statusBar(puzzle, room, me) {
  if (!soloMode()) return gameStatus(room, me);
  const clock = state.mode === 'practice' ? `<span class="sprint">練習用時 <b data-practice="${state.practiceStartedAt}">${((state.practiceMs ?? (Date.now() - state.practiceStartedAt)) / 1000).toFixed(1)}</b>s</span>` : '';
  return `<span>找出 <b>${state.cats.size} / ${puzzle.size}</b> 隻貓咪</span>${clock}`;
}
function practiceAction() {
  if (!state.singleCompleted) return '';
  const { outcome, results } = state.practice;
  const winner = results[0] ? `冠軍 ${escapeHtml(results[0].name)} ${results[0].time}s` : '本局沒有完成者';
  const mine = outcome.status === 'solved' ? `當時你以 ${outcome.time}s 拿下第 ${outcome.rank} 名` : outcome.status === 'eliminated' ? `當時你點錯 ${outcome.wrong.length} 格被淘汰，找到 ${outcome.cats} 隻貓` : `當時時間到還沒解完，找到 ${outcome.cats} 隻貓`;
  return `<div class="next-action practice-compare"><p>練習完成！這次用了 <b>${(state.practiceMs / 1000).toFixed(1)}s</b>。</p><p>${mine}；${winner}。</p><button class="primary" id="practice-again">再練習一次</button><button class="link-button" id="practice-back">回到對戰紀錄</button></div>`;
}
function bindPracticeButtons() {
  document.querySelector('#practice-again')?.addEventListener('click', () => startPractice(state.practice));
  document.querySelector('#practice-back')?.addEventListener('click', showHistory);
}
function patchGame(puzzle, room, me, isViewing, message) {
  document.querySelector('.game-status').innerHTML = `${statusBar(puzzle, room, me)}<span id="game-message">${message}</span>`;
  patchBoard(viewedBoard(me, isViewing));
  if (state.mode !== 'multi') return;
  const panel = document.querySelector('.room-panel'), html = renderRoomPanel(room, me);
  if (panel && panel.outerHTML !== html) {
    const sprintFocused = document.activeElement?.id === 'sprint-value', passwordFocused = document.activeElement?.id === 'room-password', typedPassword = document.querySelector('#room-password')?.value || '';
    panel.outerHTML = html; bindRoomButtons();
    if (sprintFocused) { const input = document.querySelector('#sprint-value'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }
    const password = document.querySelector('#room-password');
    if (password && typedPassword) { password.value = typedPassword; if (passwordFocused) { password.focus(); password.setSelectionRange(typedPassword.length, typedPassword.length); } }
  }
}
function patchBoard(boardState) {
  for (const cell of document.querySelectorAll('.cell')) {
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    const cat = boardState.cats.has(key), wrong = Boolean(boardState.wrong?.has(key)), mark = boardState.marks.has(key);
    cell.classList.toggle('cat', cat); cell.classList.toggle('wrong', wrong); cell.classList.toggle('mark', mark && !cat && !wrong);
    cell.classList.toggle('pending', state.pending.has(key) && !cat && !wrong);
    const content = cellContent(cat, wrong, mark);
    if (cell.innerHTML !== content) cell.innerHTML = content;
  }
}
function viewedBoard(me, isViewing) {
  if (state.mode !== 'multi' || !isViewing) return { cats: state.cats, marks: state.marks, wrong: state.wrong };
  const target = state.room.players.find(player => player.id === state.watchingPlayerId && !player.spectator) || state.room.players.find(player => !player.spectator);
  return { cats: new Set(target?.cats || []), marks: new Set(target?.marks || []), wrong: new Set(target?.wrong || []) };
}
function cellContent(cat, wrong, mark) { return cat ? '<span class="cat-icon">🐈</span>' : wrong || mark ? '×' : ''; }
function renderBoard(puzzle, locked, boardState = { cats: state.cats, marks: state.marks, wrong: state.wrong }) {
  return `<div class="board ${locked ? 'locked' : ''}" style="--n:${puzzle.size}">${puzzle.regions.map((region, cell) => {
    const row = Math.floor(cell / puzzle.size), col = cell % puzzle.size, key = `${row}:${col}`;
    const cat = boardState.cats.has(key), wrong = Boolean(boardState.wrong?.has(key)), mark = boardState.marks.has(key);
    return `<button class="cell ${cat ? 'cat' : ''} ${mark && !cat && !wrong ? 'mark' : ''} ${wrong ? 'wrong' : ''} ${state.pending.has(key) && !cat && !wrong ? 'pending' : ''}" style="--region:${palette[region % palette.length]}" data-region="${region}" data-row="${row}" data-col="${col}" aria-label="第 ${row + 1} 行第 ${col + 1} 列">${cellContent(cat, wrong, mark)}</button>`;
  }).join('')}</div>`;
}
function gameStatus(room, me) {
  const status = state.connectionLost ? '連線中斷，正在重新連線…' : state.idleNotice && me?.spectator ? state.idleNotice : room.status === 'lobby' ? '等待房主開始' : room.status === 'countdown' ? '3 秒倒數中' : room.status === 'finished' ? '本局已結束' : me?.completedAt ? '你已完成，現在可以觀戰' : me?.alive === false ? '你已被淘汰，改為觀戰' : `找到 ${state.cats.size} / ${room.puzzle.size} 隻貓咪`;
  return `<span>${status}</span>${room.deadline ? `<span class="sprint">最後衝刺 <b data-deadline="${room.deadline}">${remainingSeconds(room.deadline)}</b>s</span>` : ''}`;
}
function remainingSeconds(deadline) { return Math.max(0, Math.ceil((Number(deadline) - Date.now()) / 1000)); }
function renderRoomPanel(room, me) {
  const isHost = me?.host === true;
  const canWatch = Boolean(me?.spectator || me?.alive === false || me?.completedAt);
  const watching = room.players.find(player => player.id === state.watchingPlayerId);
  const live = room.status === 'countdown' || room.status === 'playing';
  const replay = isHost
    ? `<button class="${room.status === 'finished' ? 'primary' : 'copy-button'} wide" id="restart-room" ${room.restartPending ? 'disabled' : ''}>${room.restartPending ? '準備中…' : room.status === 'finished' ? '用原房號再來一局' : live ? '直接重開這一局' : '換一張新地圖'}</button>${live ? '<small class="restart-hint">進行中重開會作廢本局，不計入積分與最快紀錄。</small>' : ''}`
    : room.restartPending ? '<p class="waiting">房主正在準備新題目…</p>' : '';
  const blocked = isHost && room.kicked?.length
    ? `<div class="blocked-list"><p class="eyebrow">BLOCKED</p>${room.kicked.map(entry => `<p><span>${escapeHtml(entry.name)}</span><button class="link-button" data-unblock="${escapeHtml(entry.id)}">解除封鎖</button></p>`).join('')}</div>`
    : '';
  const knockedOut = room.status === 'playing' && me && !me.spectator && me.alive === false;
  const exportMap = room.puzzle.solution && (room.status === 'finished' || knockedOut)
    ? '<button class="copy-button" id="copy-map">複製地圖</button><small class="map-copy-message" id="map-copy-message"></small>'
    : room.status === 'playing' ? '<small class="map-copy-hint">比賽結束後可複製地圖</small>' : '';
  const roleToggle = room.status === 'lobby' || room.status === 'finished'
    ? `<button class="role-toggle" id="role-toggle">${me?.spectator ? (room.status === 'finished' ? '下一局加入，成為玩家' : '加入本局，成為玩家') : '改為觀戰者'}</button>` : '';
  const sprintMode = room.sprintMode === 'multiply' ? 'multiply' : 'fixed';
  const sprintValue = sprintMode === 'multiply' ? room.sprintFactor : room.sprintSeconds;
  const sprintSetting = room.status === 'lobby'
    ? isHost
      ? `<label class="sprint-setting">最後衝刺時間<select id="sprint-mode"><option value="fixed" ${sprintMode === 'fixed' ? 'selected' : ''}>固定秒數</option><option value="multiply" ${sprintMode === 'multiply' ? 'selected' : ''}>第一名用時 ×</option></select><input id="sprint-value" type="text" inputmode="decimal" maxlength="6" value="${sprintValue}" /><small>${sprintMode === 'multiply' ? '倍數 0.1 – 9999' : '1 – 9999 秒'}</small></label>`
      : `<p class="sprint-setting readonly">最後衝刺：<b>${sprintMode === 'multiply' ? `第一名用時 × ${room.sprintFactor}` : `${room.sprintSeconds} 秒`}</b></p>`
    : '';
  const sizeOptions = [4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => `<option value="${n}" ${n === room.puzzle.size ? 'selected' : ''}>${n} × ${n}</option>`).join('');
  const roomSettings = room.status === 'lobby'
    ? isHost
      ? `<div class="room-settings"><label>棋盤大小<select id="room-size" ${room.restartPending ? 'disabled' : ''}>${sizeOptions}</select></label><label>房間類型<select id="room-visibility"><option value="public" ${room.visibility === 'public' ? 'selected' : ''}>公開（顯示於列表）</option><option value="private" ${room.visibility === 'private' ? 'selected' : ''}>私人（僅限房號）</option></select></label><label>房間密碼<span class="password-row"><input id="room-password" type="password" maxlength="32" autocomplete="off" placeholder="${room.hasPassword ? '已設定，輸入以替換' : '未設定'}" /><button class="copy-button" id="room-password-save">設定</button>${room.hasPassword ? '<button class="copy-button" id="room-password-clear">清除密碼</button>' : ''}</span></label><small>改大小會重新產題；密碼最長 32 字，伺服器只保存雜湊。</small></div>`
      : `<p class="sprint-setting readonly">棋盤 <b>${room.puzzle.size} × ${room.puzzle.size}</b> · ${room.visibility === 'private' ? '私人房' : '公開房'} · ${room.hasPassword ? '🔒 需要密碼' : '無密碼'}</p>`
    : '';
  const streak = entry => entry.streak >= 2 ? ` <em class="streak">🔥 連霸 ${entry.streak}</em>` : '';
  const boardTabs = `<div class="board-tabs"><button class="link-button ${state.boardView === 'fastest' ? 'active' : ''}" data-board-view="fastest">最快紀錄</button><button class="link-button ${state.boardView === 'points' ? 'active' : ''}" data-board-view="points">積分榜</button></div>`;
  const leaderboard = state.boardView === 'points'
    ? room.stats?.length
      ? `<div class="room-leaderboard"><p class="eyebrow">LEADERBOARD</p><h3>房間積分榜</h3>${boardTabs}<ol>${room.stats.map(row => `<li>${avatarHtml(row.avatar, row.frame, 'small')}<strong>${escapeHtml(row.name)}${streak(row)}</strong><span>${row.points} 分 · 完成 ${row.completed} / ${row.played} 局${row.averageMs != null ? ` · 平均 ${(row.averageMs / 1000).toFixed(1)}s` : ''}${row.bestStreak >= 2 ? ` · 最長連霸 ${row.bestStreak}` : ''}</span></li>`).join('')}</ol><small class="points-rule">完成得 N − 名次 + 1 分（N 為該局玩家數），未完成 0 分。</small></div>`
      : `<div class="room-leaderboard"><p class="eyebrow">LEADERBOARD</p><h3>房間積分榜</h3>${boardTabs}<p class="empty">每局結束後累計積分：完成得 N − 名次 + 1 分，未完成 0 分。</p></div>`
    : room.leaderboard?.length
      ? `<div class="room-leaderboard"><p class="eyebrow">LEADERBOARD</p><h3>房間最快紀錄</h3>${boardTabs}<ol>${room.leaderboard.map(row => `<li>${avatarHtml(row.avatar, row.frame, 'small')}<strong>${escapeHtml(row.name)}</strong><span>${(row.ms / 1000).toFixed(1)}s · ${row.wins} 勝 · 第 ${row.round} 局</span></li>`).join('')}</ol></div>`
      : `<div class="room-leaderboard"><p class="eyebrow">LEADERBOARD</p><h3>房間最快紀錄</h3>${boardTabs}<p class="empty">完成一局後，最快紀錄會出現在這裡。</p></div>`;
  return `<aside class="room-panel"><div><p class="eyebrow">${room.status.toUpperCase()}</p><h2>房間成員</h2></div><div class="people">${room.players.map(player => { const flash = player.id === state.deathFlashId && !state.deathFlashRendered ? ' newly-eliminated' : ''; const status = player.idle ? '離線觀戰' : player.spectator ? '觀戰' : player.completedAt ? '已完成' : player.alive ? `已解 ${player.found} / ${room.puzzle.size}` : '已淘汰'; const stat = room.stats?.find(entry => entry.playerId === player.id); const kick = isHost && player.id !== state.playerId ? `<button class="kick-button" data-kick="${escapeHtml(player.id)}" title="移出房間" aria-label="移出 ${escapeHtml(player.name)}">移出</button>` : ''; return `<div class="person-row"><button class="person ${player.host ? 'host' : ''} ${!player.alive && !player.spectator ? 'eliminated' : ''}${flash} ${canWatch && player.id === state.watchingPlayerId ? 'watching' : ''}" data-watch="${player.id}" ${!canWatch || player.spectator ? 'disabled' : ''}><span>${player.idle ? '⏾' : player.spectator ? '◉' : player.alive ? '♟' : '×'}</span>${avatarHtml(player.avatar, player.frame, 'small')}<strong>${escapeHtml(player.name)}${player.id === state.playerId ? '（你）' : ''}${stat ? streak(stat) : ''}</strong><small class="player-progress">${status}${stat ? ` · ${stat.points} 分` : ''}</small></button>${kick}</div>`; }).join('')}</div>${roleToggle}${roomSettings}${sprintSetting}${canWatch && room.status === 'playing' ? `<p class="watch-hint">正在觀看：<b>${escapeHtml(watching?.name || '選擇一位玩家')}</b></p>` : ''}${room.status === 'lobby' ? (isHost ? `<button class="primary wide" id="start-room" ${room.restartPending ? 'disabled' : ''}>開始這局</button>` : '<p class="waiting">等待房主開始遊戲…</p>') : ''}${room.status === 'finished' ? `<div class="results"><p class="eyebrow">RESULTS</p>${(window.lastResults || []).map(row => `<p><b>#${row.rank}</b> ${escapeHtml(row.name)} <span>${row.time}s</span></p>`).join('') || '<p>沒有完成者</p>'}</div>` : ''}${replay}${blocked}${leaderboard}${exportMap}<button class="copy-button" id="copy-room">複製房間碼 ${room.code}</button></aside>`;
}
function renderChatPanel() {
  return `<aside class="chat-panel"><div><p class="eyebrow">ROOM CHAT</p><h2>房間聊天</h2></div><div class="chat-log" id="chat-log"></div><form class="chat-form" id="chat-form"><textarea id="chat-input" rows="1" maxlength="200" placeholder="跟大家說點什麼…"></textarea><button class="primary" type="submit">送出</button></form><small class="chat-notice" id="chat-notice"></small></aside>`;
}
function bindChat() {
  const form = document.querySelector('#chat-form'), input = document.querySelector('#chat-input'), log = document.querySelector('#chat-log');
  if (!form) return;
  log.textContent = ''; state.chat.forEach(appendChatMessage); log.scrollTop = log.scrollHeight;
  form.onsubmit = event => { event.preventDefault(); sendChat(); };
  // The board listens on the document, so chat keystrokes stay inside the box.
  input.onkeydown = event => { event.stopPropagation(); if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(); } };
}
function chatNotice(text) {
  const notice = document.querySelector('#chat-notice'); if (!notice) return;
  notice.textContent = text; clearTimeout(chatNotice.timer); chatNotice.timer = setTimeout(() => notice.textContent = '', 1800);
}
function sendChat() {
  const input = document.querySelector('#chat-input'), text = input?.value.trim();
  if (!text || !state.room) return;
  socket.emit('chat-message', { code: state.room.code, text }, result => {
    if (result?.error) return chatNotice(result.error);
    if (input.value.trim() === text) input.value = '';
  });
}
// Keep in sync with formatBoardText in puzzle.js.
function formatPuzzleText(puzzle) {
  const rows = [];
  for (let row = 0; row < puzzle.size; row++) rows.push(puzzle.regions.slice(row * puzzle.size, (row + 1) * puzzle.size).map(region => region + 1).join(' '));
  // Answer row is base64 so a glance at shared text does not spoil the fun; parseBoardText accepts both forms.
  rows.push('# 下一行是 base64 編碼的答案，避免不小心瞄到；匯入時原樣貼上即可。', 'answer:' + btoa(puzzle.solution.map(cat => cat.col + 1).join(' ')));
  return rows.join('\n');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
  document.body.append(area); area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  area.remove(); return copied;
}
// One DOM node per message: chatter never triggers a board re-render.
function appendChatMessage(message) {
  const log = document.querySelector('#chat-log'); if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
  const line = document.createElement('div');
  line.className = `chat-line${message.playerId === state.playerId ? ' mine' : ''}`;
  const meta = document.createElement('small'); meta.className = 'chat-meta';
  meta.textContent = `${message.name} · ${new Date(message.at).toLocaleTimeString('zh-Hant', { hour: '2-digit', minute: '2-digit' })}`;
  const body = document.createElement('p'); body.textContent = message.text;
  line.append(meta, body); log.append(line);
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function bindBoard() {
  const cells = document.querySelectorAll('.cell');
  cells.forEach(cell => {
    cell.addEventListener('click', () => { if (Date.now() >= state.suppressClickUntil) chooseCell(cell); });
    cell.addEventListener('contextmenu', event => event.preventDefault());
    cell.addEventListener('pointerdown', event => {
      if (event.button !== 2 || cell.closest('.locked')) return;
      event.preventDefault();
      const key = `${cell.dataset.row}:${cell.dataset.col}`;
      state.dragged = true; state.dragMarking = !state.marks.has(key); applyMark(cell, state.dragMarking);
    });
    cell.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || cell.closest('.locked')) return;
      const key = `${cell.dataset.row}:${cell.dataset.col}`;
      event.preventDefault(); clearTimeout(state.touchTimer);
      state.touchPointerId = event.pointerId; state.touchStartedAt = Date.now(); state.suppressClickUntil = Date.now() + 520;
      if (state.lastTouchKey === key && Date.now() - state.lastTouchAt < 360) {
        state.lastTouchKey = null; applyMark(cell, false); chooseCell(cell); return;
      }
      state.lastTouchKey = key; state.lastTouchAt = Date.now();
      beginTouchMark(cell);
    });
  });
  document.onpointermove = event => {
    if (!state.dragged) return;
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest('.cell');
    if (cell && !cell.closest('.locked')) applyMark(cell, state.dragMarking);
  };
  const endPointer = event => {
    if (event.pointerType === 'touch' && event.pointerId === state.touchPointerId) state.touchPointerId = null;
    clearTimeout(state.touchTimer); state.touchTimer = null; state.dragged = false;
  };
  document.onpointerup = endPointer;
  document.onpointercancel = endPointer;
}
function beginTouchMark(cell) {
  if (state.dragged || cell.closest('.locked')) return;
  const key = `${cell.dataset.row}:${cell.dataset.col}`;
  state.dragged = true; state.dragMarking = !state.marks.has(key); state.suppressClickUntil = Date.now() + 700;
  applyMark(cell, state.dragMarking);
}
function applyMark(cell, shouldMark) {
  if (cell.classList.contains('cat') || cell.classList.contains('wrong')) return;
  const key = `${cell.dataset.row}:${cell.dataset.col}`;
  if (shouldMark) state.marks.add(key); else state.marks.delete(key);
  clearHint();
  cell.classList.toggle('mark', shouldMark); cell.textContent = shouldMark ? '×' : '';
  if (state.mode === 'multi') queueMarksSync();
}
// Drag-marking crosses a dozen cells in a moment. Sending each one separately
// asked the server to broadcast a dozen room states, so every player in the
// room paid for one player's scribbling; the notes travel in one late packet.
let marksSyncTimer = null;
function queueMarksSync() {
  if (marksSyncTimer) return;
  marksSyncTimer = setTimeout(() => {
    marksSyncTimer = null;
    if (state.mode === 'multi' && state.room) socket.emit('marks-update', { code: state.room.code, marks: [...state.marks] });
  }, 150);
}
async function chooseCell(cell) {
  if (cell.closest('.locked')) return;
  const row = Number(cell.dataset.row), col = Number(cell.dataset.col), key = `${row}:${col}`;
  if (state.cats.has(key)) return;
  if (state.mode === 'multi') {
    if (state.pending.has(key)) return;
    // The verdict belongs to the server, but the tap has to look answered now.
    state.pending.add(key); cell.classList.add('pending');
    socket.emit('guess', { code: state.room.code, row, col });
    return;
  }
  const correct = state.single.solution.some(cat => cat.row === row && cat.col === col);
  clearHint();
  // Practice exists to work the puzzle out, so a wrong cell is only marked.
  if (!correct && state.mode === 'practice') { window.playSfx?.('wrong'); state.wrong.add(key); renderGame('這格沒有貓咪，再想想。'); const board = document.querySelector('.board'); board.classList.add('shake'); setTimeout(() => board.classList.remove('shake'), 500); return; }
  if (!correct) { state.singleMistakes++; window.playSfx?.('wrong'); state.wrong.add(key); renderGame('這格沒有貓咪，挑戰失敗！'); document.querySelector('.board').classList.add('shake', 'locked'); return; }
  state.cats.add(key); state.marks.delete(key);
  if (state.mode === 'practice') {
    if (state.cats.size === state.single.size) {
      state.practiceMs = Date.now() - state.practiceStartedAt; state.singleCompleted = true;
      renderGame('練習完成！'); document.querySelector('.board').classList.add('locked');
    } else renderGame('答對了！');
    window.playSfx?.('meow'); playCatReveal(row, col); return;
  }
  if (state.cats.size === state.single.size) {
    const result = await api('/api/single-complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: playerName(), levelId: state.single.id, ms: Date.now() - state.singleStartedAt, mistakes: state.singleMistakes }) });
    state.cleared.add(state.single.id); state.singleAttemptId = null;
    if (result.unlocked?.length) showAchievementToast(result.unlocked);
    const currentIndex = state.levels.findIndex(level => level.id === state.single.id);
    state.nextSingleId = state.levels[currentIndex + 1]?.id || null; state.singleCompleted = true;
    renderGame('完美！這盒罐罐是你的了。'); document.querySelector('.board').classList.add('locked');
  } else {
      renderGame('答對了！');
  }
  window.playSfx?.('meow'); playCatReveal(row, col);
}

async function showMultiplayer() {
  const publicRooms = await api('/api/public-rooms');
  state.mode = 'multiplayer';
  const roomList = publicRooms.length
    ? publicRooms.map(room => `<button class="public-room" data-public-room="${room.code}"><span class="public-room-icon">${room.status === 'lobby' ? '♟' : '◉'}</span><span><strong>${escapeHtml(room.name)}${room.hasPassword ? ' 🔒' : ''}</strong><small>${room.size} × ${room.size} · ${room.players} 位玩家${room.spectators ? ` · ${room.spectators} 位觀戰` : ''}</small></span><b>${room.status === 'lobby' ? '快速加入 →' : '觀戰 →'}</b></button>`).join('')
    : '<p class="empty public-empty">目前沒有公開房間。開一間讓大家加入吧！</p>';
  view.innerHTML = `<section class="page-heading"><button class="back-button" id="back">← 首頁</button><p class="eyebrow">MULTIPLAYER</p><h1>揪朋友來解題</h1><p>開一間公開房，或用私密 Key 與朋友相聚。</p></section><section class="lobby-grid"><form class="lobby-card" id="create-room"><p class="eyebrow">CREATE ROOM</p><h2>開新房間</h2><label>房間名稱<input name="roomName" maxlength="40" value="${escapeHtml(playerName())} 的貓咪派對" /></label><label>房間類型<select name="visibility"><option value="public" selected>公開房間（顯示於列表）</option><option value="private">私人房間（僅限 Key 加入）</option></select></label><label>地圖尺寸<select name="size"><option value="7" selected>7 × 7</option><option value="8">8 × 8</option><option value="9">9 × 9</option><option value="10">10 × 10</option><option value="11">11 × 11</option><option value="12">12 × 12</option></select></label><label>最後衝刺秒數<input name="sprintSeconds" type="text" inputmode="numeric" maxlength="4" value="60" /></label><button class="primary wide">建立房間</button></form><form class="lobby-card dark" id="join-room"><p class="eyebrow">JOIN BY KEY</p><h2>使用房間 Key</h2><label>房間 Key<input name="code" maxlength="5" placeholder="例如 AB12C" required /></label><label class="check"><input type="checkbox" name="spectator" /> 以觀戰者身分加入</label><button class="light-button wide">使用 Key 加入</button></form></section><section class="public-rooms"><div class="section-title"><div><p class="eyebrow">PUBLIC ROOMS</p><h2>公開房間</h2></div><button class="link-button" id="refresh-rooms">重新整理</button></div><div class="public-room-list">${roomList}</div></section>`;
  document.querySelector('#back').onclick = home;
  document.querySelector('#create-room').onsubmit = event => { event.preventDefault(); const form = new FormData(event.target), button = event.target.querySelector('button[type="submit"], button'), label = button.textContent; button.disabled = true; button.textContent = '建立中…'; socket.emit('create-room', { name: playerName(), roomName: form.get('roomName'), size: form.get('size'), visibility: form.get('visibility'), sprintSeconds: form.get('sprintSeconds') }, result => { button.disabled = false; button.textContent = label; if (result?.error) alert(result.error); }); };
  document.querySelector('#join-room').onsubmit = event => { event.preventDefault(); const form = new FormData(event.target); joinRoom({ code: form.get('code'), spectator: form.has('spectator') }); };
  document.querySelector('#refresh-rooms').onclick = showMultiplayer;
  document.querySelectorAll('[data-public-room]').forEach(button => button.addEventListener('click', () => joinRoom({ code: button.dataset.publicRoom, spectator: false })));
}
// A locked room is only discovered on the first refusal, then asked for once.
function joinRoom({ code, spectator }, password) {
  socket.emit('join-room', { code, name: playerName(), spectator, password }, result => {
    if (!result.error) return;
    if (result.needsPassword && password === undefined) { const entered = prompt('這間房需要密碼，請輸入：'); if (entered !== null) return joinRoom({ code, spectator }, entered); return; }
    alert(result.error);
  });
}
function bindRoomButtons() {
  document.querySelector('#start-room')?.addEventListener('click', () => socket.emit('start-game', { code: state.room.code }, result => result?.error && alert(result.error)));
  document.querySelector('#copy-room')?.addEventListener('click', async () => { await navigator.clipboard.writeText(state.room.code); const button = document.querySelector('#copy-room'); button.textContent = '已複製！'; setTimeout(() => button.textContent = `複製房間碼 ${state.room.code}`, 1200); });
  document.querySelector('#copy-map')?.addEventListener('click', async event => { const button = event.currentTarget, message = document.querySelector('#map-copy-message'), copied = await copyText(formatPuzzleText(state.room.puzzle)); button.textContent = copied ? '已複製地圖！' : '複製失敗'; if (message) message.textContent = copied ? '' : '複製失敗，請手動複製地圖。'; if (copied) setTimeout(() => { if (button.isConnected) button.textContent = '複製地圖'; }, 1200); });
  document.querySelectorAll('[data-watch]').forEach(button => button.addEventListener('click', () => { state.watchingPlayerId = button.dataset.watch; renderGame(); }));
  document.querySelector('#restart-room')?.addEventListener('click', event => {
    const button = event.currentTarget, live = state.room.status === 'countdown' || state.room.status === 'playing';
    if (live && !confirm('確定要重開這一局？本局成績將作廢，不計入積分與最快紀錄。')) return;
    button.disabled = true; button.textContent = '準備中…';
    socket.emit('restart-room', { code: state.room.code, }, result => { if (result?.error) alert(result.error); renderGame(); });
  });
  document.querySelectorAll('[data-kick]').forEach(button => button.addEventListener('click', () => { const target = state.room.players.find(player => player.id === button.dataset.kick); if (!confirm(`要把 ${target?.name || '這位成員'} 移出房間嗎？他將無法再加入，除非你解除封鎖。`)) return; socket.emit('kick-player', { code: state.room.code, targetId: button.dataset.kick }, result => result?.error && alert(result.error)); }));
  document.querySelectorAll('[data-unblock]').forEach(button => button.addEventListener('click', () => socket.emit('unblock-player', { code: state.room.code, targetId: button.dataset.unblock }, result => result?.error && alert(result.error))));
  const updateSettings = (payload, done) => socket.emit('update-room-settings', { code: state.room.code, ...payload }, result => { if (result?.error) alert(result.error); done?.(result); });
  document.querySelector('#room-size')?.addEventListener('change', event => { event.target.disabled = true; updateSettings({ size: event.target.value }, () => renderGame()); });
  document.querySelector('#room-visibility')?.addEventListener('change', event => updateSettings({ visibility: event.target.value }, () => renderGame()));
  document.querySelector('#room-password-save')?.addEventListener('click', () => { const input = document.querySelector('#room-password'); updateSettings({ password: input.value }, result => { if (result?.ok) input.value = ''; }); });
  document.querySelector('#room-password-clear')?.addEventListener('click', () => updateSettings({ clearPassword: true }));
  document.querySelector('#room-password')?.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); document.querySelector('#room-password-save')?.click(); } });
  document.querySelectorAll('[data-board-view]').forEach(button => button.addEventListener('click', () => { state.boardView = button.dataset.boardView; renderGame(); }));
  document.querySelector('#role-toggle')?.addEventListener('click', () => socket.emit('set-lobby-role', { code: state.room.code, spectator: !state.room.players.find(player => player.id === state.playerId)?.spectator }, result => result?.error && alert(result.error)));
  document.querySelector('#sprint-mode')?.addEventListener('change', event => { const mode = event.target.value; socket.emit('set-sprint-setting', { code: state.room.code, mode, value: mode === 'multiply' ? state.room.sprintFactor : state.room.sprintSeconds }, result => result?.error && alert(result.error)); });
  document.querySelector('#sprint-value')?.addEventListener('input', event => { const mode = document.querySelector('#sprint-mode')?.value; event.target.value = mode === 'multiply' ? event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1') : event.target.value.replace(/\D/g, ''); });
  document.querySelector('#sprint-value')?.addEventListener('change', event => { const mode = document.querySelector('#sprint-mode')?.value || 'fixed'; socket.emit('set-sprint-setting', { code: state.room.code, mode, value: event.target.value }, result => { result?.error && alert(result.error); const stored = state.room.sprintMode === 'multiply' ? state.room.sprintFactor : state.room.sprintSeconds; event.target.value = stored; }); });
}
function exitRoom(message) {
  state.room = null; state.resumeCode = null; state.connectionLost = false; state.watchingPlayerId = null;
  state.cats.clear(); state.marks.clear(); state.wrong.clear(); state.pending.clear(); state.chat = [];
  home();
  if (message) alert(message);
}
function leaveRoom() {
  state.resumeCode = null;
  const quit = () => { socket.disconnect(); window.location.reload(); };
  // The reload must not outrun the leave packet, but a dead socket never acks.
  const fallback = setTimeout(quit, 600);
  socket.emit('leave-room', { code: state.room.code }, () => { clearTimeout(fallback); quit(); });
}

socket.on('room-state', room => {
  state.room = room; state.mode = 'multi';
  const me = room.players.find(player => player.id === state.playerId);
  if (me && !me.spectator) state.idleNotice = '';
  const canWatch = me?.spectator || me?.alive === false || me?.completedAt;
  const targetStillExists = room.players.some(player => player.id === state.watchingPlayerId && !player.spectator);
  if (canWatch && !targetStillExists) {
    // A newly finished player lands on another player when one is available.
    state.watchingPlayerId = room.players.find(player => !player.spectator && player.id !== state.playerId)?.id
      || room.players.find(player => !player.spectator)?.id || null;
  }
  renderGame(); state.deathFlashRendered = true;
});
socket.on('guess-result', ({ row, col, hit }) => { const key = `${row}:${col}`; state.pending.delete(key); if (hit) { state.cats.add(key); state.marks.delete(key); renderGame('答對了！'); window.playSfx?.('meow'); playCatReveal(row, col); } else { window.playSfx?.('wrong'); state.wrong.add(key); renderGame('這格沒有貓咪，你被淘汰了。'); } });
socket.on('match-started', () => { window.playSfx?.('go'); state.cats.clear(); state.marks.clear(); state.wrong.clear(); state.pending.clear(); state.watchingPlayerId = state.room?.players.find(player => !player.spectator)?.id || null; });
socket.on('player-eliminated', ({ playerId }) => { state.deathFlashId = playerId; state.deathFlashRendered = false; });
socket.on('disconnect', () => {
  if (state.mode !== 'multi' || !state.room) return;
  state.connectionLost = true; state.resumeCode = state.room.code; state.pending.clear(); renderGame();
});
socket.on('connect', () => {
  if (!state.resumeCode || state.mode !== 'multi') return;
  socket.emit('resume-room', { code: state.resumeCode, name: playerName() }, result => {
    if (result?.error) return exitRoom(result.error.includes('移出') ? result.error : '房間已關閉，已回到首頁。');
    state.connectionLost = false; state.resumeCode = null;
    if (result.movedToSpectator) state.idleNotice = '你離線太久，已改為觀戰。';
    renderGame();
  });
});
socket.on('room-closed', ({ reason }) => exitRoom(reason));
socket.on('kicked', ({ code, reason }) => { if (state.room && code !== state.room.code) return; document.querySelector('#finish-notice')?.remove(); exitRoom(reason || '你已被房主移出房間'); });
// The abandoned round leaves no trace on the board or in the results panel.
socket.on('room-restarted', ({ message }) => { state.cats.clear(); state.marks.clear(); state.wrong.clear(); state.pending.clear(); window.lastResults = null; document.querySelector('#finish-notice')?.remove(); if (state.room) { state.room.deadline = null; renderGame(message); } });
// A rejected handshake means the cookie went stale; a fresh /me mints one.
socket.on('connect_error', async () => { try { await loadIdentity(); } catch {} });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !socket.connected) socket.connect();
});
socket.on('final-sprint', ({ deadline, sprintSeconds }) => { window.playSfx?.('sprint'); state.room.deadline = deadline; renderGame(`第一位完成！${sprintSeconds} 秒最後衝刺開始。`); });
socket.on('game-finished', ({ results }) => { window.lastResults = results; renderGame('本局結束！'); showFinishNotice(results); });
socket.on('achievements-unlocked', list => { if (Array.isArray(list) && list.length) showAchievementToast(list); });
socket.on('chat-message', message => { if (message.code !== state.room?.code) return; state.chat.push(message); if (state.chat.length > 50) state.chat.shift(); appendChatMessage(message); });
socket.on('chat-backlog', messages => { state.chat = Array.isArray(messages) ? messages.slice(-50) : []; const log = document.querySelector('#chat-log'); if (log) { log.textContent = ''; state.chat.forEach(appendChatMessage); log.scrollTop = log.scrollHeight; } });
setInterval(() => document.querySelectorAll('[data-deadline]').forEach(node => { const t = remainingSeconds(node.dataset.deadline); const changed = node.dataset.tickAt !== String(t); node.textContent = t; if (changed && t > 0 && t <= 5) window.playSfx?.('tick'); node.dataset.tickAt = t; }), 250);
setInterval(() => { if (state.mode !== 'practice' || state.practiceMs != null) return; const node = document.querySelector('[data-practice]'); if (node) node.textContent = ((Date.now() - state.practiceStartedAt) / 1000).toFixed(1); }, 100);
setInterval(() => document.querySelectorAll('[data-countdown]').forEach(node => { const t = Math.max(0, Math.ceil((Number(node.dataset.countdown) - Date.now()) / 1000)); if (!node.dataset.ticked || String(t) !== node.textContent) { node.dataset.ticked = '1'; node.textContent = t; if (t > 0) window.playSfx?.('tick'); } }), 100);

function playCatReveal(row, col) {
  requestAnimationFrame(() => {
    const cell = document.querySelector(`.cell[data-row="${row}"][data-col="${col}"]`);
    if (!cell) return;
    cell.classList.add('cat-reveal');
    setTimeout(() => cell.classList.remove('cat-reveal'), 650);
  });
}

// Sits in a corner and fades on its own: the board must stay visible and
// clickable while it is up.
function showAchievementToast(list) {
  let stack = document.querySelector('#achievement-toasts');
  if (!stack) { stack = document.createElement('div'); stack.id = 'achievement-toasts'; stack.className = 'achievement-toasts'; stack.setAttribute('aria-live', 'polite'); document.body.append(stack); }
  for (const achievement of list) {
    const toast = document.createElement('div'); toast.className = 'achievement-toast';
    toast.innerHTML = `<span class="toast-icon">🏅</span><div><p class="eyebrow">成就解鎖</p><strong>${escapeHtml(achievement.name)}</strong><small>${escapeHtml(achievement.description)}${achievement.frame ? ' · 獲得新相框' : ''}</small></div>`;
    stack.append(toast);
    setTimeout(() => toast.classList.add('leaving'), 5200); setTimeout(() => toast.remove(), 5800);
  }
  window.playSfx?.('meow');
}

async function showProfile() {
  state.mode = 'profile'; state.room = null; state.practice = null;
  const back = '<button class="back-button" id="back">← 首頁</button>';
  if (!state.user) {
    view.innerHTML = `<section class="page-heading">${back}<p class="eyebrow">PROFILE</p><h1>個人主頁</h1></section><section class="panel profile-guest"><h2>登入才能保存</h2><p>你目前是訪客。訪客的進度與對戰紀錄在關閉網頁後不會保留，成就、頭像與相框也需要帳號才能解鎖。登入或註冊後，這次的進度會自動併入帳號。</p><button class="primary" id="profile-login">登入 / 註冊</button></section>`;
    document.querySelector('#back').onclick = home;
    document.querySelector('#profile-login').onclick = () => document.querySelector('#auth-button').click();
    return;
  }
  const [profile, levels, history] = await Promise.all([api('/api/profile/me'), api('/api/levels'), api('/api/history/me')]);
  state.user = profile.user; renderAuth();
  const cleared = new Set(profile.cleared);
  const nextIndex = levels.findIndex(level => !cleared.has(level.id));
  const chapterName = new Map(profile.chapters.map(chapter => [chapter.id, chapter.name]));
  const progressRow = (name, done, total) => `<li class="${total && done === total ? 'done' : ''}"><strong>${escapeHtml(name)}</strong><span class="bar"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></span><b>${done} / ${total}</b></li>`;
  const chapterRows = profile.chapters.filter(chapter => chapter.levelIds.length).map(chapter => progressRow(chapter.name, chapter.levelIds.filter(id => cleared.has(id)).length, chapter.total));
  const extra = levels.filter(level => !level.chapter);
  if (extra.length) chapterRows.push(progressRow('其他關卡', extra.filter(level => cleared.has(level.id)).length, extra.length));
  const nextLevel = nextIndex === -1 ? null : levels[nextIndex];
  const current = !levels.length ? '關卡正在準備' : !nextLevel ? '全部通關！' : `第 ${String(nextIndex + 1).padStart(3, '0')} 關 · ${escapeHtml(nextLevel.name)}${nextLevel.chapter ? `（${escapeHtml(chapterName.get(nextLevel.chapter) || '')}）` : ''}`;
  const frameById = new Map(profile.frames.map(frame => [frame.id, frame]));
  const unlockedCount = profile.achievements.filter(a => a.unlockedAt).length;
  view.innerHTML = `<section class="page-heading">${back}<p class="eyebrow">PROFILE</p><h1>個人主頁</h1><p>進度、對戰紀錄與成就都在這裡。相框要靠成就解鎖。</p></section>
    <section class="profile-grid">
      <article class="panel profile-card"><div class="profile-identity">${avatarHtml(profile.user.avatar, profile.user.frame, 'large')}<div><strong>${escapeHtml(profile.user.displayName)}</strong><small>@${escapeHtml(profile.user.username)}</small></div></div>
        <form class="profile-name-form" id="profile-name-form"><label for="display-name">顯示名稱</label><input id="display-name" maxlength="20" value="${escapeHtml(profile.user.displayName)}" /><button class="quiet-button" type="submit">儲存</button></form>
        <p class="eyebrow">AVATAR</p><div class="picker" id="avatar-picker">${profile.avatars.map(avatar => `<button type="button" class="pick ${avatar === (profile.user.avatar || DEFAULT_AVATAR) ? 'selected' : ''}" data-avatar="${escapeHtml(avatar)}">${escapeHtml(avatar)}</button>`).join('')}</div>
        <p class="eyebrow">FRAME</p><div class="picker" id="frame-picker">${profile.frames.map(frame => `<button type="button" class="pick ${frame.id === (profile.user.frame || 'plain') ? 'selected' : ''} ${frame.unlocked ? '' : 'locked'}" data-frame="${escapeHtml(frame.id)}" ${frame.unlocked ? '' : 'disabled'} title="${escapeHtml(frame.unlocked ? frame.name : `${frame.name}：達成「${frame.achievement}」後解鎖`)}">${avatarHtml(profile.user.avatar, frame.id)}<small>${escapeHtml(frame.name)}</small></button>`).join('')}</div>
        <small class="profile-message" id="profile-message"></small></article>
      <article class="panel"><p class="eyebrow">SINGLE PLAYER</p><h2>單人進度</h2><p class="big-number"><b>${levels.filter(level => cleared.has(level.id)).length}</b> / ${levels.length} 關</p><p>目前進行到：<b>${current}</b></p><ol class="chapter-list">${chapterRows.join('') || '<li><span class="empty">難度階梯正在產生。</span></li>'}</ol></article>
      <article class="panel"><p class="eyebrow">ACHIEVEMENTS</p><h2>成就 <small>${unlockedCount} / ${profile.achievements.length}</small></h2><ul class="achievement-list">${profile.achievements.map(a => `<li class="${a.unlockedAt ? 'unlocked' : 'locked'}"><span class="badge">${a.unlockedAt ? '🏅' : '🔒'}</span><div><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.description)}${a.frame ? ` · 獎勵相框「${escapeHtml(frameById.get(a.frame)?.name || a.frame)}」` : ''}</small>${a.unlockedAt ? `<small class="when">${escapeHtml(matchDate(a.unlockedAt))} 解鎖</small>` : ''}</div></li>`).join('')}</ul></article>
      <article class="panel profile-history"><p class="eyebrow">MATCH HISTORY</p><h2>歷史比賽 <small>${profile.stats.matches} 場 · ${profile.stats.wins} 次第一</small></h2>${history.length ? `<table class="history-table"><thead><tr><th>日期</th><th>房名</th><th>尺寸</th><th>結果</th></tr></thead><tbody>${history.map(record => `<tr><td>${escapeHtml(matchDate(record.finishedAt))}</td><td>${escapeHtml(record.roomName)}</td><td>${record.size} × ${record.size}</td><td class="${escapeHtml(record.outcome?.status || '')}">${record.outcome ? escapeHtml(outcomeLabel(record.outcome)) : '未完成'}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">還沒有對戰紀錄。</p>'}</article>
    </section>`;
  document.querySelector('#back').onclick = home;
  const message = document.querySelector('#profile-message');
  const save = async body => {
    try { const result = await api('/api/profile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); state.user = result.user; renderAuth(); await showProfile(); document.querySelector('#profile-message').textContent = '已儲存'; }
    catch (error) { message.textContent = error.message; }
  };
  document.querySelector('#profile-name-form').onsubmit = event => { event.preventDefault(); save({ displayName: document.querySelector('#display-name').value }); };
  document.querySelectorAll('[data-avatar]').forEach(button => button.onclick = () => save({ avatar: button.dataset.avatar }));
  document.querySelectorAll('[data-frame]').forEach(button => button.onclick = () => save({ frame: button.dataset.frame }));
}

function showFinishNotice(results) {
  document.querySelector('#finish-notice')?.remove();
  const notice = document.createElement('section');
  notice.id = 'finish-notice'; notice.className = 'finish-notice'; notice.setAttribute('role', 'alertdialog');
  const podium = results.length
    ? results.slice(0, 3).map(row => `<li><b>#${row.rank}</b><span>${escapeHtml(row.name)}</span><small>${row.time}s</small></li>`).join('')
    : '<li><span>這局還沒有完成者。</span></li>';
  notice.innerHTML = `<span class="finish-cat">🎉</span><p class="eyebrow">GAME FINISHED</p><h2>本局結束！</h2><p>快來看看這次誰最快找到貓咪。</p><ol>${podium}</ol><button class="primary" type="button">我知道了!</button>`;
  notice.querySelector('button').addEventListener('click', () => notice.remove());
  document.body.append(notice);
}
loadIdentity().then(() => socket.connect(), () => socket.connect()).finally(home);
