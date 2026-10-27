/* 英语教练 · 浏览器端引擎（离线版）
   逻辑和 server.mjs 一致，只是把存储换成 localStorage、内容来自 content.js。
   有了它这个应用就是一张静态网页：装到手机主屏、断网也能学，不依赖电脑。 */
window.Engine = (function () {
  'use strict';

  const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
  const MODULES = ['vocab', 'reading', 'grammar', 'listening', 'speaking'];
  const STORAGE_KEY = 'english-coach-state-v1';
  const PREV_KEY = 'english-coach-state-prev-v1';

/* ============================== 小工具 ============================== */
const pad2 = (n) => String(n).padStart(2, '0');
function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const todayStr = () => dateStr(new Date());
function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}
function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
function seedOf(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function makeRng(seed) {
  let s = seed || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function shuffleWithRng(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================== 内容加载（来自 content.js） ============================== */
const content = {};
for (const mod of MODULES) {
  content[mod] = {};
  for (const lv of LEVELS) content[mod][lv] = [];
}
let contentStats = {};

function loadContent() {
  const raw = window.CONTENT || {};
  const stats = {};
  for (const [file, parsed] of Object.entries(raw)) {
    const m = file.match(/^([a-z]+)\.([a-z0-9]+)\.json$/i);
    if (!m) continue;
    const mod = m[1].toLowerCase();
    const lv = m[2].toUpperCase();
    if (!MODULES.includes(mod) || !LEVELS.includes(lv)) continue;
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
    for (const it of items) if (it && typeof it === 'object') it._lv = lv;
    content[mod][lv] = items;
    stats[`${mod}.${lv}`] = items.length;
  }
  return stats;
}

function refreshContent() {
  contentStats = loadContent();
}

function contentCount(mod, lv) {
  return (content[mod] && content[mod][lv] && content[mod][lv].length) || 0;
}

function availableLevels(mod) {
  return LEVELS.filter((lv) => contentCount(mod, lv) > 0);
}

/* ============================== 状态读写（localStorage） ============================== */
function defaultState() {
  return {
    version: 1,
    profile: null,
    plan: null,
    srs: {},
    days: {},
    createdAt: new Date().toISOString(),
  };
}

let state = defaultState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state = Object.assign(defaultState(), parsed);
    if (!state.srs || typeof state.srs !== 'object') state.srs = {};
    if (!state.days || typeof state.days !== 'object') state.days = {};
  } catch {
    state = defaultState();
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 250);
}

// 存之前留一份上一版，万一数据被写坏还能捞回来
function saveState() {
  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    const next = JSON.stringify(state);
    if (prev && prev !== next) localStorage.setItem(PREV_KEY, prev);
    localStorage.setItem(STORAGE_KEY, next);
  } catch (e) {
    console.error('[state] 保存失败：', e.message);
  }
}

function getState() {
  return state;
}

/* ============================== 记忆曲线（SM-2 简化版） ============================== */
const RATING_Q = { again: 0, hard: 2, good: 4, easy: 5 };
function reviewCard(prev, rating) {
  const q = RATING_Q[rating] != null ? RATING_Q[rating] : 3;
  let ef = prev && typeof prev.ef === 'number' ? prev.ef : 2.5;
  let interval = prev && typeof prev.interval === 'number' ? prev.interval : 0;
  let reps = prev && typeof prev.reps === 'number' ? prev.reps : 0;
  let lapses = prev && typeof prev.lapses === 'number' ? prev.lapses : 0;
  let due;
  if (q < 3) {
    reps = 0;
    interval = 1;
    lapses += 1;
    ef = Math.max(1.3, ef - 0.2);
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 4;
    else interval = Math.max(1, Math.round(interval * ef));
    ef = Math.max(1.3, Math.min(3.0, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));
  }
  interval = Math.min(interval, 365);
  due = addDays(todayStr(), interval);
  return { ef: Math.round(ef * 100) / 100, interval, reps, lapses, due, last: todayStr(), lastRating: rating };
}

/* ============================== 计划生成（规则引擎） ============================== */
const MIX_BY_TARGET = {
  exam: { vocab: 0.3, reading: 0.25, listening: 0.18, grammar: 0.12, speaking: 0.15 },
  work: { vocab: 0.28, reading: 0.32, listening: 0.1, grammar: 0.14, speaking: 0.16 },
  life: { vocab: 0.26, reading: 0.1, listening: 0.3, grammar: 0.08, speaking: 0.26 },
  travel: { vocab: 0.26, reading: 0.08, listening: 0.32, grammar: 0.06, speaking: 0.28 },
  custom: { vocab: 0.28, reading: 0.2, listening: 0.2, grammar: 0.12, speaking: 0.2 },
};
const PHASE_NAME = { build: '打基础', push: '往前推', sprint: '冲刺' };
const PHASE_ADJ = {
  build: { vocab: 1.3, grammar: 1.3, reading: 1.0, listening: 0.9, speaking: 0.6 },
  push: { vocab: 1.0, grammar: 1.0, reading: 1.0, listening: 1.0, speaking: 1.0 },
  sprint: { vocab: 0.8, grammar: 0.8, reading: 1.2, listening: 1.2, speaking: 1.3 },
};
const THEME_BANK = {
  exam: ['摸底与节奏', '高频词打底', '听力抓关键信息', '阅读长难句', '写作骨架', '口语开口第一节', '综合串一遍', '错题复盘', '时间分配', '稳定输出', '查漏补缺', '最后过一遍'],
  work: ['职场高频表达', '邮件与通知', '会议听懂关键句', '写短报告', '汇报与演讲', '客户沟通', '跨文化沟通', '谈判与拒绝', '复盘与总结', '综合演练', '提速', '巩固'],
  life: ['开口说第一句', '点餐与购物', '问路与出行', '聊兴趣爱好', '讲讲昨天', '打电话', '表达观点', '商量与拒绝', '讲一个小故事', '综合对话', '自信开口', '巩固'],
  travel: ['机场与海关', '酒店入住', '问路与交通', '点餐结账', '购物砍价', '求助与应急', '景点与讲解', '和当地人聊', '办证件', '综合演练', '自由行实战', '巩固'],
  custom: ['起步', '积累', '扩展', '输出', '纠错', '提速', '综合', '巩固', '复盘', '进阶', '冲刺', '收尾'],
};
const TARGET_LABEL = {
  exam: '考试提分',
  work: '工作英语',
  life: '日常口语',
  travel: '出门旅行',
  custom: '自定义目标',
};

function normalizeMix(mix) {
  const total = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(mix)) out[k] = v / total;
  return out;
}

function distributeMinutes(totalMinutes, mix) {
  const total = Math.max(10, Math.round(totalMinutes));
  const parts = Object.entries(mix)
    .filter(([, w]) => w > 0.001)
    .map(([type, w]) => ({ type, minutes: Math.max(5, Math.round((w * total) / 5) * 5) }));
  let sum = parts.reduce((a, b) => a + b.minutes, 0);
  let guard = 0;
  while (sum > total && guard++ < 80) {
    const big = parts.filter((p) => p.minutes > 5).sort((a, b) => b.minutes - a.minutes)[0];
    if (!big) break;
    big.minutes -= 5;
    sum -= 5;
  }
  guard = 0;
  while (sum < total && guard++ < 80) {
    const vb = parts.find((p) => p.type === 'vocab') || parts[0];
    if (!vb) break;
    vb.minutes += 5;
    sum += 5;
  }
  return parts;
}

function countFor(type, minutes) {
  if (type === 'vocab') return Math.max(8, Math.round(minutes * 2));
  if (type === 'listening') return Math.max(5, Math.round(minutes * 1.2));
  return 1;
}

function buildPlan(profile) {
  const totalWeeks = Math.max(4, Math.min(52, profile.weeks || 12));
  const dailyMinutes = Math.max(10, Math.min(180, profile.dailyMinutes || 25));
  const baseMix = normalizeMix(MIX_BY_TARGET[profile.target] || MIX_BY_TARGET.custom);
  const themes = THEME_BANK[profile.target] || THEME_BANK.custom;
  const weekly = [];
  for (let w = 0; w < totalWeeks; w++) {
    const ratio = w / totalWeeks;
    const phase = ratio < 1 / 3 ? 'build' : ratio < 2 / 3 ? 'push' : 'sprint';
    const adj = PHASE_ADJ[phase];
    const mix = normalizeMix(
      Object.fromEntries(Object.entries(baseMix).map(([k, v]) => [k, v * (adj[k] || 1)]))
    );
    const days = [];
    for (let d = 0; d < 7; d++) {
      const isReviewDay = d === 6;
      let modules;
      if (isReviewDay) {
        const m = Math.max(10, Math.round((dailyMinutes * 0.6) / 5) * 5);
        modules = [{ type: 'vocab', minutes: m, count: countFor('vocab', m) }];
        if (dailyMinutes >= 40) {
          modules.push({ type: 'reading', minutes: 10, count: 1, review: true });
        }
      } else {
        modules = distributeMinutes(dailyMinutes, mix).map((m) => ({
          ...m,
          count: countFor(m.type, m.minutes),
        }));
      }
      days.push({ day: d + 1, review: isReviewDay, modules });
    }
    weekly.push({
      week: w + 1,
      phase,
      phaseName: PHASE_NAME[phase],
      theme: themes[w % themes.length],
      days,
    });
  }
  return {
    totalWeeks,
    dailyMinutes,
    target: profile.target,
    targetLabel: TARGET_LABEL[profile.target] || TARGET_LABEL.custom,
    level: profile.level,
    mix: baseMix,
    weekly,
    generatedAt: todayStr(),
    aiNotes: null,
  };
}

/* ============================== 今日任务展开 ============================== */
function collectLearnedIds() {
  const map = { vocab: new Set(), reading: new Set(), grammar: new Set(), listening: new Set(), speaking: new Set() };
  for (const day of Object.values(state.days)) {
    for (const it of day.items || []) {
      if (it && it.refId && map[it.type]) map[it.type].add(it.refId);
    }
  }
  return map;
}

function vocabPool(level) {
  const upto = LEVELS.indexOf(level);
  const out = [];
  for (const lv of LEVELS.slice(0, upto + 1)) out.push(...(content.vocab[lv] || []));
  return out;
}

function pickVocab(level, count) {
  const all = vocabPool(level);
  if (!all.length) return [];
  const byId = new Map(all.map((w) => [w.id, w]));
  const now = todayStr();
  const due = Object.keys(state.srs)
    .filter((id) => byId.has(id) && state.srs[id] && state.srs[id].due <= now)
    .sort((a, b) => String(state.srs[a].due).localeCompare(String(state.srs[b].due)));
  const fresh = all
    .filter((w) => !state.srs[w.id])
    .sort((a, b) => (a._lv === level ? 0 : 1) - (b._lv === level ? 0 : 1));
  const out = [];
  const dueCap = Math.max(3, Math.round(count * 0.7));
  for (const id of due.slice(0, dueCap)) out.push(byId.get(id));
  for (const w of fresh) {
    if (out.length >= count) break;
    out.push(w);
  }
  for (const id of due.slice(dueCap)) {
    if (out.length >= count) break;
    out.push(byId.get(id));
  }
  return out.filter(Boolean).slice(0, count);
}

function pickByRotation(mod, level, count) {
  const learned = collectLearnedIds()[mod];
  const pool = content[mod][level] || [];
  if (!pool.length) return [];
  const unread = pool.filter((x) => !learned.has(x.id));
  const list = unread.length ? unread : pool;
  return list.slice(0, count);
}

function pickListening(level, count, seedKey) {
  const pool = content.listening[level] || [];
  if (!pool.length) return [];
  const rnd = makeRng(seedOf(seedKey));
  const idx = shuffleWithRng([...pool.keys()], rnd);
  return idx.slice(0, Math.min(count, pool.length)).map((i) => pool[i]);
}

function buildModulePayload(mod, week) {
  const level = (state.profile && state.profile.level) || 'A2';
  if (mod.type === 'vocab') {
    const words = pickVocab(level, mod.count);
    if (!words.length) return null;
    return { type: 'vocab', minutes: mod.minutes, count: words.length, words };
  }
  if (mod.type === 'reading') {
    const list = pickByRotation('reading', level, mod.count);
    if (!list.length) return null;
    return { type: 'reading', minutes: mod.minutes, count: list.length, articles: list };
  }
  if (mod.type === 'grammar') {
    const list = pickByRotation('grammar', level, mod.count);
    if (!list.length) return null;
    return { type: 'grammar', minutes: mod.minutes, count: list.length, points: list };
  }
  if (mod.type === 'listening') {
    const lines = pickListening(level, mod.count, `${todayStr()}-${week.week}-${mod.minutes}`);
    if (!lines.length) return null;
    return { type: 'listening', minutes: mod.minutes, count: lines.length, lines };
  }
  if (mod.type === 'speaking') {
    const list = pickByRotation('speaking', level, mod.count);
    if (!list.length) return null;
    return { type: 'speaking', minutes: mod.minutes, count: list.length, tasks: list };
  }
  return null;
}

function ensureTodaySession() {
  const plan = state.plan;
  if (!plan) return null;
  const today = todayStr();
  if (!state.days[today]) {
    state.days[today] = { items: [], minutes: 0, notes: '', session: null };
  }
  const day = state.days[today];
  if (day.session) return day.session;

  const elapsed = Math.max(0, diffDays(plan.generatedAt, today));
  let weekIdx = Math.floor(elapsed / 7);
  const dayIdx = elapsed % 7;
  let cycle = 0;
  while (weekIdx >= plan.totalWeeks) {
    weekIdx -= plan.totalWeeks;
    cycle += 1;
  }
  const week = plan.weekly[Math.min(weekIdx, plan.weekly.length - 1)];
  const spec = week.days[dayIdx] || week.days[0];
  const items = [];
  for (let i = 0; i < spec.modules.length; i++) {
    const m = spec.modules[i];
    const payload = buildModulePayload(m, week);
    if (payload) items.push(Object.assign({ key: `${today}-${i}-${payload.type}` }, payload));
  }
  const totalMinutes = spec.modules.reduce((a, b) => a + b.minutes, 0);
  day.session = {
    date: today,
    week: weekIdx + 1,
    cycle,
    dayOfWeek: dayIdx + 1,
    phase: week.phase,
    phaseName: cycle > 0 ? '巩固期' : week.phaseName,
    theme: week.theme,
    review: !!spec.review,
    minutes: totalMinutes,
    items,
    empty: items.length === 0,
    createdAt: new Date().toISOString(),
  };
  scheduleSave();
  return day.session;
}

/* ============================== 定级测评出题 ============================== */
function buildPlacement() {
  const rnd = makeRng((Date.now() ^ 0x9e3779b9) >>> 0);
  const items = [];
  for (const lv of LEVELS) {
    const pool = (content.vocab[lv] || []).filter((w) => w.zh && w.w);
    if (pool.length < 4) continue;
    const picks = shuffleWithRng(pool, rnd).slice(0, 3);
    for (const w of picks) {
      const others = shuffleWithRng(
        pool.filter((x) => x.id !== w.id && x.zh !== w.zh),
        rnd
      ).slice(0, 3);
      if (others.length < 3) continue;
      const opts = shuffleWithRng([{ zh: w.zh, ok: true }, ...others.map((o) => ({ zh: o.zh, ok: false }))], rnd);
      items.push({
        id: `pv-${w.id}`,
        mod: 'vocab',
        level: lv,
        q: w.w,
        hint: w.pos || '',
        options: opts.map((o) => o.zh),
        answer: opts.findIndex((o) => o.ok),
      });
    }
  }
  for (const lv of LEVELS) {
    const pool = content.grammar[lv] || [];
    const drills = [];
    for (const g of pool) {
      for (const d of g.drills || []) {
        if (Array.isArray(d.options) && typeof d.answer === 'number' && d.options.length >= 2) drills.push({ g, d });
      }
    }
    if (!drills.length) continue;
    const pick = drills[Math.min(drills.length - 1, Math.floor(rnd() * drills.length))];
    const opts = shuffleWithRng(
      pick.d.options.map((t, i) => ({ t, ok: i === pick.d.answer })),
      rnd
    );
    items.push({
      id: `pg-${pick.g.id}`,
      mod: 'grammar',
      level: lv,
      q: pick.d.q,
      hint: '',
      options: opts.map((o) => o.t),
      answer: opts.findIndex((o) => o.ok),
    });
  }
  return items;
}

/* ============================== 进度统计 ============================== */
function computeStreak() {
  let streak = 0;
  let d = todayStr();
  if (!(state.days[d] && state.days[d].minutes > 0)) d = addDays(d, -1);
  let guard = 0;
  while (state.days[d] && state.days[d].minutes > 0 && guard++ < 2000) {
    streak += 1;
    d = addDays(d, -1);
  }
  return streak;
}

function progressSummary() {
  const days = Object.entries(state.days)
    .filter(([, v]) => v && v.minutes > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const totalMinutes = days.reduce((a, [, v]) => a + v.minutes, 0);
  const byType = {};
  for (const [, v] of Object.entries(state.days)) {
    for (const it of v.items || []) {
      byType[it.type] = (byType[it.type] || 0) + 1;
    }
  }
  const learned = Object.keys(state.srs).length;
  const mastered = Object.values(state.srs).filter((s) => s && s.interval >= 21).length;
  const calendar = {};
  for (const [k, v] of Object.entries(state.days)) {
    if (v && v.minutes > 0) calendar[k] = v.minutes;
  }
  const recent = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(todayStr(), -i);
    recent.push({ date: d, minutes: (state.days[d] && state.days[d].minutes) || 0 });
  }
  return {
    streak: computeStreak(),
    activeDays: days.length,
    totalMinutes,
    learnedWords: learned,
    masteredWords: mastered,
    byType,
    calendar,
    recent,
  };
}

/* ============================== 导出 Markdown ============================== */
const TYPE_LABEL = {
  vocab: '单词',
  reading: '阅读',
  grammar: '语法',
  listening: '听力跟读',
  speaking: '口语写作',
};

function buildMarkdown() {
  const p = state.profile;
  const plan = state.plan;
  const lines = [];
  lines.push('# 英语学习记录');
  lines.push('');
  lines.push(`> 导出时间：${todayStr()}`);
  lines.push('');
  if (p) {
    lines.push('## 学习档案');
    lines.push('');
    lines.push(`- 当前水平：${p.level}${p.levelScore != null ? `（测评 ${p.levelScore}）` : ''}`);
    lines.push(`- 学习目标：${TARGET_LABEL[p.target] || p.target}${p.targetDetail ? `，${p.targetDetail}` : ''}`);
    lines.push(`- 每天投入：${p.dailyMinutes} 分钟`);
    lines.push(`- 计划周期：${p.weeks} 周`);
    lines.push(`- 开始日期：${p.startedAt}`);
    if (p.weakSkills && p.weakSkills.length) lines.push(`- 待加强：${p.weakSkills.join('、')}`);
    lines.push('');
  }
  if (plan) {
    lines.push('## 学习计划');
    lines.push('');
    lines.push(`共 ${plan.totalWeeks} 周，每天 ${plan.dailyMinutes} 分钟，分为打基础／往前推／冲刺三个阶段。`);
    lines.push('');
    if (plan.aiNotes && plan.aiNotes.length) {
      lines.push('### 个性化建议');
      lines.push('');
      for (const n of plan.aiNotes) lines.push(`- ${n}`);
      lines.push('');
    }
    lines.push('| 周 | 阶段 | 本周主题 |');
    lines.push('| --- | --- | --- |');
    for (const w of plan.weekly) {
      lines.push(`| 第 ${w.week} 周 | ${w.phaseName} | ${w.theme} |`);
    }
    lines.push('');
  }
  lines.push('## 每日记录');
  lines.push('');
  const dayKeys = Object.keys(state.days).sort();
  if (!dayKeys.length) {
    lines.push('（还没有学习记录）');
    lines.push('');
  }
  for (const k of dayKeys) {
    const d = state.days[k];
    if (!d) continue;
    if (!d.minutes && !d.notes && !(d.items || []).length) continue;
    const s = d.session;
    const head = s ? `${k}（第 ${s.week} 周 第 ${s.dayOfWeek} 天 · ${s.theme}）` : k;
    lines.push(`### ${head}`);
    lines.push('');
    lines.push(`- 投入：${d.minutes || 0} 分钟`);
    const counts = {};
    for (const it of d.items || []) counts[it.type] = (counts[it.type] || 0) + 1;
    const cntStr = Object.entries(counts)
      .map(([t, c]) => `${TYPE_LABEL[t] || t} ${c} 次`)
      .join('、');
    if (cntStr) lines.push(`- 完成：${cntStr}`);
    const scored = (d.items || []).filter((it) => typeof it.correct === 'number');
    if (scored.length) {
      const ok = scored.reduce((a, b) => a + b.correct, 0);
      const all = scored.reduce((a, b) => a + (b.total || 0), 0);
      if (all) lines.push(`- 正确率：${Math.round((ok / all) * 100)}%（${ok}/${all}）`);
    }
    if (d.notes) {
      lines.push(`- 笔记：${String(d.notes).replace(/\n/g, ' ')}`);
    }
    lines.push('');
  }
  lines.push('## 词汇进度');
  lines.push('');
  const srsIds = Object.keys(state.srs);
  const mastered = Object.values(state.srs).filter((s) => s && s.interval >= 21).length;
  lines.push(`- 已学单词：${srsIds.length} 个`);
  lines.push(`- 进入长期记忆（间隔 ≥ 21 天）：${mastered} 个`);
  lines.push('');
  return lines.join('\n');
}


/* ============================== 接口层（替代原来的 fetch） ============================== */

function historyList() {
  return Object.entries(state.days)
    .filter(([, v]) => v && ((v.minutes || 0) > 0 || v.notes))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 90)
    .map(([date, v]) => ({
      date,
      minutes: v.minutes || 0,
      notes: v.notes || '',
      theme: (v.session && v.session.theme) || '',
      week: v.session ? v.session.week : null,
      dayOfWeek: v.session ? v.session.dayOfWeek : null,
      items: (v.items || []).length,
      types: [...new Set((v.items || []).map((it) => it.type))],
    }));
}

async function handle(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const base = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  const u = new URL(url, base);
  const route = u.pathname;
  let body = {};
  if (opts.body) {
    try {
      body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    } catch {
      body = {};
    }
  }

  if (route === '/api/bootstrap') {
    const t = todayStr();
    const session = state.profile ? ensureTodaySession() : null;
    return {
      contentStats,
      profile: state.profile,
      plan: state.plan,
      progress: progressSummary(),
      today: session,
      pageProgress: state.days[t] || null,
      history: historyList(),
      todayDate: t,
    };
  }

  if (route === '/api/placement') {
    return { items: buildPlacement() };
  }

  if (route === '/api/content') {
    const mod = u.searchParams.get('mod');
    const lv = (u.searchParams.get('level') || '').toUpperCase();
    if (!MODULES.includes(mod)) throw new Error('模块不存在');
    if (!LEVELS.includes(lv)) throw new Error('等级不存在');
    return { mod, level: lv, items: content[mod][lv] };
  }

  if (route === '/api/content-stats') {
    return {
      stats: contentStats,
      availableLevels: Object.fromEntries(MODULES.map((m) => [m, availableLevels(m)])),
    };
  }

  if (route === '/api/profile' && method === 'POST') {
    const level = LEVELS.includes(body.level) ? body.level : 'A2';
    const target = ['exam', 'work', 'life', 'travel', 'custom'].includes(body.target) ? body.target : 'custom';
    const weeks = Math.max(4, Math.min(52, Number(body.weeks) || 12));
    const dailyMinutes = Math.max(10, Math.min(180, Number(body.dailyMinutes) || 25));
    const profile = {
      level,
      levelScore: body.levelScore != null && String(body.levelScore).trim() !== '' ? String(body.levelScore) : null,
      levelDetail: body.levelDetail || null,
      target,
      targetDetail: body.targetDetail || '',
      weeks,
      dailyMinutes,
      weakSkills: Array.isArray(body.weakSkills) ? body.weakSkills.slice(0, 6) : [],
      startedAt: todayStr(),
      testedAt: new Date().toISOString(),
    };
    state.profile = profile;
    state.plan = buildPlan(profile);
    const t = todayStr();
    if (state.days[t]) state.days[t].session = null;
    state.srs = {};
    scheduleSave();
    return { ok: true, profile: state.profile, plan: state.plan, today: ensureTodaySession() };
  }

  if (route === '/api/plan/regenerate' && method === 'POST') {
    if (!state.profile) throw new Error('还没有学习档案');
    if (body.target && ['exam', 'work', 'life', 'travel', 'custom'].includes(body.target)) {
      state.profile.target = body.target;
    }
    if (body.targetDetail != null) state.profile.targetDetail = String(body.targetDetail);
    if (body.weeks) state.profile.weeks = Math.max(4, Math.min(52, Number(body.weeks)));
    if (body.dailyMinutes) state.profile.dailyMinutes = Math.max(10, Math.min(180, Number(body.dailyMinutes)));
    state.plan = buildPlan(state.profile);
    const t = todayStr();
    if (state.days[t]) state.days[t].session = null;
    scheduleSave();
    return { ok: true, profile: state.profile, plan: state.plan, today: ensureTodaySession() };
  }

  if (route === '/api/ai/polish') {
    return { ok: false, message: '离线版没有 AI 润色。想要 AI 的意见，在电脑上的完整版点一次就行。' };
  }

  if (route === '/api/today') {
    if (!state.profile) throw new Error('还没有学习档案');
    return { today: ensureTodaySession(), pageProgress: state.days[todayStr()] || null };
  }

  if (route === '/api/answer' && method === 'POST') {
    const type = body.type;
    if (!TYPE_LABEL[type]) throw new Error('未知题型');
    const t = todayStr();
    if (!state.days[t]) state.days[t] = { items: [], minutes: 0, notes: '', session: null };
    const day = state.days[t];

    if (type === 'vocab' && body.wordId) {
      const prev = state.srs[body.wordId] || null;
      const rating = ['again', 'hard', 'good', 'easy'].includes(body.rating) ? body.rating : 'good';
      state.srs[body.wordId] = reviewCard(prev, rating);
    }

    const minutes = Math.max(0, Math.min(180, Number(body.minutes) || 0));
    day.minutes = Math.round((day.minutes || 0) + minutes);
    day.items.push({
      type,
      key: body.key || null,
      refId: body.refId || null,
      wordId: body.wordId || null,
      rating: body.rating || null,
      correct: typeof body.correct === 'number' ? body.correct : null,
      total: typeof body.total === 'number' ? body.total : null,
      minutes,
      ts: new Date().toISOString(),
    });
    scheduleSave();
    return {
      ok: true,
      srs: type === 'vocab' && body.wordId ? state.srs[body.wordId] : null,
      todayMinutes: day.minutes,
      progress: progressSummary(),
    };
  }

  if (route === '/api/note' && method === 'POST') {
    const t = todayStr();
    if (!state.days[t]) state.days[t] = { items: [], minutes: 0, notes: '', session: null };
    state.days[t].notes = String(body.notes || '').slice(0, 8000);
    scheduleSave();
    return { ok: true, notes: state.days[t].notes };
  }

  if (route === '/api/progress') {
    return { progress: progressSummary(), days: state.days, todayDate: todayStr() };
  }

  if (route === '/api/export.md') {
    return { markdown: buildMarkdown(), filename: `英语学习记录-${todayStr()}.md` };
  }

  if (route === '/api/reset' && method === 'POST') {
    if (body.all) {
      state = defaultState();
    } else {
      state.profile = null;
      state.plan = null;
      state.srs = {};
      const t = todayStr();
      if (state.days[t]) state.days[t].session = null;
    }
    saveState();
    return { ok: true };
  }

  if (route === '/api/reload-content') {
    refreshContent();
    return { ok: true, stats: contentStats };
  }

  throw new Error('接口不存在');
}

/* ============================== 启动 ============================== */
refreshContent();
loadState();

return {
  handle,
  buildMarkdown,
  todayStr,
  dateStr,
  getState,
  saveState,
  loadState,
};
})();
