/**
 * Leverage view — the dashboard's lead screen.
 *
 * Answers one question from observed screen time: where did the week go,
 * and what is the one change worth making? Also owns the privacy & health
 * strip and OPERATOR_MODE gating. Loaded after app.js; reuses its helpers
 * (escapeHtml, formatMinutes) which are plain top-level functions.
 */

// ------------------------------------------------------------------
// Classification — activity categories into three leverage buckets
// ------------------------------------------------------------------

const LEV_DEEP = new Set(['coding', 'writing', 'design', 'learning', 'decision']);
const LEV_REACTIVE = new Set(['browsing', 'communication', 'email', 'messaging', 'meeting', 'meetings']);

/** Apps/sites that are classic delegation or batching candidates. */
const DELEGABLE_RE =
  /mail|gmail|outlook|calendar|calendly|schedul|invoice|billing|bookkeep|quickbooks|expense|receipt|linkedin|instagram|facebook|twitter|x\.com|amazon|shopping|travel|booking/i;

function levBucket(category) {
  const c = (category || '').toLowerCase();
  if (LEV_DEEP.has(c)) return 'deep';
  if (LEV_REACTIVE.has(c)) return 'reactive';
  return 'other';
}

/** Sums byCategory rows into {deep, reactive, other} minutes. */
function levSplit(byCategory) {
  const split = { deep: 0, reactive: 0, other: 0 };
  for (const row of byCategory || []) {
    split[levBucket(row.label)] += row.minutes || 0;
  }
  return split;
}

// ------------------------------------------------------------------
// Data + render
// ------------------------------------------------------------------

async function loadLeverage() {
  const hero = document.getElementById('lev-hero');
  if (!hero) return;
  try {
    const [wkRes, twoWkRes, scoreRes] = await Promise.all([
      fetch('/api/breakdown?hours=168'),
      fetch('/api/breakdown?hours=336'),
      fetch('/api/scorecard?days=14'),
    ]);
    const week = await wkRes.json();
    const twoWeek = await twoWkRes.json();
    const score = scoreRes.ok ? await scoreRes.json() : { trend: [] };

    if (!wkRes.ok || (week.totalMinutes || 0) < 5) {
      hero.innerHTML =
        '<div class="empty-state">Not enough observed time yet this week. The view fills in as Ambient watches.</div>';
      document.getElementById('lev-move').innerHTML = '';
      document.getElementById('lev-delegation').innerHTML = '';
      return;
    }

    const split = levSplit(week.byCategory);
    const prior = priorWeek(week, twoWeek);
    renderLevHero(hero, week, split, prior, score);
    renderLevMove(week, split, prior);
    renderLevDelegation(week);
  } catch {
    hero.innerHTML =
      '<div class="empty-state">Could not reach the daemon. Is it running?</div>';
  }
}

/** Derives last week's totals by subtracting this week from the 2-week window. */
function priorWeek(week, twoWeek) {
  const total = Math.max(0, (twoWeek.totalMinutes || 0) - (week.totalMinutes || 0));
  const wk = levSplit(week.byCategory);
  const two = levSplit(twoWeek.byCategory);
  return {
    total,
    deep: Math.max(0, two.deep - wk.deep),
    reactive: Math.max(0, two.reactive - wk.reactive),
    other: Math.max(0, two.other - wk.other),
  };
}

function pctOf(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function renderLevHero(hero, week, split, prior, score) {
  const total = week.totalMinutes || 0;
  const dPct = pctOf(split.deep, total);
  const rPct = pctOf(split.reactive, total);
  const oPct = Math.max(0, 100 - dPct - rPct);

  // Trend vs the prior week: deep-work share, only when there is history.
  let trendHtml = '';
  if (prior.total >= 60) {
    const priorPct = pctOf(prior.deep, prior.total);
    const delta = dPct - priorPct;
    const dir = delta >= 0 ? 'up' : 'down';
    const word = delta >= 0 ? 'up' : 'down';
    trendHtml = `<span class="lev-trend ${dir}">Deep work ${word} ${Math.abs(delta)} pts vs last week</span>`;
  }

  const spark = (Array.isArray(score.trend) ? score.trend : [])
    .slice()
    .reverse()
    .map((d) => {
      const p = Math.round((d.focus_score || 0) * 100);
      return `<span class="spark-bar" style="height:${Math.max(6, p)}%" title="${escapeHtml(d.date)}: ${p}%"></span>`;
    })
    .join('');

  hero.innerHTML = `
    <div class="lev-kicker">This week, observed</div>
    <div class="lev-headline">
      <span class="lev-total">${formatMinutes(total)}</span>
      <span class="lev-total-sub">of tracked working time</span>
      ${trendHtml}
    </div>
    <div class="lev-bar" role="img" aria-label="Deep work ${dPct}%, reactive ${rPct}%, unclassified ${oPct}%">
      <div class="lev-seg deep" style="width:${dPct}%"></div>
      <div class="lev-seg reactive" style="width:${rPct}%"></div>
      <div class="lev-seg other" style="width:${oPct}%"></div>
    </div>
    <div class="lev-legend">
      <span class="lev-key"><i class="lev-dot deep"></i>Deep work · ${formatMinutes(split.deep)} (${dPct}%)</span>
      <span class="lev-key"><i class="lev-dot reactive"></i>Reactive · ${formatMinutes(split.reactive)} (${rPct}%)</span>
      <span class="lev-key"><i class="lev-dot other"></i>Unclassified · ${formatMinutes(split.other)} (${oPct}%)</span>
    </div>
    ${spark ? `<div class="lev-spark-row"><span class="lev-spark-label">Focus, last 14 days</span><span class="fs-spark">${spark}</span></div>` : ''}
  `;
}

/** The single recommendation. Honest heuristics over observed time only. */
function renderLevMove(week, split, prior) {
  const el = document.getElementById('lev-move');
  if (!el) return;

  const candidates = topDelegable(week);
  let body;
  if (candidates.length > 0) {
    const c = candidates[0];
    body =
      `${escapeHtml(c.label)} took ${formatMinutes(c.minutes)} of your week — roughly ` +
      `${formatMinutes(c.minutes * 4.3)} a month. That is the first block worth handing off or batching into one sitting.`;
  } else if (split.reactive > split.deep && split.reactive >= 120) {
    body =
      `Reactive time (${formatMinutes(split.reactive)}) outweighed deep work (${formatMinutes(split.deep)}) this week. ` +
      `One protected morning of uninterrupted work would invert that ratio.`;
  } else if (prior.total >= 60 && pctOf(split.deep, week.totalMinutes) < pctOf(prior.deep, prior.total)) {
    body =
      `Deep-work share slipped versus last week. The calendar, not effort, is usually the cause — ` +
      `look at what interrupted the longest sessions in the Activity view.`;
  } else {
    body =
      `Deep work is carrying the week. Protect whatever produced the longest sessions — ` +
      `that is the asset.`;
  }

  el.innerHTML = `
    <div class="lev-move-card">
      <div class="lev-move-label">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        One leverage move
      </div>
      <div class="lev-move-body">${body}</div>
    </div>`;
}

/** Ranks byApp + bySite rows against the delegable-pattern list. */
function topDelegable(week) {
  const rows = [...(week.byApp || []), ...(week.bySite || [])]
    .filter((r) => (r.minutes || 0) >= 45 && DELEGABLE_RE.test(r.label || ''));
  rows.sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
  // De-dup app/site overlap by label.
  const seen = new Set();
  return rows.filter((r) => {
    const k = (r.label || '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function renderLevDelegation(week) {
  const el = document.getElementById('lev-delegation');
  if (!el) return;
  const candidates = topDelegable(week).slice(0, 3);
  if (candidates.length === 0) {
    el.innerHTML = '';
    return;
  }
  const cards = candidates
    .map(
      (c) => `
      <div class="lev-del-card">
        <div class="lev-del-name">${escapeHtml(c.label)}</div>
        <div class="lev-del-time">${formatMinutes(c.minutes)} this week</div>
        <div class="lev-del-month">≈ ${formatMinutes(c.minutes * 4.3)} a month</div>
      </div>`,
    )
    .join('');
  el.innerHTML = `
    <div class="lev-section-h">Worth a second look</div>
    <p class="lev-section-sub">Recurring time that rarely needs to be yours. Delegate it, batch it, or automate it.</p>
    <div class="lev-del-grid">${cards}</div>`;
}

// ------------------------------------------------------------------
// Privacy & health strip
// ------------------------------------------------------------------

let capturePaused = false;

async function loadHealth() {
  const strip = document.getElementById('health-strip');
  if (!strip) return;
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const h = await res.json();
    strip.hidden = false;
    capturePaused = !!h.paused;

    const capText = document.getElementById('hs-capture-text');
    const pauseBtn = document.getElementById('hs-pause-btn');
    if (capText) {
      if (h.paused) {
        capText.textContent = 'Capture paused';
        strip.classList.add('paused');
      } else {
        strip.classList.remove('paused');
        capText.textContent =
          h.minutesSinceChunk != null && h.minutesSinceChunk <= 35
            ? 'Capturing'
            : 'Capture idle';
      }
    }
    if (pauseBtn) {
      pauseBtn.hidden = false;
      pauseBtn.textContent = h.paused ? 'Resume' : 'Pause';
    }

    const wdText = document.getElementById('hs-watchdog-text');
    if (wdText) {
      if (h.watchdogLastRun) {
        const ageMin = Math.round((Date.now() - new Date(h.watchdogLastRun).getTime()) / 60_000);
        const heals = h.healsLast7d > 0 ? ` · ${h.healsLast7d} auto-repair${h.healsLast7d === 1 ? '' : 's'} this week` : '';
        wdText.textContent = ageMin <= 20 ? `Self-monitoring on${heals}` : `Self-monitoring last ran ${ageMin}m ago`;
      } else {
        wdText.textContent = 'Self-monitoring not installed';
      }
    }

    const retText = document.getElementById('hs-retention-text');
    if (retText && h.retention) {
      retText.textContent = `Video kept ${h.retention.videoDays} days · text ${h.retention.ocrDays} days`;
    }
  } catch {
    /* strip stays hidden on failure */
  }
}

async function toggleCapture() {
  const btn = document.getElementById('hs-pause-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = capturePaused ? 'Resuming…' : 'Pausing…';
  try {
    await fetch(`/api/capture/${capturePaused ? 'resume' : 'pause'}`, { method: 'POST' });
  } catch {
    /* reload below shows the real state either way */
  }
  await loadHealth();
  btn.disabled = false;
}

// ------------------------------------------------------------------
// OPERATOR_MODE gating — client installs hide operator-only panels
// ------------------------------------------------------------------

async function applyOperatorMode() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const s = await res.json();
    if (s.operatorMode === false) {
      document.querySelectorAll('[data-operator]').forEach((el) => el.remove());
    }
    const client = document.getElementById('brand-client');
    if (client && s.clientName) client.textContent = s.clientName;
  } catch {
    /* leave everything visible on failure — local dashboard, not a boundary */
  }
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

const hsPauseBtn = document.getElementById('hs-pause-btn');
if (hsPauseBtn) hsPauseBtn.addEventListener('click', toggleCapture);

applyOperatorMode();
loadHealth();
loadLeverage();
setInterval(loadHealth, 60_000);
