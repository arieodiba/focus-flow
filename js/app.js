'use strict';

/* ==========================================================================
   Focus Flow: a Pomodoro timer with tasks, stats, sounds and notifications.
   Everything is stored in the browser (localStorage); there is no server.
   ========================================================================== */

// ── Config ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  focus: 25,         // minutes
  short: 5,
  long: 15,
  longEvery: 4,      // focus sessions before a long break
  autoBreaks: false,
  autoFocus: false,
  sound: 'bell',
  volume: 0.6,
  notify: false,
  theme: 'system',   // system | light | dark
};

const FOCUS_MESSAGES = ['Stay focused! 🔥', 'You got this! 💪', 'Deep work mode 🧠', 'Block out the noise 🎯', 'Make it count! ⚡'];
const BREAK_MESSAGES = ['Nice work! Rest up 🌿', 'Breathe and relax 😌', 'Stretch it out 🙆', 'Hydrate! Drink water 💧', 'Great session! 🎉'];

const MODES = {
  focus: { label: 'Focus',       messages: FOCUS_MESSAGES },
  short: { label: 'Short break', messages: BREAK_MESSAGES },
  long:  { label: 'Long break',  messages: BREAK_MESSAGES },
};

const KEYS = { settings: 'ff.settings', tasks: 'ff.tasks', active: 'ff.activeTask', history: 'ff.history', timer: 'ff.timer' };
const MAX_HISTORY = 5000;

// ── Storage (wrapped: private windows can throw) ──────────────────────────
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

// ── State ─────────────────────────────────────────────────────────────────
let settings = { ...DEFAULTS, ...store.get(KEYS.settings, {}) };
let tasks = store.get(KEYS.tasks, []);
let activeTaskId = store.get(KEYS.active, null);
let history = store.get(KEYS.history, []);
let timer = loadTimer();

let finishTimeout = null;
let audioCtx = null;
let showTable = false;

function durationMs(mode) { return settings[mode] * 60 * 1000; }

function freshTimer(mode = 'focus', cycle = 0) {
  return { mode, status: 'idle', endAt: 0, remaining: durationMs(mode), total: durationMs(mode), startedAt: 0, cycle };
}

function loadTimer() {
  const t = store.get(KEYS.timer, null);
  if (!t || !MODES[t.mode] || !['idle', 'running', 'paused'].includes(t.status) || !t.total) return freshTimer();
  return t;
}

const saveTimer    = () => store.set(KEYS.timer, timer);
const saveTasks    = () => { store.set(KEYS.tasks, tasks); store.set(KEYS.active, activeTaskId); };
const saveHistory  = () => store.set(KEYS.history, history);
const saveSettings = () => store.set(KEYS.settings, settings);

// ── Elements ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  tabs: document.querySelectorAll('.mode-tab'),
  ringWrap: $('ringWrap'), ring: $('ringProgress'), time: $('time'), modeLabel: $('modeLabel'),
  currentTask: $('currentTask'), start: $('startBtn'), reset: $('resetBtn'), skip: $('skipBtn'),
  dots: $('dots'), cycleText: $('cycleText'), motivation: $('motivation'),
  taskForm: $('taskForm'), taskInput: $('taskInput'), taskEst: $('taskEst'), taskList: $('taskList'),
  taskEmpty: $('taskEmpty'), clearDone: $('clearDoneBtn'),
  statToday: $('statToday'), statCount: $('statCount'), statStreak: $('statStreak'), statTotal: $('statTotal'),
  chart: $('chart'), chartWrap: $('chartWrap'), tooltip: $('tooltip'), chartTable: $('chartTable'),
  tableToggle: $('tableToggle'), recent: $('recentList'), exportBtn: $('exportBtn'), clearHistory: $('clearHistoryBtn'),
  settingsBtn: $('settingsBtn'), dialog: $('settingsDialog'), form: $('settingsForm'),
  preview: $('previewBtn'), defaults: $('defaultsBtn'), notifyHint: $('notifyHint'),
  themeMeta: document.querySelector('meta[name="theme-color"]'),
};

const RING_CIRCUMFERENCE = 2 * Math.PI * Number(els.ring.getAttribute('r'));
els.ring.style.strokeDasharray = RING_CIRCUMFERENCE;

// ── Formatting helpers ────────────────────────────────────────────────────
function fmtClock(ms) {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(minutes) {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const activeTask = () => tasks.find((t) => t.id === activeTaskId) || null;

// ── Timer engine ──────────────────────────────────────────────────────────
// The timer stores the wall-clock time it should end (endAt) instead of
// counting ticks, so it stays accurate when the tab is in the background,
// the computer sleeps, or the page is reloaded.
function remainingMs() {
  return timer.status === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remaining;
}

function scheduleFinish() {
  clearTimeout(finishTimeout);
  // One long timeout (not a chain) is what browsers throttle least in hidden tabs.
  finishTimeout = setTimeout(checkFinished, remainingMs() + 50);
}

function checkFinished() {
  if (timer.status === 'running' && remainingMs() <= 0) complete();
}

function start() {
  if (timer.status === 'running') return;
  unlockAudio();
  timer.endAt = Date.now() + timer.remaining;
  if (!timer.startedAt) timer.startedAt = Date.now();
  timer.status = 'running';
  scheduleFinish();
  saveTimer();
  render();
}

function pause() {
  if (timer.status !== 'running') return;
  timer.remaining = remainingMs();
  timer.status = 'paused';
  clearTimeout(finishTimeout);
  saveTimer();
  render();
}

function toggle() { timer.status === 'running' ? pause() : start(); }

function reset() {
  clearTimeout(finishTimeout);
  timer = { ...freshTimer(timer.mode, timer.cycle) };
  saveTimer();
  render();
}

function setMode(mode, { autoStart = false } = {}) {
  clearTimeout(finishTimeout);
  timer = freshTimer(mode, timer.cycle);
  els.motivation.textContent = pick(MODES[mode].messages);
  saveTimer();
  render();
  if (autoStart) start();
}

function nextModeAfter(mode) {
  if (mode !== 'focus') return 'focus';
  return timer.cycle >= settings.longEvery ? 'long' : 'short';
}

function skip() {
  if (timer.mode === 'long') timer.cycle = 0;
  setMode(nextModeAfter(timer.mode));
}

function complete({ silent = false } = {}) {
  clearTimeout(finishTimeout);
  const finished = timer.mode;
  const endedAt = timer.status === 'running' ? timer.endAt : Date.now();
  const task = activeTask();

  history.push({
    mode: finished,
    start: timer.startedAt || endedAt - timer.total,
    end: endedAt,
    minutes: Math.round((timer.total / 60000) * 10) / 10,
    task: finished === 'focus' && task ? task.title : '',
  });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  saveHistory();

  if (finished === 'focus') {
    timer.cycle += 1;
    if (task) { task.done += 1; saveTasks(); }
  } else if (finished === 'long') {
    timer.cycle = 0;
  }

  const next = nextModeAfter(finished);
  if (!silent) {
    playSound();
    if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
    celebrate();
  }
  notifyDone(finished, next);

  setMode(next, { autoStart: next === 'focus' ? settings.autoFocus : settings.autoBreaks });
  renderTasks();
  renderStats();
}

function celebrate() {
  els.ringWrap.classList.remove('celebrate');
  void els.ringWrap.offsetWidth; // restart the CSS animation
  els.ringWrap.classList.add('celebrate');
}

// ── Sound (generated with the Web Audio API, no audio files needed) ────────
// Each note: [frequency Hz, start offset s, duration s, waveform]
const SOUNDS = {
  bell:    [[880, 0, 1.4, 'sine'], [1320, 0, 0.9, 'sine'], [880, 0.7, 1.4, 'sine'], [1320, 0.7, 0.9, 'sine']],
  chime:   [[523.25, 0, 0.7, 'triangle'], [659.25, 0.2, 0.7, 'triangle'], [783.99, 0.4, 1.1, 'triangle']],
  digital: [[1000, 0, 0.1, 'square'], [1000, 0.18, 0.1, 'square'], [1000, 0.36, 0.1, 'square'],
            [1000, 0.8, 0.1, 'square'], [1000, 0.98, 0.1, 'square'], [1000, 1.16, 0.1, 'square']],
  wood:    [[320, 0, 0.12, 'sine'], [320, 0.28, 0.12, 'sine'], [420, 0.56, 0.18, 'sine']],
};

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { audioCtx = null; }
}

function playSound(name = settings.sound, volume = settings.volume) {
  const notes = SOUNDS[name];
  if (!notes) return;
  unlockAudio();
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + 0.05;
  for (const [freq, at, dur, type] of notes) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const peak = Math.max(0.0002, volume * (type === 'square' ? 0.12 : 0.35));
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
}

// ── Notifications ─────────────────────────────────────────────────────────
async function notifyDone(finished, next) {
  if (!settings.notify || !document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = finished === 'focus' ? 'Focus session done 🍅' : 'Break is over';
  const body = finished === 'focus'
    ? `Time for a ${next === 'long' ? 'long' : 'short'} break.`
    : 'Ready for the next focus session?';
  const options = { body, icon: 'icons/icon.svg', tag: 'focus-flow' };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) reg.showNotification(title, options);
    else new Notification(title, options);
  } catch { /* notifications unavailable */ }
}

// ── Rendering: timer ──────────────────────────────────────────────────────
function render() {
  document.body.dataset.mode = timer.mode;
  els.tabs.forEach((tab) => tab.setAttribute('aria-pressed', String(tab.dataset.mode === timer.mode)));
  els.modeLabel.textContent = MODES[timer.mode].label;
  els.start.textContent = timer.status === 'running' ? 'Pause' : timer.status === 'paused' ? 'Resume' : 'Start';

  const task = activeTask();
  els.currentTask.replaceChildren();
  if (timer.mode === 'focus') {
    if (task) {
      els.currentTask.append('Working on: ');
      const strong = document.createElement('strong');
      strong.textContent = task.title;
      els.currentTask.append(strong);
    } else {
      els.currentTask.textContent = 'No task selected';
    }
  } else {
    els.currentTask.textContent = 'Step away from the screen for a bit';
  }

  els.dots.replaceChildren();
  const filled = Math.min(timer.cycle, settings.longEvery);
  for (let i = 0; i < settings.longEvery; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i < filled ? ' filled' : '');
    els.dots.append(dot);
  }
  els.cycleText.textContent = `${filled} of ${settings.longEvery} until long break`;

  if (!els.motivation.textContent) els.motivation.textContent = pick(MODES[timer.mode].messages);

  requestAnimationFrame(() => {
    const color = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    if (color) els.themeMeta.setAttribute('content', color);
  });
  renderTime();
}

function renderTime() {
  const ms = remainingMs();
  const text = fmtClock(ms);
  els.time.textContent = text;
  const frac = timer.total ? ms / timer.total : 1;
  els.ring.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - frac);
  document.title = timer.status === 'idle' ? 'Focus Flow' : `${text} · ${MODES[timer.mode].label} · Focus Flow`;
}

// ── Rendering: tasks ──────────────────────────────────────────────────────
function renderTasks() {
  els.taskList.replaceChildren();
  els.taskEmpty.hidden = tasks.length > 0;

  for (const task of tasks) {
    const li = document.createElement('li');
    li.className = 'task' + (task.id === activeTaskId ? ' active' : '') + (task.finished ? ' finished' : '');

    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'activeTask';
    radio.checked = task.id === activeTaskId;
    radio.addEventListener('change', () => { activeTaskId = task.id; saveTasks(); renderTasks(); render(); });

    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.title;

    const count = document.createElement('span');
    count.className = 'task-count';
    count.textContent = `${task.done}/${task.est} 🍅`;
    count.title = `${task.done} of ${task.est} estimated pomodoros done`;

    label.append(radio, title, count);

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'icon-btn small';
    doneBtn.textContent = task.finished ? '↺' : '✓';
    doneBtn.setAttribute('aria-label', task.finished ? `Reopen "${task.title}"` : `Mark "${task.title}" finished`);
    doneBtn.title = task.finished ? 'Reopen' : 'Mark finished';
    doneBtn.addEventListener('click', () => {
      task.finished = !task.finished;
      if (task.finished && activeTaskId === task.id) activeTaskId = null;
      saveTasks(); renderTasks(); render();
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn small';
    delBtn.textContent = '×';
    delBtn.setAttribute('aria-label', `Delete "${task.title}"`);
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', () => {
      tasks = tasks.filter((t) => t.id !== task.id);
      if (activeTaskId === task.id) activeTaskId = null;
      saveTasks(); renderTasks(); render();
    });

    li.append(label, doneBtn, delBtn);
    els.taskList.append(li);
  }
}

function addTask(title, est) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tasks.push({ id, title, est, done: 0, finished: false });
  if (!activeTask()) activeTaskId = id;
  saveTasks();
  renderTasks();
  render();
}

// ── Rendering: stats ──────────────────────────────────────────────────────
function lastSevenDays(focus) {
  const byDay = new Map();
  for (const h of focus) {
    const k = dayKey(h.end);
    const d = byDay.get(k) || { minutes: 0, count: 0 };
    d.minutes += h.minutes; d.count += 1;
    byDay.set(k, d);
  }
  const days = [];
  const today = new Date(); today.setHours(12, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const k = dayKey(d);
    const v = byDay.get(k) || { minutes: 0, count: 0 };
    days.push({
      key: k,
      label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }),
      full: d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      minutes: v.minutes, count: v.count, isToday: i === 0,
    });
  }
  return days;
}

function streakDays(focus) {
  const days = new Set(focus.map((h) => dayKey(h.end)));
  const d = new Date(); d.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not started yet: streak can still be alive
  let streak = 0;
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return streak;
}

function renderStats() {
  const focus = history.filter((h) => h.mode === 'focus');
  const days = lastSevenDays(focus);
  const today = days[days.length - 1];

  els.statToday.textContent = fmtDuration(today.minutes);
  els.statCount.textContent = String(today.count);
  els.statStreak.textContent = String(streakDays(focus));
  els.statTotal.textContent = focus.length.toLocaleString();

  renderChart(days);
  renderTable(days);
  renderRecent(focus);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function niceAxis(max) {
  const target = Math.max(max, 60);
  const step = [15, 30, 60, 120, 180, 240, 360, 480].find((s) => target / s <= 4) || 600;
  return { step, top: step * Math.ceil(target / step) };
}

function tickLabel(min) {
  return min < 60 ? `${min}m` : `${+(min / 60).toFixed(1)}h`;
}

function renderChart(days) {
  const svg = els.chart;
  const W = Math.max(280, Math.floor(els.chartWrap.clientWidth));
  const H = 220;
  const m = { top: 22, right: 6, bottom: 28, left: 42 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const base = m.top + ih;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.replaceChildren();
  hideTip();

  const { step, top } = niceAxis(Math.max(...days.map((d) => d.minutes)));
  for (let v = 0; v <= top; v += step) {
    const y = Math.round(m.top + ih * (1 - v / top)) + 0.5;
    svg.append(svgEl('line', { class: v === 0 ? 'baseline' : 'grid-line', x1: m.left, x2: W - m.right, y1: y, y2: y }));
    const t = svgEl('text', { class: 'axis-label', x: m.left - 8, y: y + 4, 'text-anchor': 'end' });
    t.textContent = tickLabel(v);
    svg.append(t);
  }

  const slot = iw / days.length;
  const bw = Math.min(24, slot * 0.55);
  days.forEach((d, i) => {
    const cx = m.left + slot * i + slot / 2;
    const x = cx - bw / 2;
    let bar = null;
    let barTop = base;
    if (d.minutes > 0) {
      const h = Math.max(2, ih * (d.minutes / top));
      barTop = base - h;
      const r = Math.min(4, h, bw / 2);
      // 4px rounded data-end, square at the baseline
      bar = svgEl('path', {
        class: 'bar',
        d: `M${x},${base}V${barTop + r}Q${x},${barTop} ${x + r},${barTop}H${x + bw - r}Q${x + bw},${barTop} ${x + bw},${barTop + r}V${base}Z`,
      });
      svg.append(bar);
    }

    // Direct label only on today's bar (labels stay selective)
    if (d.isToday && d.minutes > 0) {
      const lbl = svgEl('text', { class: 'bar-label', x: cx, y: barTop - 6, 'text-anchor': 'middle' });
      lbl.textContent = fmtDuration(d.minutes);
      svg.append(lbl);
    }

    const xl = svgEl('text', { class: 'axis-label' + (d.isToday ? ' today' : ''), x: cx, y: H - 8, 'text-anchor': 'middle' });
    xl.textContent = d.label;
    svg.append(xl);

    // Hit target: the whole column slot, larger than the bar itself
    const hit = svgEl('rect', {
      class: 'hit', x: m.left + slot * i, y: m.top, width: slot, height: ih, tabindex: 0, role: 'img',
      'aria-label': `${d.full}: ${fmtDuration(d.minutes)} of focus, ${d.count} pomodoro${d.count === 1 ? '' : 's'}`,
    });
    const show = () => { if (bar) bar.classList.add('is-hover'); showTip(d, cx, barTop, W); };
    const hide = () => { if (bar) bar.classList.remove('is-hover'); hideTip(); };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.append(hit);
  });
}

function showTip(d, cx, y, W) {
  const tip = els.tooltip;
  tip.replaceChildren();
  const value = document.createElement('div');
  value.className = 'tip-value';
  const key = document.createElement('span');
  key.className = 'tip-key';
  value.append(key, fmtDuration(d.minutes));
  const label = document.createElement('div');
  label.className = 'tip-label';
  label.textContent = `${d.full} · ${d.count} pomodoro${d.count === 1 ? '' : 's'}`;
  tip.append(value, label);
  tip.hidden = false;
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(cx, half), W - half)}px`;
  tip.style.top = `${y}px`;
}

function hideTip() { els.tooltip.hidden = true; }

function renderTable(days) {
  const tbody = els.chartTable.tBodies[0];
  tbody.replaceChildren();
  for (const d of days) {
    const tr = document.createElement('tr');
    for (const [text, cls] of [[d.full, ''], [fmtDuration(d.minutes), 'num'], [String(d.count), 'num']]) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.append(td);
    }
    tbody.append(tr);
  }
  els.chartTable.hidden = !showTable;
  els.tableToggle.textContent = showTable ? 'Hide table' : 'Show table';
  els.tableToggle.setAttribute('aria-pressed', String(showTable));
}

function renderRecent(focus) {
  els.recent.replaceChildren();
  const recent = focus.slice(-8).reverse();
  if (!recent.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Finish a focus session to see it here.';
    els.recent.append(li);
    return;
  }
  for (const h of recent) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    const d = new Date(h.end);
    when.textContent = `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = h.task || 'Focus session';
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = fmtDuration(h.minutes);
    li.append(when, what, dur);
    els.recent.append(li);
  }
}

// ── CSV export ────────────────────────────────────────────────────────────
function exportCSV() {
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheets from running task names as formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const rows = [['date', 'start', 'end', 'mode', 'minutes', 'task']];
  for (const h of history) rows.push([dayKey(h.end), time(h.start), time(h.end), h.mode, h.minutes, h.task]);
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `focus-flow-${dayKey(Date.now())}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Settings dialog ───────────────────────────────────────────────────────
function applyTheme() {
  if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme;
  else delete document.documentElement.dataset.theme;
  render();
}

function fillForm(values) {
  const f = els.form.elements;
  for (const k of ['focus', 'short', 'long', 'longEvery', 'sound', 'volume', 'theme']) f[k].value = values[k];
  for (const k of ['autoBreaks', 'autoFocus', 'notify']) f[k].checked = values[k];
  els.notifyHint.hidden = true;
}

function readForm() {
  const f = els.form.elements;
  const int = (name, min, max) => Math.min(max, Math.max(min, Math.round(Number(f[name].value) || DEFAULTS[name])));
  return {
    focus: int('focus', 1, 120),
    short: int('short', 1, 60),
    long: int('long', 1, 90),
    longEvery: int('longEvery', 1, 12),
    autoBreaks: f.autoBreaks.checked,
    autoFocus: f.autoFocus.checked,
    sound: SOUNDS[f.sound.value] || f.sound.value === 'none' ? f.sound.value : DEFAULTS.sound,
    volume: Math.min(1, Math.max(0, Number(f.volume.value))),
    notify: f.notify.checked,
    theme: ['system', 'light', 'dark'].includes(f.theme.value) ? f.theme.value : 'system',
  };
}

async function onNotifyToggle(e) {
  const box = e.target;
  if (!box.checked) return;
  const fail = (msg) => { box.checked = false; els.notifyHint.textContent = msg; els.notifyHint.hidden = false; };
  if (!('Notification' in window)) return fail('This browser does not support notifications.');
  const result = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (result !== 'granted') fail('Notifications are blocked. Allow them for this site in your browser settings.');
  else els.notifyHint.hidden = true;
}

function onSettingsClosed() {
  if (els.dialog.returnValue !== 'save') return;
  const old = settings;
  settings = readForm();
  saveSettings();
  applyTheme();
  const lengthChanged = old[timer.mode] !== settings[timer.mode];
  if (timer.status === 'idle' && lengthChanged) setMode(timer.mode);
  else render();
}

// ── Events ────────────────────────────────────────────────────────────────
els.start.addEventListener('click', toggle);
els.reset.addEventListener('click', reset);
els.skip.addEventListener('click', skip);

els.tabs.forEach((tab) => tab.addEventListener('click', () => {
  const mode = tab.dataset.mode;
  if (mode === timer.mode) return;
  if (timer.status !== 'idle' && !confirm('Stop the current timer and switch modes?')) return;
  setMode(mode);
}));

els.taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = els.taskInput.value.trim();
  if (!title) return;
  const est = Math.min(20, Math.max(1, Math.round(Number(els.taskEst.value) || 1)));
  addTask(title, est);
  els.taskInput.value = '';
  els.taskEst.value = 1;
  els.taskInput.focus();
});

els.clearDone.addEventListener('click', () => {
  tasks = tasks.filter((t) => !t.finished);
  if (!activeTask()) activeTaskId = null;
  saveTasks(); renderTasks(); render();
});

els.tableToggle.addEventListener('click', () => { showTable = !showTable; renderStats(); });
els.exportBtn.addEventListener('click', exportCSV);
els.clearHistory.addEventListener('click', () => {
  if (!history.length || !confirm('Delete all session history? This cannot be undone.')) return;
  history = [];
  saveHistory();
  renderStats();
});

els.settingsBtn.addEventListener('click', () => { fillForm(settings); els.dialog.showModal(); });
els.dialog.addEventListener('close', onSettingsClosed);
els.form.elements.notify.addEventListener('change', onNotifyToggle);
els.defaults.addEventListener('click', () => fillForm(DEFAULTS));
els.preview.addEventListener('click', () => {
  const f = els.form.elements;
  playSound(f.sound.value, Number(f.volume.value));
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || els.dialog.open) return;
  if (e.target.closest('input, textarea, select')) return;
  const key = e.key.toLowerCase();
  if (key === ' ') {
    if (e.target.closest('button, a, [tabindex]')) return; // let Space activate the focused control
    e.preventDefault();
    toggle();
  } else if (key === 'r') reset();
  else if (key === 's') skip();
  else if (['1', '2', '3'].includes(key)) {
    const mode = ['focus', 'short', 'long'][Number(key) - 1];
    if (mode !== timer.mode && (timer.status === 'idle' || confirm('Stop the current timer and switch modes?'))) setMode(mode);
  }
});

document.addEventListener('visibilitychange', () => { checkFinished(); renderTime(); });

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => renderChart(lastSevenDays(history.filter((h) => h.mode === 'focus'))));
}).observe(els.chartWrap);

// ── Start up ──────────────────────────────────────────────────────────────
applyTheme();
if (timer.status === 'running') {
  if (remainingMs() <= 0) complete({ silent: true }); // finished while the page was closed
  else scheduleFinish();
}
render();
renderTasks();
renderStats();
setInterval(() => {
  if (timer.status !== 'running') return;
  if (remainingMs() <= 0) complete();
  else renderTime();
}, 250);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
