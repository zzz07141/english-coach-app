'use strict';

/* ============================================================
   英语教练 · 前端
   ============================================================ */

const LEVEL_LABEL = {
  A1: '入门 A1',
  A2: '基础 A2',
  B1: '进阶 B1',
  B2: '中高 B2',
  C1: '高阶 C1',
};

const TYPE_META = {
  vocab: { name: '单词', icon: '📖', cls: 'c-vocab' },
  reading: { name: '阅读', icon: '📰', cls: 'c-reading' },
  grammar: { name: '语法', icon: '✏️', cls: 'c-grammar' },
  listening: { name: '听力跟读', icon: '🎧', cls: 'c-listening' },
  speaking: { name: '口语写作', icon: '🗣️', cls: 'c-speaking' },
};

const TARGET_OPTIONS = [
  { id: 'exam', label: '考试提分', desc: '雅思 / 托福 / 四六级这类' },
  { id: 'work', label: '工作英语', desc: '看文档、写邮件、开会' },
  { id: 'life', label: '日常口语', desc: '能跟人聊起来' },
  { id: 'travel', label: '出门旅行', desc: '机场酒店点餐问路' },
  { id: 'custom', label: '自定义', desc: '我自己说' },
];

const App = {
  boot: null,
  view: 'today',
  modal: null,
  onboard: null,
  completed: new Set(),
  loading: true,
  error: null,
};

/* ============================== 基础工具 ============================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 所有请求都交给本地引擎：数据和逻辑就在这台设备里，不连服务器。
// 函数签名保持原样，调用处一行都不用改。
async function fetchJson(url, opts) {
  return window.Engine.handle(url, opts || {});
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function fmtMinutes(n) {
  n = Number(n) || 0;
  if (n < 60) return `${n} 分钟`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function weekdayCN(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return '日一二三四五六'[d.getDay()];
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rebuildCompleted(session, pageProgress) {
  const done = new Set();
  if (!session || !session.items) return done;
  const counts = new Map();
  for (const it of (pageProgress && pageProgress.items) || []) {
    if (!it || !it.key) continue;
    counts.set(it.key, (counts.get(it.key) || 0) + 1);
  }
  for (const item of session.items) {
    const need = item.type === 'vocab' ? item.count || 1 : 1;
    if ((counts.get(item.key) || 0) >= need) done.add(item.key);
  }
  return done;
}

function itemComplete(item) {
  return App.completed.has(item.key);
}

/* ============================== 启动 ============================== */
async function bootstrap() {
  try {
    App.boot = await fetchJson('/api/bootstrap');
    App.loading = false;
    if (!App.boot.profile) {
      App.onboard = { step: 0, placement: null, answers: [], result: null };
    } else {
      App.completed = rebuildCompleted(App.boot.today, App.boot.pageProgress);
    }
    render();
  } catch (e) {
    App.loading = false;
    App.error = e.message;
    render();
  }
}

async function refreshBoot() {
  App.boot = await fetchJson('/api/bootstrap');
  App.completed = rebuildCompleted(App.boot.today, App.boot.pageProgress);
  render();
}

/* ============================== 渲染入口 ============================== */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  if (App.loading) {
    app.innerHTML = `<div class="shell"><div class="empty"><div class="big">🌿</div><p>正在打开…</p></div></div>`;
    return;
  }
  if (App.error) {
    app.innerHTML = `<div class="shell"><div class="empty"><div class="big">😶</div><p>出了点问题：${esc(App.error)}</p>
      <div style="margin-top:18px"><button class="btn primary" data-act="reload">重试</button></div></div></div>`;
    return;
  }
  if (!App.boot.profile) return renderOnboard(app);
  renderMain(app);
}

/* ============================== 引导流程 ============================== */
function renderOnboard(app) {
  const ob = App.onboard;
  const stepBar = `<div class="steps">${[0, 1, 2, 3].map((i) => `<i class="${i <= ob.step ? 'on' : ''}"></i>`).join('')}</div>`;
  let body = '';
  if (ob.step === 0) body = onboardWelcome();
  else if (ob.step === 1) body = onboardPlacement();
  else if (ob.step === 2) body = onboardGoal();
  else body = onboardPlan();

  app.innerHTML = `<div class="shell"><div style="padding-top:34px">${stepBar}${body}</div></div>`;
  if (ob.step === 3) bindOnboardPlan();
}

function onboardWelcome() {
  return `
  <div class="onboard-hero">
    <div class="tag">ENGLISH COACH</div>
    <h2>先摸清你现在的底子，<br />再给你排一张学得下去的表。</h2>
    <p>接下来大概五分钟：一套定级小测，几个关于目标的问题。之后每天打开，它会告诉你今天学什么、学多久，做完自己记一笔。</p>
  </div>
  <div class="card">
    <h3>它是怎么给你排计划的</h3>
    <p class="muted" style="margin-top:6px">按你的真实水平和目标定模块配比——考试就多给阅读和听力，日常口语就多给听跟说。每天的量按你能挤出的分钟数来，学不动就调小，别硬撑。</p>
  </div>
  <div class="card">
    <h3>每天会留下什么</h3>
    <p class="muted" style="margin-top:6px">打卡天数、累计时长、每个词下次什么时候复习。想拿走的时候，一键导出成 Markdown 文件，不锁在软件里。</p>
  </div>
  <div class="btn-row">
    <button class="btn primary block" data-act="ob-start">开始定级测评</button>
  </div>
  <p class="muted" style="text-align:center;margin-top:14px;font-size:13px">数据只存在这台设备里，不联网也能用</p>`;
}

function onboardPlacement() {
  const ob = App.onboard;
  if (!ob.placement) {
    return `<div class="empty"><div class="big">⏳</div><p>正在出题…</p></div>`;
  }
  const items = ob.placement.items;
  const i = ob.answers.length;
  if (i >= items.length) return onboardResult();
  const item = items[i];
  return `
    <div class="card tight">
      <div class="row between">
        <span class="muted" style="font-size:13px">第 ${i + 1} / ${items.length} 题</span>
        <span class="muted" style="font-size:13px">${item.mod === 'vocab' ? '词汇' : '语法'}</span>
      </div>
      <div class="thin-bar" style="margin:10px 0 0"><i style="width:${((i / items.length) * 100).toFixed(1)}%"></i></div>
    </div>
    <div class="card">
      <div style="font-size:13px;color:var(--ink-3);letter-spacing:.5px">请选出正确的一项</div>
      <div class="word-main" style="font-size:${item.q.length > 26 ? 22 : 28}px;text-align:left;margin:10px 0 6px">${esc(item.q)}</div>
      ${item.hint ? `<div class="word-pos">${esc(item.hint)}</div>` : ''}
      <div class="stack" style="margin-top:16px">
        ${item.options
          .map(
            (o, oi) =>
              `<button class="option" data-act="ob-answer" data-idx="${oi}">${String.fromCharCode(65 + oi)}. ${esc(o)}</button>`
          )
          .join('')}
      </div>
    </div>
    <button class="btn ghost block" data-act="ob-skip">不知道，跳过这题</button>`;
}

function onboardResult() {
  const ob = App.onboard;
  const r = ob.result || computePlacementResult();
  App.onboard.result = r;
  return `
  <div class="card soft">
    <div style="font-size:13px;letter-spacing:1px;color:var(--brand);font-weight:650">测评完成</div>
    <div style="font-size:34px;font-weight:760;margin:8px 0 2px">${LEVEL_LABEL[r.level]}</div>
    <p class="muted">${esc(r.comment)}</p>
  </div>
  <div class="stat-grid">
    <div class="stat"><div class="num">${r.score}<span class="unit">/${r.total}</span></div><div class="label">答对题数</div></div>
    <div class="stat"><div class="num">${r.byLevelText}</div><div class="label">各级通过情况</div></div>
  </div>
  <div class="card">
    <h3>下一步</h3>
    <p class="muted" style="margin-top:6px">告诉我你想拿英语干什么，我用这个配每天的学习量。</p>
  </div>
  <div class="btn-row">
    <button class="btn" data-act="ob-retest">再测一次</button>
    <button class="btn primary" data-act="ob-next">继续</button>
  </div>`;
}

function computePlacementResult() {
  const items = App.onboard.placement.items;
  const answers = App.onboard.answers;
  const byLevel = {};
  items.forEach((it, i) => {
    if (!byLevel[it.level]) byLevel[it.level] = { ok: 0, all: 0 };
    byLevel[it.level].all += 1;
    if (answers[i] === it.answer) byLevel[it.level].ok += 1;
  });
  const order = ['A1', 'A2', 'B1', 'B2', 'C1'];
  let level = 'A1';
  const passed = [];
  for (const lv of order) {
    const s = byLevel[lv];
    if (!s) continue;
    const rate = s.ok / s.all;
    if (rate >= 0.6) {
      level = lv;
      passed.push(lv);
    } else break;
  }
  const score = items.reduce((a, it, i) => a + (answers[i] === it.answer ? 1 : 0), 0);
  const byLevelText = order
    .filter((lv) => byLevel[lv])
    .map((lv) => `${lv} ${byLevel[lv].ok}/${byLevel[lv].all}`)
    .join(' · ');
  const byLevelObj = {};
  for (const lv of order) if (byLevel[lv]) byLevelObj[lv] = byLevel[lv];
  const weak = [];
  const graItems = items.filter((x) => x.mod === 'grammar');
  let grOk = 0;
  graItems.forEach((it) => {
    const i = items.indexOf(it);
    if (answers[i] === it.answer) grOk += 1;
  });
  if (graItems.length && grOk / graItems.length < 0.5) weak.push('语法');
  const vocItems = items.filter((x) => x.mod === 'vocab');
  let voOk = 0;
  vocItems.forEach((it) => {
    const i = items.indexOf(it);
    if (answers[i] === it.answer) voOk += 1;
  });
  if (vocItems.length && voOk / vocItems.length < 0.5) weak.push('词汇');

  const comments = {
    A1: '基础还比较薄，我们从最常用的词和最简单的句子开始，不着急。',
    A2: '日常词汇认得一些，但还不稳。这个阶段把地基垫实，进步会很快。',
    B1: '能应付大部分日常场景了，接下来补准确度和输出。',
    B2: '底子不错，重点是让表达更自然、听长句不卡。',
    C1: '已经相当流利，重点打磨细节和地道表达。',
  };
  return {
    level,
    score,
    total: items.length,
    byLevel: byLevelObj,
    byLevelText,
    passed,
    weakSkills: weak,
    comment: comments[level] || '',
  };
}

function onboardGoal() {
  const r = App.onboard.result;
  const selTarget = App.onboard.target || 'life';
  const selWeeks = App.onboard.weeks || 12;
  const selMinutes = App.onboard.dailyMinutes || 25;
  const targetDesc = (TARGET_OPTIONS.find((t) => t.id === selTarget) || {}).desc || '';
  return `
  <div class="onboard-hero" style="padding-bottom:12px">
    <h2 style="font-size:24px">你要拿英语干什么？</h2>
    <p>这一项决定每天给你排什么活儿。</p>
  </div>
  <div class="card">
    <div class="chips" id="targetChips">
      ${TARGET_OPTIONS.map(
        (t) => `<button class="chip ${t.id === selTarget ? 'on' : ''}" data-act="ob-target" data-id="${t.id}">${t.label}</button>`
      ).join('')}
    </div>
    <p class="muted" style="margin-top:12px;font-size:14px">${esc(targetDesc)}</p>
  </div>
  <div class="card">
    <label style="font-size:14px;color:var(--ink-2);font-weight:560">每天大概能挤出多少分钟</label>
    <div class="chips" style="margin-top:10px" id="minuteChips">
      ${[15, 25, 40, 60]
        .map(
          (m) => `<button class="chip ${m === selMinutes ? 'on' : ''}" data-act="ob-minutes" data-id="${m}">${m} 分钟</button>`
        )
        .join('')}
    </div>
  </div>
  <div class="card">
    <label style="font-size:14px;color:var(--ink-2);font-weight:560">打算学多久</label>
    <div class="chips" style="margin-top:10px" id="weekChips">
      ${[8, 12, 16]
        .map((w) => `<button class="chip ${w === selWeeks ? 'on' : ''}" data-act="ob-weeks" data-id="${w}">${w} 周</button>`)
        .join('')}
    </div>
  </div>
  <div class="field">
    <label>还有什么具体想要的（可不填）</label>
    <input class="answer-input" id="targetDetail" placeholder="比如：半年后能自己看英文技术文档" style="min-height:48px" />
  </div>
  <div class="btn-row">
    <button class="btn" data-act="ob-back">上一步</button>
    <button class="btn primary" data-act="ob-build">生成我的计划</button>
  </div>`;
}

function onboardPlan() {
  const plan = App.bootPlan;
  const profile = App.bootProfile;
  if (!plan) return `<div class="empty"><div class="big">⏳</div><p>正在生成计划…</p></div>`;
  const phaseRows = plan.weekly
    .map(
      (w) => `<tr><td style="padding:6px 0;color:var(--ink-3);font-size:13px">第 ${w.week} 周</td>
      <td style="padding:6px 10px"><span class="chip" style="padding:2px 9px;font-size:12px">${w.phaseName}</span></td>
      <td style="padding:6px 0;font-size:14px">${esc(w.theme)}</td></tr>`
    )
    .join('');
  const mix = plan.mix || {};
  const mixText = Object.entries(mix)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${(TYPE_META[k] || { name: k }).name} ${Math.round(v * 100)}%`)
    .join(' · ');
  return `
  <div class="onboard-hero" style="padding-bottom:10px">
    <div class="tag">你的计划已排好</div>
    <h2 style="font-size:24px;margin-top:8px">${LEVEL_LABEL[profile.level]} · ${esc(plan.targetLabel || '')}<br />${plan.totalWeeks} 周，每天 ${plan.dailyMinutes} 分钟</h2>
    <p>${esc(mixText)}</p>
  </div>
  <div class="card">
    <h3 style="font-size:15px">每周主题</h3>
    <div style="max-height:260px;overflow:auto;margin-top:8px">
      <table style="width:100%;border-collapse:collapse">${phaseRows}</table>
    </div>
  </div>
  <div class="card" id="aiNoteCard">
    <h3 style="font-size:15px">要不要让 AI 老师看一眼</h3>
    <p class="muted" style="margin-top:6px;font-size:14px">规则排出来的表已经能用了。让它再挑挑毛病，会多给出几条针对你情况的调整建议。</p>
    <button class="btn sm" style="margin-top:12px" data-act="ob-ai">请 AI 看看这份计划</button>
    <div id="aiNoteBody"></div>
  </div>
  <div class="btn-row">
    <button class="btn primary block" data-act="ob-finish">就按这个来，开始第一天</button>
  </div>`;
}

function bindOnboardPlan() {}

/* ============================== 主视图 ============================== */
function renderMain(app) {
  const profile = App.boot.profile;
  const plan = App.boot.plan;
  const session = App.boot.today;
  const progress = App.boot.progress || {};

  let title = '今日';
  let sub = '';
  if (App.view === 'today') {
    const d = todayStr();
    sub = session
      ? `第 ${session.week} 周 第 ${session.dayOfWeek} 天 · ${session.phaseName}${session.theme ? ` · ${session.theme}` : ''}`
      : `${d} 周${weekdayCN(d)}`;
  } else if (App.view === 'progress') {
    title = '学习记录';
    sub = `已经坚持 ${progress.streak || 0} 天`;
  } else {
    title = '设置';
    sub = `${LEVEL_LABEL[profile.level]} · 每天 ${profile.dailyMinutes} 分钟`;
  }

  app.innerHTML = `
    <div class="shell">
      <div class="topbar"><h1>${title}</h1><div class="sub">${esc(sub)}</div></div>
      <div class="view" id="viewBody"></div>
    </div>
    <div class="tabbar"><div class="inner">
      <button class="${App.view === 'today' ? 'on' : ''}" data-act="tab" data-id="today"><span class="ti">🌿</span>今日</button>
      <button class="${App.view === 'progress' ? 'on' : ''}" data-act="tab" data-id="progress"><span class="ti">📈</span>记录</button>
      <button class="${App.view === 'settings' ? 'on' : ''}" data-act="tab" data-id="settings"><span class="ti">⚙️</span>设置</button>
    </div></div>`;

  const body = document.getElementById('viewBody');
  if (App.view === 'today') body.innerHTML = viewToday();
  else if (App.view === 'progress') body.innerHTML = viewProgress();
  else body.innerHTML = viewSettings();
}

function viewToday() {
  const session = App.boot.today;
  if (!session) {
    return `<div class="empty"><div class="big">🌱</div><p>还没有今天的学习安排。</p></div>`;
  }
  const doneCount = (session.items || []).filter(itemComplete).length;
  const totalCount = (session.items || []).length;
  const day = App.boot.pageProgress || { minutes: 0 };
  const doneMin = day.minutes || 0;
  const goal = session.minutes || App.boot.plan.dailyMinutes || 25;
  const pct = Math.min(100, Math.round((doneMin / Math.max(1, goal)) * 100));

  if (session.empty || !totalCount) {
    return `<div class="banner warn"><span class="bi">!</span><div>今天该练的内容库里还没有对得上的素材，先把内容补上就能开始了。</div></div>`;
  }

  const tasks = session.items
    .map((item, idx) => {
      const meta = TYPE_META[item.type] || { name: item.type, icon: '•', cls: '' };
      const done = itemComplete(item);
      const cnt =
        item.type === 'vocab'
          ? `${item.count} 个词`
          : item.type === 'listening'
          ? `${item.count} 句`
          : item.type === 'reading'
          ? `${item.count} 篇`
          : item.type === 'grammar'
          ? `${item.count} 个语法点`
          : `${item.count} 道题`;
      return `<button class="task ${done ? 'done' : ''}" data-act="open-task" data-idx="${idx}">
        <div class="ico ${meta.cls}">${meta.icon}</div>
        <div class="body">
          <div class="name">${meta.name}${done ? ' <span class="badge-done">已完成</span>' : ''}</div>
          <div class="meta">${cnt} · 约 ${item.minutes} 分钟</div>
        </div>
        <div class="go">›</div>
      </button>`;
    })
    .join('');

  return `
    <div class="hero">
      <div class="week">第 ${session.week} 周 · 第 ${session.dayOfWeek} 天${session.review ? ' · 复习日' : ''}</div>
      <div class="theme">${esc(session.theme || '今天')}</div>
      <div class="meter">
        <div class="meter-bar"><i style="width:${pct}%"></i></div>
        <div class="meter-txt">${doneMin} / ${goal} 分钟</div>
      </div>
    </div>
    ${doneCount === totalCount && totalCount > 0
      ? `<div class="banner info"><span class="bi">✓</span><div>今天的活干完了。要不要写一句今天卡在哪儿？明天我会记着。</div></div>`
      : ''}
    <div style="margin-bottom:14px">${tasks}</div>
    <div class="card">
      <h3 style="font-size:15px">今天的笔记</h3>
      <p class="muted" style="font-size:13px;margin-top:4px">卡在哪儿、想记住什么，写一句就行。之后导出时也会带上。</p>
      <textarea class="note-input" id="dayNote" placeholder="比如：listen 和 hear 还是分不清">${esc(day.notes || '')}</textarea>
      <button class="btn sm" style="margin-top:10px" data-act="save-note">保存笔记</button>
    </div>
    <p class="muted" style="text-align:center;font-size:12px;padding:8px 0 4px">记录都在本机 · 随时可导出</p>`;
}

function viewProgress() {
  const p = App.boot.progress || {};
  const recent = p.recent || [];
  const maxMin = Math.max(30, ...recent.map((r) => r.minutes));
  const bars = recent
    .slice(-14)
    .map((r) => {
      const h = Math.max(4, Math.round((r.minutes / maxMin) * 46));
      const d = r.date.slice(5);
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px">
        <div style="width:100%;display:flex;align-items:flex-end;height:48px">
          <div style="width:100%;height:${h}px;border-radius:5px 5px 2px 2px;background:${r.minutes > 0 ? 'var(--brand-2)' : '#ece8df'}"></div>
        </div>
        <div style="font-size:9px;color:var(--ink-3);white-space:nowrap">${d}</div>
      </div>`;
    })
    .join('');

  // 最近 8 周热力日历
  const cal = [];
  const todayD = new Date(`${todayStr()}T00:00:00`);
  const start = new Date(todayD);
  start.setDate(start.getDate() - 55);
  while (start.getDay() !== 0) start.setDate(start.getDate() - 1);
  for (let d = new Date(start); d <= todayD; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = (p.calendar && p.calendar[key]) || 0;
    const lv = m === 0 ? '' : m < 10 ? 'l1' : m < 25 ? 'l2' : m < 50 ? 'l3' : 'l4';
    const isToday = key === todayStr();
    cal.push(`<div class="cal-cell ${lv} ${isToday ? 'today' : ''}" title="${key} · ${m} 分钟"></div>`);
  }

  const byType = p.byType || {};
  const typeMax = Math.max(1, ...Object.values(byType));
  const typeRows = Object.keys(TYPE_META)
    .map((t) => {
      const v = byType[t] || 0;
      return `<div class="bar-row">
        <div class="bar-label">${TYPE_META[t].name}</div>
        <div class="bar-track"><i style="width:${Math.round((v / typeMax) * 100)}%"></i></div>
        <div class="bar-val">${v}</div>
      </div>`;
    })
    .join('');

  const history = App.boot.history || [];
  const historyHtml = history.length
    ? history
        .slice(0, 14)
        .map(
          (h) => `<div class="card tight">
            <div class="row between">
              <div style="font-weight:620;font-size:15px">${esc(h.date)} 周${weekdayCN(h.date)}</div>
              <div class="muted" style="font-size:13px">${h.minutes} 分钟</div>
            </div>
            ${h.theme ? `<div class="muted" style="font-size:13px;margin-top:2px">${esc(h.theme)}</div>` : ''}
            ${
              h.notes
                ? `<div style="font-size:14px;margin-top:8px;color:var(--ink-2);white-space:pre-wrap;line-height:1.65">${esc(
                    h.notes
                  )}</div>`
                : ''
            }
          </div>`
        )
        .join('')
    : '<div class="empty"><p>还没有记录。今天学一点就会出现在这里。</p></div>';

  return `
    <div class="stat-grid">
      <div class="stat"><div class="num">${p.streak || 0}<span class="unit">天</span></div><div class="label">连续打卡</div></div>
      <div class="stat"><div class="num">${fmtMinutes(p.totalMinutes || 0)}</div><div class="label">累计投入</div></div>
      <div class="stat"><div class="num">${p.learnedWords || 0}<span class="unit">个</span></div><div class="label">学过的单词</div></div>
      <div class="stat"><div class="num">${p.masteredWords || 0}<span class="unit">个</span></div><div class="label">进了长期记忆</div></div>
    </div>
    <div class="card">
      <h3 style="font-size:15px">最近两周</h3>
      <div style="display:flex;gap:3px;align-items:flex-end;margin-top:14px">${bars}</div>
    </div>
    <div class="card">
      <h3 style="font-size:15px">打卡日历</h3>
      <div class="calendar">${cal.join('')}</div>
      <div class="cal-legend">少 <i></i><i style="background:#cfe3da"></i><i style="background:#8dbcaa"></i><i style="background:#4e8d78"></i><i style="background:#2f6b5e"></i> 多</div>
    </div>
    <div class="card">
      <h3 style="font-size:15px">都在练什么</h3>
      <div class="bars" style="margin-top:12px">${typeRows}</div>
    </div>
    <div class="card">
      <h3 style="font-size:15px">导出</h3>
      <p class="muted" style="margin-top:6px;font-size:14px">把所有记录导成一份 Markdown 文件，手机电脑都能看，也不怕哪天软件不在了。</p>
      <button class="btn" style="margin-top:12px;display:flex" data-act="export-md">导出 Markdown</button>
    </div>
    <div style="margin-top:22px">
      <h3 style="font-size:15px;margin-bottom:10px">学习记录</h3>
      ${historyHtml}
    </div>`;
}

function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  } catch {
    return false;
  }
}

function viewSettings() {
  const profile = App.boot.profile;
  const plan = App.boot.plan;
  const aiNotes = (plan && plan.aiNotes) || null;
  const targetLabel = (TARGET_OPTIONS.find((t) => t.id === profile.target) || {}).label || profile.target;
  const installCard = isStandalone()
    ? ''
    : `<div class="card" style="border-color:var(--accent)">
      <h3 style="font-size:15px">装到手机主屏</h3>
      <p class="muted" style="margin-top:6px;font-size:13.5px">装完就真的像个小 App：有自己的图标、全屏打开、断网也能学。</p>
      <ol style="margin:10px 0 0 18px;font-size:13.5px;line-height:1.9">
        <li>用 Chrome、Edge 或 Safari 打开这个页面</li>
        <li>点浏览器菜单里的「安装应用」或「添加到主屏幕」</li>
      </ol>
      <p class="muted" style="margin-top:10px;font-size:12.5px;line-height:1.7">菜单里要是没有这两项，说明你用的浏览器不支持装 PWA——微信/QQ 里点开的、夸克、UC、火狐、iPhone 上的 Chrome 都属于这类。换成 Chrome 或 Safari 重开一次就有。</p>
    </div>`;
  return `
    ${installCard}
    <div class="card">
      <h3 style="font-size:15px">我的档案</h3>
      <div style="margin-top:12px;font-size:15px;line-height:2">
        <div class="row between"><span class="muted">水平</span><span>${LEVEL_LABEL[profile.level]}</span></div>
        <div class="row between"><span class="muted">目标</span><span>${esc(targetLabel)}${profile.targetDetail ? ` · ${esc(profile.targetDetail)}` : ''}</span></div>
        <div class="row between"><span class="muted">每天</span><span>${profile.dailyMinutes} 分钟</span></div>
        <div class="row between"><span class="muted">周期</span><span>${profile.weeks} 周</span></div>
        <div class="row between"><span class="muted">开始</span><span>${esc(profile.startedAt)}</span></div>
      </div>
    </div>
    <div class="card">
      <h3 style="font-size:15px">调整计划</h3>
      <p class="muted" style="font-size:14px;margin-top:6px">改了目标或每天的时间，计划会重新排——已经学过的词和记录不会丢。</p>
      <div class="chips" style="margin-top:14px" id="setTargetChips">
        ${TARGET_OPTIONS.map(
          (t) => `<button class="chip ${t.id === profile.target ? 'on' : ''}" data-act="set-target" data-id="${t.id}">${t.label}</button>`
        ).join('')}
      </div>
      <div class="chips" style="margin-top:10px" id="setMinuteChips">
        ${[15, 25, 40, 60]
          .map(
            (m) =>
              `<button class="chip ${m === profile.dailyMinutes ? 'on' : ''}" data-act="set-minutes" data-id="${m}">${m} 分钟</button>`
          )
          .join('')}
      </div>
      <button class="btn sm" style="margin-top:14px" data-act="apply-plan">按新设置重排计划</button>
    </div>
    <div class="card">
      <h3 style="font-size:15px">AI 老师的意见</h3>
      ${
        aiNotes
          ? `<ul style="margin:10px 0 0;padding-left:18px;font-size:14px;line-height:1.85;color:var(--ink-2)">${aiNotes
              .map((n) => `<li>${esc(n)}</li>`)
              .join('')}</ul>`
          : `<p class="muted" style="font-size:14px;margin-top:6px">还没让 AI 看过这份计划。</p>`
      }
      <button class="btn sm" style="margin-top:12px" data-act="ai-polish" id="aiBtn">${aiNotes ? '再要一份新意见' : '请 AI 看看这份计划'}</button>
    </div>
    <div class="card">
      <h3 style="font-size:15px">数据</h3>
      <button class="btn" style="margin-top:10px;display:flex" data-act="export-md">导出 Markdown</button>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn sm" style="flex:1" data-act="export-state">备份数据</button>
        <button class="btn sm" style="flex:1" data-act="import-state">恢复备份</button>
      </div>
      <p class="muted" style="font-size:12.5px;margin-top:8px">换手机、换浏览器，用这两个文件把记录搬过去。</p>
      <button class="btn" style="margin-top:10px;display:flex;width:100%" data-act="retest">重新做定级测评</button>
      <p class="muted" style="font-size:12.5px;margin-top:10px">重新测评会清空学习计划和词汇复习进度，但不删已有的每日记录。</p>
    </div>
    <div class="card" style="border-color:#f1d3cf">
      <h3 style="font-size:15px;color:var(--bad)">清空全部数据</h3>
      <p class="muted" style="font-size:13px;margin-top:6px">连记录带档案一起删掉，不能恢复。</p>
      <button class="btn sm" style="margin-top:10px;color:var(--bad);border-color:#f1d3cf" data-act="wipe">全部清空</button>
    </div>`;
}

/* ============================== 练习弹层 ============================== */
function modalHost() {
  let host = document.getElementById('modalRoot');
  if (!host) {
    host = document.createElement('div');
    host.id = 'modalRoot';
    document.body.appendChild(host);
  }
  return host;
}

function closeModal() {
  const host = document.getElementById('modalRoot');
  if (host) host.innerHTML = '';
  App.modal = null;
}

function openTask(idx) {
  const session = App.boot.today;
  const item = session.items[idx];
  if (!item) return;
  if (itemComplete(item)) {
    toast('这一项今天已经完成了');
    return;
  }
  App.modal = { item, idx, state: initModalState(item) };
  renderModal();
}

function initModalState(item) {
  if (item.type === 'vocab') return { wordIdx: 0, revealed: false, done: 0 };
  if (item.type === 'reading') return { ai: 0, answers: {}, correct: 0, answered: 0 };
  if (item.type === 'grammar') return { gi: 0, answers: {}, correct: 0, answered: 0 };
  if (item.type === 'listening') return { li: 0, checked: {}, correct: 0, answered: 0, inputs: {} };
  if (item.type === 'speaking') return { checks: {} };
  return {};
}

function modalFrame(title, bodyHtml, footHtml) {
  return `<div class="modal">
    <div class="modal-head">
      <button class="close" data-act="close-modal">×</button>
      <div class="title">${esc(title)}</div>
      <div style="width:34px"></div>
    </div>
    <div class="modal-body" id="modalBody">${bodyHtml}</div>
    <div class="modal-foot" id="modalFoot">${footHtml}</div>
  </div>`;
}

function renderModal() {
  const m = App.modal;
  if (!m) return;
  const host = modalHost();
  const item = m.item;
  const meta = TYPE_META[item.type];
  if (item.type === 'vocab') return renderVocabModal(host, m);
  if (item.type === 'reading') return renderReadingModal(host, m);
  if (item.type === 'grammar') return renderGrammarModal(host, m);
  if (item.type === 'listening') return renderListeningModal(host, m);
  if (item.type === 'speaking') return renderSpeakingModal(host, m);
  host.innerHTML = modalFrame(meta.name, '<p class="muted">这个题型还没做出来。</p>', '');
}

/* ---------- 单词 ---------- */
function renderVocabModal(host, m) {
  const words = m.item.words;
  const st = m.state;
  const w = words[st.wordIdx];
  if (!w) return finishVocab(host, m);
  const pct = (st.wordIdx / words.length) * 100;
  const front = `
    <div class="thin-bar"><i style="width:${pct}%"></i></div>
    <div class="view row between" style="margin-bottom:0">
      <span class="muted" style="font-size:13px">第 ${st.wordIdx + 1} / ${words.length} 个</span>
      <span class="muted" style="font-size:13px">${TYPE_META.vocab.name}</span>
    </div>
    <div class="word-stage">
      <div class="word-main">${esc(w.w)}</div>
      ${w.ph ? `<div class="word-ph">${esc(w.ph)}</div>` : ''}
      ${w.pos ? `<div class="word-pos">${esc(w.pos)}</div>` : ''}
      ${
        st.revealed
          ? `<div class="word-back">
              <div class="word-zh">${esc(w.zh)}</div>
              ${w.ex ? `<div class="ex"><span class="en">${esc(w.ex)}</span></div>` : ''}
              ${w.exh ? `<div class="ex" style="color:var(--ink-3);margin-top:6px">${esc(w.exh)}</div>` : ''}
            </div>`
          : ''
      }
    </div>`;
  const foot = st.revealed
    ? `<div class="rating-row">
        <button class="btn rt-again" data-act="vocab-rate" data-rating="again">忘了<small>马上再见</small></button>
        <button class="btn rt-hard" data-act="vocab-rate" data-rating="hard">勉强<small>几天后</small></button>
        <button class="btn rt-good" data-act="vocab-rate" data-rating="good">认识<small>记得住</small></button>
        <button class="btn rt-easy" data-act="vocab-rate" data-rating="easy">很熟<small>很久后</small></button>
      </div>`
    : `<button class="btn primary block" data-act="vocab-reveal">看答案</button>`;
  host.innerHTML = modalFrame('单词', front, foot);
}

async function rateVocab(rating) {
  const m = App.modal;
  const st = m.state;
  const words = m.item.words;
  const w = words[st.wordIdx];
  const per = Math.max(0.5, (m.item.minutes || 5) / Math.max(1, words.length));
  try {
    await fetchJson('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'vocab',
        key: m.item.key,
        wordId: w.id,
        rating,
        minutes: per,
      }),
    });
  } catch (e) {
    toast(e.message);
  }
  st.wordIdx += 1;
  st.revealed = false;
  if (st.wordIdx >= words.length) {
    return finishVocab(modalHost(), m);
  }
  renderVocabModal(modalHost(), m);
}

async function finishVocab(host, m) {
  await refreshBoot();
  closeModal();
  toast('这一组词过完了');
}

/* ---------- 阅读 ---------- */
function renderReadingModal(host, m) {
  const articles = m.item.articles;
  const st = m.state;
  const a = articles[st.ai];
  if (!a) return finishReading(host, m);

  const glossMap = new Map((a.gloss || []).map((g) => [String(g.w).toLowerCase(), g.zh]));
  const bodyHtml = (a.text || '')
    .split(/\n\n+/)
    .map((para) => {
      let safe = esc(para);
      // 生词自动高亮：长词优先，避免嵌套破坏
      const ws = (a.gloss || []).map((g) => g.w).sort((x, y) => y.length - x.length);
      for (const w of ws) {
        const re = new RegExp(`\\b(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(s|es|ed|ing|d)?\\b`, 'gi');
        safe = safe.replace(re, (full) => `<span class="gloss" data-act="gloss" data-zh="${esc(glossMap.get(w.toLowerCase()) || '')}">${full}</span>`);
      }
      return `<p>${safe}</p>`;
    })
    .join('');

  const questions = (a.questions || [])
    .map((q, qi) => {
      const answered = st.answers[qi] != null;
      const chosen = st.answers[qi];
      return `<div class="q-block">
        <div class="q-text">${qi + 1}. ${esc(q.q)}</div>
        ${q.options
          .map((o, oi) => {
            let cls = '';
            if (answered) {
              if (oi === q.answer) cls = 'right';
              else if (oi === chosen) cls = 'wrong';
              else cls = 'dim';
            }
            return `<button class="option ${cls}" data-act="ans" data-qi="${qi}" data-oi="${oi}">${String.fromCharCode(
              65 + oi
            )}. ${esc(o)}</button>`;
          })
          .join('')}
        ${answered && q.explain ? `<div class="explain">${esc(q.explain)}</div>` : ''}
      </div>`;
    })
    .join('');

  const allDone = (a.questions || []).every((_, qi) => st.answers[qi] != null);
  const foot = allDone
    ? `<button class="btn primary block" data-act="finish-reading">读完了，记一笔</button>`
    : `<button class="btn block" data-act="finish-reading-early">先记一笔，题先不做了</button>`;

  host.innerHTML = modalFrame(
    `阅读 · 第 ${st.ai + 1}/${articles.length} 篇`,
    `<div class="thin-bar"><i style="width:${(st.ai / articles.length) * 100}%"></i></div>
     <div class="article-title">${esc(a.title)}</div>
     <div class="article-meta">${esc(a.level || '')} · 约 ${a.estMinutes || 4} 分钟 · ${(a.text || '').split(/\s+/).length} 词</div>
     <div class="article-body">${bodyHtml}</div>
     ${questions}
     <p class="muted" style="font-size:13px;margin-top:18px">带虚线的词点一下有中文。读完做题，错题会告诉你为什么。</p>`,
    foot
  );
}

async function answerReading(qi, oi) {
  const m = App.modal;
  const a = m.item.articles[m.state.ai];
  if (m.state.answers[qi] != null) return;
  const q = a.questions[qi];
  m.state.answers[qi] = oi;
  if (oi === q.answer) m.state.correct += 1;
  renderReadingModal(modalHost(), m);
}

async function finishReading(host, m, early) {
  const a = m.item.articles[m.state.ai];
  const total = early ? 0 : (a.questions || []).length;
  const correct = early ? 0 : m.state.correct;
  try {
    await fetchJson('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'reading',
        key: m.item.key,
        refId: a.id,
        correct,
        total,
        minutes: m.item.minutes || 6,
      }),
    });
  } catch (e) {
    toast(e.message);
  }
  await refreshBoot();
  closeModal();
  toast('记下了');
}

/* ---------- 语法 ---------- */
function renderGrammarModal(host, m) {
  const points = m.item.points;
  const st = m.state;
  const g = points[st.gi];
  if (!g) return finishGrammar(host, m);

  const drills = (g.drills || [])
    .map((d, di) => {
      const answered = st.answers[di] != null;
      const chosen = st.answers[di];
      if (d.options) {
        return `<div class="q-block">
          <div class="q-text">${esc(d.q)}</div>
          ${d.options
            .map((o, oi) => {
              let cls = '';
              if (answered) {
                if (oi === d.answer) cls = 'right';
                else if (oi === chosen) cls = 'wrong';
                else cls = 'dim';
              }
              return `<button class="option ${cls}" data-act="drill" data-di="${di}" data-oi="${oi}">${String.fromCharCode(
                65 + oi
              )}. ${esc(o)}</button>`;
            })
            .join('')}
          ${answered && d.explain ? `<div class="explain">${esc(d.explain)}</div>` : ''}
        </div>`;
      }
      return `<div class="q-block"><div class="q-text">${esc(d.q)}</div>
        <div class="explain" style="display:${answered ? 'block' : 'none'}">参考答案：${esc(d.answer || '')}${d.explain ? ` —— ${esc(d.explain)}` : ''}</div>
        <button class="btn sm" style="margin-top:8px" data-act="drill-reveal" data-di="${di}">看答案</button></div>`;
    })
    .join('');

  const allDone = (g.drills || []).length === 0 || (g.drills || []).every((_, di) => st.answers[di] != null);
  const foot = allDone
    ? `<button class="btn primary block" data-act="finish-grammar">这个点学完了</button>`
    : `<button class="btn block" data-act="save-grammar">先记一笔</button>`;

  host.innerHTML = modalFrame(
    `语法 · 第 ${st.gi + 1}/${points.length} 个`,
    `<div class="thin-bar"><i style="width:${(st.gi / points.length) * 100}%"></i></div>
     <div class="g-point">${esc(g.point)}</div>
     <div class="g-explain">${esc(g.explain || '')}</div>
     ${
       g.examples && g.examples.length
         ? `<div class="g-examples">${g.examples
             .map((e) => `<div><div class="en">${esc(e.en)}</div><div class="zh">${esc(e.zh || '')}</div></div>`)
             .join('')}</div>`
         : ''
     }
     ${drills ? `<div style="margin-top:8px">${drills}</div>` : ''}`,
    foot
  );
}

function answerDrill(di, oi) {
  const m = App.modal;
  const g = m.item.points[m.state.gi];
  const d = g.drills[di];
  if (m.state.answers[di] != null) return;
  m.state.answers[di] = oi;
  if (oi === d.answer) m.state.correct += 1;
  renderGrammarModal(modalHost(), m);
}

async function finishGrammar(host, m) {
  const g = m.item.points[m.state.gi];
  const total = (g.drills || []).length;
  try {
    await fetchJson('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'grammar',
        key: m.item.key,
        refId: g.id,
        correct: m.state.correct,
        total,
        minutes: m.item.minutes || 6,
      }),
    });
  } catch (e) {
    toast(e.message);
  }
  await refreshBoot();
  closeModal();
  toast('记下了');
}

/* ---------- 听力 ---------- */
function renderListeningModal(host, m) {
  const lines = m.item.lines;
  const st = m.state;
  const cards = lines
    .map((ln, li) => {
      const checked = st.checked[li];
      const show = checked;
      return `<div class="listen-card">
        <div class="listen-num">第 ${li + 1} 句</div>
        <button class="play-btn" style="margin-top:8px" data-act="say" data-li="${li}">🔊 点一下听（可重复）</button>
        <textarea class="answer-input" data-input="listen" data-li="${li}" placeholder="把你听到的写下来，不用管大小写和标点">${esc(st.inputs[li] || '')}</textarea>
        <div class="row" style="margin-top:10px;gap:8px">
          <button class="btn sm" data-act="check" data-li="${li}">${checked ? '再看看' : '对答案'}</button>
          <button class="btn sm ghost" data-act="hint" data-li="${li}">中文提示</button>
        </div>
        ${
          show
            ? `<div class="reveal">
                <div class="diff-line">${(st.results && st.results[li] ? st.results[li].tokens : [])
                  .map((t) => `<span class="${t.ok ? 'w-ok' : 'w-bad'}">${esc(t.w)}</span>`)
                  .join(' ')}</div>
                <div class="en" style="margin-top:8px">${esc(ln.en || '')}</div>
                <div class="zh">${esc(ln.zh || '')}</div>
              </div>`
            : `<div class="reveal" id="hint-${li}" style="display:none"><div class="zh">${esc(ln.zh || '')}</div></div>`
        }
      </div>`;
    })
    .join('');

  const done = Object.keys(st.checked).length >= lines.length;
  const foot = done
    ? `<button class="btn primary block" data-act="finish-listening">这一轮听完了</button>`
    : `<button class="btn block" data-act="save-listening">先记一笔</button>`;

  host.innerHTML = modalFrame(
    '听力跟读',
    `<div class="banner info"><span class="bi">🎧</span><div>先听两遍再写。写不对没关系，对完答案再听一遍，把注意力放在连读和弱读上。</div></div>
     ${cards}`,
    foot
  );
}

function speak(text) {
  if (!('speechSynthesis' in window)) {
    toast('这个浏览器不支持朗读');
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.88;
  const vs = window.speechSynthesis.getVoices() || [];
  const en = vs.find((v) => /^en[-_](US|GB)/i.test(v.lang)) || vs.find((v) => /^en/i.test(v.lang));
  if (en) u.voice = en;
  window.speechSynthesis.speak(u);
}

function normalizeEn(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkListenInput(input, target) {
  const ins = normalizeEn(input).split(' ').filter(Boolean);
  const tgt = normalizeEn(target).split(' ').filter(Boolean);
  const used = new Array(ins.length).fill(false);
  let correct = 0;
  const tokens = tgt.map((w) => {
    const idx = ins.findIndex((x, k) => !used[k] && x === w);
    if (idx >= 0) {
      used[idx] = true;
      correct += 1;
      return { w, ok: true };
    }
    return { w, ok: false };
  });
  return { tokens, correct, total: tgt.length, extra: ins.filter((_, k) => !used[k]) };
}

function checkListening(li) {
  const m = App.modal;
  const st = m.state;
  const ln = m.item.lines[li];
  const input = st.inputs[li] || '';
  const r = checkListenInput(input, ln.en);
  st.results = st.results || {};
  st.results[li] = r;
  st.checked[li] = true;
  if (r.total && r.correct / r.total >= 0.85) st.correct += 1;
  st.answered += 1;
  renderListeningModal(modalHost(), m);
}

async function finishListening(host, m) {
  const total = m.item.lines.length;
  try {
    await fetchJson('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'listening',
        key: m.item.key,
        correct: m.state.correct,
        total,
        minutes: m.item.minutes || 5,
      }),
    });
  } catch (e) {
    toast(e.message);
  }
  await refreshBoot();
  closeModal();
  toast('记下了');
}

/* ---------- 口语 / 写作 ---------- */
function renderSpeakingModal(host, m) {
  const tasks = m.item.tasks;
  const st = m.state;
  const t = tasks[0];
  if (!t) return finishSpeaking(host, m);
  const isWrite = t.kind === 'write';
  const checklist = (t.checklist || [])
    .map(
      (c, ci) =>
        `<label><input type="checkbox" data-input="check" data-ci="${ci}" ${st.checks[ci] ? 'checked' : ''} /><span>${esc(
          c
        )}</span></label>`
    )
    .join('');
  const prompts = (t.prompts || []).length
    ? `<ul class="hint-list">${t.prompts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '<div class="qa"></div>';

  host.innerHTML = modalFrame(
    isWrite ? '写作' : '口语',
    `<div class="speak-title">${esc(t.task)}</div>
     <div class="speak-zh">${esc(t.zh || '')}</div>
     ${prompts}
     ${
       isWrite
         ? `<div style="margin-top:16px"><div class="muted" style="font-size:13px;margin-bottom:8px">写在这儿，只存本机</div>
            <textarea class="note-input" id="writeBox" style="min-height:200px" placeholder="先别管语法，把想说的写顺">${esc(st.draft || '')}</textarea></div>`
         : `<div class="timer-note">建议先自己说一遍（可以录音对照），说完再逐条自评。</div>
            <button class="btn sm" style="margin-top:10px" data-act="speak-timer">开始计时</button>
            <span class="muted" style="font-size:13px;margin-left:8px" id="timerShow"></span>`
     }
     <div class="checklist">${checklist || '<p class="muted">这一题没有自评清单。</p>'}</div>
     ${
       t.sample
         ? `<details style="margin-top:16px"><summary style="cursor:pointer;color:var(--brand);font-size:14px">看一个参考说法</summary>
            <div class="sample">${esc(t.sample)}</div></details>`
         : ''
     }`,
    `<button class="btn primary block" data-act="finish-speaking">${isWrite ? '写完了，记一笔' : '说完了，记一笔'}</button>`
  );
}

async function finishSpeaking(host, m) {
  const t = m.item.tasks[0];
  const draft = document.getElementById('writeBox');
  const total = (t.checklist || []).length;
  const checked = Object.values(m.state.checks).filter(Boolean).length;
  try {
    await fetchJson('/api/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'speaking',
        key: m.item.key,
        refId: t.id,
        correct: checked,
        total,
        minutes: m.item.minutes || 8,
      }),
    });
    if (draft && draft.value.trim()) {
      await fetchJson('/api/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notes: `${draft.value.trim()}`.slice(0, 4000),
        }),
      });
    }
  } catch (e) {
    toast(e.message);
  }
  await refreshBoot();
  closeModal();
  toast('记下了');
}

/* ============================== 导出 ============================== */
async function exportMarkdown() {
  try {
    const r = await window.Engine.handle('/api/export.md');
    const blob = new Blob([r.markdown], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.filename || '英语学习记录.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('导出了，去「下载」里找');
  } catch (err) {
    toast('导出失败：' + err.message);
  }
}

async function exportState() {
  const st = window.Engine.getState();
  const blob = new Blob([JSON.stringify(st, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `英语教练备份-${window.Engine.todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('备份好了，存到一个安全的地方');
}

function importState() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!obj || typeof obj !== 'object' || !obj.days) throw new Error('这个文件不像备份');
      localStorage.setItem('english-coach-state-v1', JSON.stringify(obj));
      toast('恢复了，正在重新打开');
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      toast('恢复失败：' + e.message);
    }
  };
  input.click();
}

/* ============================== 事件处理（全局委托） ============================== */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  try {
    if (act === 'reload') location.reload();
    else if (act === 'tab') {
      App.view = t.dataset.id;
      render();
      window.scrollTo({ top: 0 });
    } else if (act === 'open-task') {
      openTask(Number(t.dataset.idx));
    } else if (act === 'close-modal') {
      closeModal();
    } else if (act === 'gloss') {
      toast(t.dataset.zh || '');
    } else if (act === 'say') {
      const li = Number(t.dataset.li);
      const ln = App.modal.item.lines[li];
      if (ln) speak(ln.en);
    } else if (act === 'hint') {
      const li = Number(t.dataset.li);
      const box = document.getElementById(`hint-${li}`);
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    } else if (act === 'check') {
      checkListening(Number(t.dataset.li));
    } else if (act === 'vocab-reveal') {
      App.modal.state.revealed = true;
      renderVocabModal(modalHost(), App.modal);
    } else if (act === 'vocab-rate') {
      await rateVocab(t.dataset.rating);
    } else if (act === 'ans') {
      await answerReading(Number(t.dataset.qi), Number(t.dataset.oi));
    } else if (act === 'drill') {
      answerDrill(Number(t.dataset.di), Number(t.dataset.oi));
    } else if (act === 'drill-reveal') {
      const di = Number(t.dataset.di);
      App.modal.state.answers[di] = -1;
      renderGrammarModal(modalHost(), App.modal);
    } else if (act === 'finish-reading') {
      await finishReading(modalHost(), App.modal, false);
    } else if (act === 'finish-reading-early') {
      await finishReading(modalHost(), App.modal, true);
    } else if (act === 'save-grammar') {
      await finishGrammar(modalHost(), App.modal);
    } else if (act === 'finish-grammar') {
      await finishGrammar(modalHost(), App.modal);
    } else if (act === 'save-listening') {
      await finishListening(modalHost(), App.modal);
    } else if (act === 'finish-listening') {
      await finishListening(modalHost(), App.modal);
    } else if (act === 'finish-speaking') {
      await finishSpeaking(modalHost(), App.modal);
    } else if (act === 'speak-timer') {
      startSpeakTimer();
    } else if (act === 'save-note') {
      await saveNote();
    } else if (act === 'export-md') {
      await exportMarkdown();
    } else if (act === 'export-state') {
      await exportState();
    } else if (act === 'import-state') {
      importState();
    }
    /* ---------- 引导 ---------- */
    else if (act === 'ob-start') {
      App.onboard.step = 1;
      App.onboard.answers = [];
      render();
      loadPlacement();
    } else if (act === 'ob-answer') {
      choosePlacement(Number(t.dataset.idx));
    } else if (act === 'ob-skip') {
      choosePlacement(-1);
    } else if (act === 'ob-retest') {
      App.onboard.step = 1;
      App.onboard.answers = [];
      App.onboard.result = null;
      render();
      loadPlacement();
    } else if (act === 'ob-next') {
      App.onboard.step = 2;
      render();
    } else if (act === 'ob-target') {
      App.onboard.target = t.dataset.id;
      render();
    } else if (act === 'ob-minutes') {
      App.onboard.dailyMinutes = Number(t.dataset.id);
      render();
    } else if (act === 'ob-weeks') {
      App.onboard.weeks = Number(t.dataset.id);
      render();
    } else if (act === 'ob-back') {
      App.onboard.step = 1;
      render();
    } else if (act === 'ob-build') {
      await buildProfile();
    } else if (act === 'ob-finish') {
      await finishOnboard();
    } else if (act === 'ob-ai') {
      await askAI(t);
    }
    /* ---------- 设置 ---------- */
    else if (act === 'set-target') {
      App.setTarget = t.dataset.id;
      markChips('#setTargetChips', t.dataset.id);
    } else if (act === 'set-minutes') {
      App.setMinutes = Number(t.dataset.id);
      markChips('#setMinuteChips', t.dataset.id);
    } else if (act === 'apply-plan') {
      await applyPlanChange();
    } else if (act === 'ai-polish') {
      await askAI(t);
    } else if (act === 'retest') {
      if (confirm('重新测评会清空学习计划和单词复习进度（每日记录保留），确定吗？')) {
        await fetchJson('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        App.boot.profile = null;
        App.onboard = { step: 0, placement: null, answers: [], result: null };
        render();
      }
    } else if (act === 'wipe') {
      if (confirm('全部数据清空，不能恢复。真的要删吗？')) {
        await fetchJson('/api/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        location.reload();
      }
    }
  } catch (err) {
    console.error(err);
    toast(err.message || '出错了');
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.input === 'listen') {
    const li = Number(t.dataset.li);
    if (App.modal) App.modal.state.inputs[li] = t.value;
  } else if (t.dataset.input === 'check') {
    const ci = Number(t.dataset.ci);
    if (App.modal) App.modal.state.checks[ci] = t.checked;
  }
});

function markChips(sel, id) {
  const box = document.querySelector(sel);
  if (!box) return;
  for (const b of box.querySelectorAll('[data-act]')) {
    b.classList.toggle('on', b.dataset.id === String(id));
  }
}

/* ============================== 引导动作 ============================== */
async function loadPlacement() {
  try {
    const r = await fetchJson('/api/placement');
    App.onboard.placement = r;
    App.onboard.answers = [];
    render();
  } catch (e) {
    App.onboard.placement = null;
    App.onboard.step = 0;
    render();
    toast(`出题失败：${e.message}`);
  }
}

function choosePlacement(idx) {
  const ob = App.onboard;
  if (!ob.placement) return;
  ob.answers.push(idx);
  if (ob.answers.length >= ob.placement.items.length) {
    ob.result = computePlacementResult();
    render();
  } else {
    render();
  }
}

async function buildProfile() {
  const r = App.onboard.result;
  const target = App.onboard.target || 'life';
  const weeks = App.onboard.weeks || 12;
  const dailyMinutes = App.onboard.dailyMinutes || 25;
  const detailEl = document.getElementById('targetDetail');
  const targetDetail = detailEl ? detailEl.value.trim() : '';
  try {
    const res = await fetchJson('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: r.level,
        levelScore: `${r.score}/${r.total}`,
        levelDetail: r.byLevel,
        target,
        targetDetail,
        weeks,
        dailyMinutes,
        weakSkills: r.weakSkills || [],
      }),
    });
    App.bootPlan = res.plan;
    App.bootProfile = res.profile;
    App.onboard.step = 3;
    render();
  } catch (e) {
    toast(e.message);
  }
}

async function finishOnboard() {
  await refreshBoot();
  App.view = 'today';
  render();
}

async function askAI(btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在问…';
  }
  try {
    const r = await fetchJson('/api/ai/polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(r.message || 'AI 没回话');
    if (App.onboard && App.onboard.step === 3) {
      const box = document.getElementById('aiNoteBody');
      if (box) {
        box.innerHTML = `<ul style="margin:12px 0 0;padding-left:18px;font-size:14px;line-height:1.85;color:var(--ink-2)">${r.notes
          .map((n) => `<li>${esc(n)}</li>`)
          .join('')}</ul>`;
      }
      if (btn) btn.remove();
    } else {
      App.boot.plan = App.boot.plan || {};
      App.boot.plan.aiNotes = r.notes;
      render();
      toast('AI 的意见加上了');
    }
  } catch (e) {
    toast(e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '再试一次';
    }
  }
}

async function applyPlanChange() {
  const target = App.setTarget || App.boot.profile.target;
  const dailyMinutes = App.setMinutes || App.boot.profile.dailyMinutes;
  try {
    const r = await fetchJson('/api/plan/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, dailyMinutes }),
    });
    App.boot.profile = r.profile;
    App.boot.plan = r.plan;
    App.boot.today = r.today;
    App.setTarget = null;
    App.setMinutes = null;
    await refreshBoot();
    toast('计划重排好了');
  } catch (e) {
    toast(e.message);
  }
}

/* ============================== 今日零碎 ============================== */
async function saveNote() {
  const el = document.getElementById('dayNote');
  if (!el) return;
  try {
    await fetchJson('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: el.value }),
    });
    if (App.boot.pageProgress) App.boot.pageProgress.notes = el.value;
    toast('笔记存好了');
  } catch (e) {
    toast(e.message);
  }
}

let speakTimerId = null;
function startSpeakTimer() {
  const show = document.getElementById('timerShow');
  const btn = document.querySelector('[data-act="speak-timer"]');
  if (speakTimerId) {
    clearInterval(speakTimerId);
    speakTimerId = null;
    if (btn) btn.textContent = '开始计时';
    return;
  }
  let sec = 0;
  if (btn) btn.textContent = '停下';
  speakTimerId = setInterval(() => {
    sec += 1;
    if (show) show.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  }, 1000);
}

/* ============================== 启动 ============================== */
bootstrap();
