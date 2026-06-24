/**
 * ambient dashboard — vanilla JS, no build step.
 *
 * Responsibilities:
 *  - Tab switching
 *  - Fetching each API endpoint and rendering cards
 *  - Auto-refresh for activity and errors every 60 seconds when active
 *  - Status bar polling every 30 seconds
 */

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------

/** Currently visible tab name. Morning Coffee (the brief) is the home page. */
let activeTab = 'morning-coffee';

/** Per-tab auto-refresh interval IDs. Only activity + errors auto-refresh. */
const refreshIntervals = {
  activity: null,
  errors: null,
};

const AUTO_REFRESH_MS = 60_000;
const STATUS_REFRESH_MS = 30_000;

// ------------------------------------------------------------------
// Tab switching
// ------------------------------------------------------------------

/**
 * Activates a section by name. Used by the nav tabs AND the settings dropdown
 * (Errors lives under the gear menu, not the nav, so it has no nav button).
 */
function activateSection(targetTab) {
  if (!targetTab) return;

  // Update tab button styles (clears all; highlights one only if it's a nav tab)
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  const navBtn = document.querySelector(`.tab[data-tab="${targetTab}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Update visible section
  document.querySelectorAll('.tab-content').forEach((s) => s.classList.remove('active'));
  const section = document.getElementById(targetTab);
  if (section) section.classList.add('active');

  // The global Ask bar has no place over the full-page brief or the settings form.
  const askBar = document.getElementById('ask-bar');
  const askAnswer = document.getElementById('ask-answer');
  const hideAsk = targetTab === 'morning-coffee' || targetTab === 'settings-page';
  if (askBar) askBar.hidden = hideAsk;
  if (hideAsk && askAnswer) askAnswer.hidden = true;

  activeTab = targetTab;

  // Stop auto-refresh for tabs that don't use it, restart for those that do.
  stopAutoRefresh('activity');
  stopAutoRefresh('errors');

  loadTabData(targetTab);

  if (targetTab === 'activity') startAutoRefresh('activity', loadActivity);
  if (targetTab === 'errors') startAutoRefresh('errors', loadErrors);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => activateSection(tab.dataset.tab));
});

// ------------------------------------------------------------------
// Auto-refresh helpers
// ------------------------------------------------------------------

function startAutoRefresh(tab, loader) {
  stopAutoRefresh(tab);
  refreshIntervals[tab] = setInterval(loader, AUTO_REFRESH_MS);
}

function stopAutoRefresh(tab) {
  if (refreshIntervals[tab] !== null) {
    clearInterval(refreshIntervals[tab]);
    refreshIntervals[tab] = null;
  }
}

// ------------------------------------------------------------------
// Status bar
// ------------------------------------------------------------------

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    const tokenEl = document.getElementById('token-count');
    if (tokenEl) {
      const budget = (data.tokenBudget ?? 50000).toLocaleString();
      const used = (data.dailyTokens ?? 0).toLocaleString();
      tokenEl.textContent = `${used} / ${budget} tokens today`;
    }

    const pollEl = document.getElementById('last-poll');
    if (pollEl) {
      if (data.lastPoll) {
        const diffMs = Date.now() - new Date(data.lastPoll).getTime();
        const diffMin = Math.round(diffMs / 60_000);
        pollEl.textContent = `Last poll: ${diffMin}m ago`;
      } else {
        pollEl.textContent = 'Last poll: —';
      }
    }

    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    if (dot && statusText) {
      if (data.running) {
        dot.className = 'dot running';
        statusText.textContent = 'Running';
      } else {
        dot.className = 'dot stopped';
        statusText.textContent = 'Stopped';
      }
    }
  } catch {
    // Network error — don't update the UI, keep last known state.
  }
}

// ------------------------------------------------------------------
// Morning Coffee — the daily brief, embedded as the home page
// ------------------------------------------------------------------

async function loadMorningCoffee() {
  const frame = document.getElementById('brief-frame');
  const empty = document.getElementById('brief-empty');
  if (!frame || !empty) return;
  try {
    const res = await fetch('/api/brief/latest');
    const data = await res.json();
    if (res.ok && data.date) {
      // Only reset src if it changed, so switching tabs doesn't reload the brief.
      const src = `/morning-briefs/${data.date}.html`;
      if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
      frame.hidden = false;
      empty.hidden = true;
    } else {
      frame.hidden = true;
      empty.hidden = false;
    }
  } catch {
    frame.hidden = true;
    empty.hidden = false;
  }
}

// ------------------------------------------------------------------
// Activity tab
// ------------------------------------------------------------------

async function loadActivity() {
  const hoursSelect = document.getElementById('activity-hours');
  const hours = hoursSelect ? hoursSelect.value : '24';
  const container = document.getElementById('activity-list');
  if (!container) return;

  try {
    const res = await fetch(`/api/activity?hours=${encodeURIComponent(hours)}`);
    if (!res.ok) {
      container.innerHTML = renderError('Failed to load activity data.');
      return;
    }
    const sessions = await res.json();

    if (!Array.isArray(sessions) || sessions.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No activity recorded yet. Make sure the ambient daemon is running.</div>';
      return;
    }

    container.innerHTML = sessions.map(renderActivityCard).join('');
  } catch {
    container.innerHTML = renderError('Could not reach the daemon. Is it running?');
  }
}

function renderActivityCard(session) {
  const category = escapeHtml(session.category ?? 'other');
  const app = escapeHtml(session.primary_app ?? 'Unknown App');
  const summary = escapeHtml(session.summary ?? 'No summary available.');
  const time = formatTime(session.period_start);
  const duration = formatDuration(session.period_start, session.period_end);

  const appsList = parseJsonArray(session.apps_seen);
  const appsHtml =
    appsList && appsList.length > 0
      ? `<div class="card-footer">Apps: ${appsList.map(escapeHtml).join(', ')}</div>`
      : '';

  const durationHtml = duration
    ? `<span class="card-meta">${escapeHtml(duration)}</span>`
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <div class="card-header-left">
          <span class="card-title">${app}</span>
          <span class="badge badge-${escapeCssClass(category)}">${category}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${durationHtml}
          <span class="card-meta">${escapeHtml(time)}</span>
        </div>
      </div>
      <div class="card-body">${summary}</div>
      ${appsHtml}
    </div>
  `;
}

// ------------------------------------------------------------------
// Time tab — daily breakdown by category (tasks) and app (websites)
// ------------------------------------------------------------------

async function loadBreakdown() {
  const hoursSelect = document.getElementById('time-hours');
  const hours = hoursSelect ? hoursSelect.value : '24';
  const container = document.getElementById('time-breakdown');
  if (!container) return;

  container.innerHTML = 'Loading...';
  try {
    const res = await fetch(`/api/breakdown?hours=${encodeURIComponent(hours)}`);
    if (!res.ok) {
      container.innerHTML = renderError('Failed to load time breakdown.');
      return;
    }
    const data = await res.json();
    const total = data.totalMinutes || 0;
    if (total < 1) {
      container.innerHTML =
        '<div class="empty-state">No tracked activity in this window yet.</div>';
      return;
    }

    // Per-site rows come from Chrome history (a different source/measure), so
    // their percentages are relative to their own sum, not the activity total.
    const siteRows = Array.isArray(data.bySite) ? data.bySite : [];
    const siteTotal = siteRows.reduce((sum, r) => sum + (r.minutes || 0), 0);
    const siteGroup = renderBreakdownGroup('By website (Chrome)', siteRows, siteTotal);
    const siteCaption = siteGroup
      ? '<div class="breakdown-caption">Chrome active-tab time, each visit capped at 30 min — approximate.</div>'
      : '';

    container.innerHTML =
      `<div class="breakdown-total">${formatMinutes(total)} of tracked activity</div>` +
      renderBreakdownGroup('By task type', data.byCategory, total) +
      renderBreakdownGroup('By app', data.byApp, total) +
      siteGroup +
      siteCaption;
  } catch {
    container.innerHTML = renderError('Could not reach the daemon. Is it running?');
  }
}

function renderBreakdownGroup(title, rows, total) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const bars = rows
    .filter((r) => (r.minutes || 0) >= 1)
    .map((r) => {
      const pct = total > 0 ? Math.round((r.minutes / total) * 100) : 0;
      return `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(r.label)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="bar-value">${formatMinutes(r.minutes)} · ${pct}%</div>
        </div>`;
    })
    .join('');
  return `<div class="breakdown-group"><h3 class="breakdown-title">${escapeHtml(title)}</h3>${bars}</div>`;
}

/** Formats a count of minutes as "Xh Ym" / "Ym". */
function formatMinutes(mins) {
  const m = Math.round(mins || 0);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

// ------------------------------------------------------------------
// Knowledge tab
// ------------------------------------------------------------------

async function loadKnowledge() {
  const searchInput = document.getElementById('knowledge-search');
  const query = searchInput ? searchInput.value.trim() : '';
  const container = document.getElementById('knowledge-list');
  if (!container) return;

  const url = query
    ? `/api/knowledge?q=${encodeURIComponent(query)}&limit=20`
    : '/api/knowledge?limit=20';

  try {
    const res = await fetch(url);
    if (!res.ok) {
      container.innerHTML = renderError('Failed to load knowledge items.');
      return;
    }
    const items = await res.json();

    if (!Array.isArray(items) || items.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No knowledge items found.</div>';
      return;
    }

    container.innerHTML = items.map(renderKnowledgeCard).join('');
  } catch {
    container.innerHTML = renderError('Could not reach the daemon. Is it running?');
  }
}

function renderKnowledgeCard(item) {
  const category = escapeHtml(item.category ?? 'other');
  const content = escapeHtml(item.content ?? '');
  const time = formatTime(item.extracted_at);

  const sourceApps = parseJsonArray(item.source_apps);
  const appsHtml =
    sourceApps && sourceApps.length > 0
      ? `<div class="card-footer">Source: ${sourceApps.map(escapeHtml).join(', ')}</div>`
      : '';

  return `
    <div class="card">
      <div class="card-header">
        <span class="badge badge-${escapeCssClass(category)}">${category}</span>
        <span class="card-meta">${escapeHtml(time)}</span>
      </div>
      <div class="card-body">${content}</div>
      ${appsHtml}
    </div>
  `;
}

// ------------------------------------------------------------------
// Errors tab
// ------------------------------------------------------------------

async function loadErrors() {
  const container = document.getElementById('errors-list');
  if (!container) return;

  try {
    const res = await fetch('/api/errors');
    if (!res.ok) {
      container.innerHTML = renderError('Failed to load error events.');
      return;
    }
    const errors = await res.json();

    if (!Array.isArray(errors) || errors.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No unresolved errors. All clear.</div>';
      return;
    }

    container.innerHTML = errors.map(renderErrorCard).join('');
  } catch {
    container.innerHTML = renderError('Could not reach the daemon. Is it running?');
  }
}

function renderErrorCard(event) {
  const errorText = escapeHtml(event.error_text ?? '');
  const appName = escapeHtml(event.app_name ?? 'Unknown App');
  const firstSeen = formatTime(event.first_seen);
  const lastSeen = formatTime(event.last_seen);
  const count = event.occurrence_count ?? 1;
  const isResolved = event.resolved_at !== null;

  const resolvedHtml = isResolved
    ? `<span class="badge badge-completed">Resolved ${escapeHtml(formatTime(event.resolved_at))}</span>`
    : '<span class="badge badge-error">Unresolved</span>';

  return `
    <div class="card">
      <div class="card-header">
        <div class="card-header-left">
          <span class="card-title">${appName}</span>
          ${resolvedHtml}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="occurrence-badge">${count}x</span>
          <span class="card-meta">First: ${escapeHtml(firstSeen)}</span>
        </div>
      </div>
      <div class="error-text">${errorText}</div>
      <div class="card-footer" style="margin-top:8px;">
        Last seen: ${escapeHtml(lastSeen)}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------
// Goals tab
// ------------------------------------------------------------------

// The Goals tab is now a "Goals & Tracker": focus score, today's top 3,
// this week's focus, and outcome goals with on-track/at-risk/stalled status.

let goalOptionsCache = [];

const HEALTH_META = {
  aligned: { label: 'On track', cls: 'badge-active' },
  drifting: { label: 'At risk', cls: 'badge-paused' },
  neglected: { label: 'Stalled', cls: 'badge-error' },
};

async function loadGoals() {
  loadFocusScore();
  loadWeeklyFocus();
  await loadGoalsList(); // populates goalOptionsCache for the intention links
  loadIntentions();
}

async function loadGoalsList() {
  const container = document.getElementById('goals-list');
  if (!container) return;
  try {
    const res = await fetch('/api/goals/status');
    if (!res.ok) {
      container.innerHTML = renderError('Failed to load goals.');
      return;
    }
    const goals = await res.json();
    goalOptionsCache = Array.isArray(goals) ? goals.map((g) => ({ id: g.id, title: g.title })) : [];
    if (!Array.isArray(goals) || goals.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No goals yet. Add your first above — Ambient then tracks whether your time actually advances it.</div>';
      return;
    }
    container.innerHTML = goals.map(renderGoalCard).join('');
    container.querySelectorAll('.tier-toggle').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        // The star sits inside <summary>; don't let it open/close the dropdown.
        e.preventDefault();
        e.stopPropagation();
        const tier = btn.dataset.tier === '1' ? 2 : 1;
        await fetch(`/api/goals/${btn.dataset.goalId}/tier`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tier }),
        });
        loadGoalsList();
        loadFocusScore();
      });
    });
    container.querySelectorAll('.goal-done').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await fetch(`/api/goals/${btn.dataset.goalId}/complete`, { method: 'POST' });
        } catch {
          btn.disabled = false;
          return;
        }
        loadGoalsList();
        loadFocusScore();
      });
    });
    container.querySelectorAll('.goal-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this goal permanently? This cannot be undone.')) return;
        btn.disabled = true;
        try {
          await fetch(`/api/goals/${btn.dataset.goalId}`, { method: 'DELETE' });
        } catch {
          btn.disabled = false;
          return;
        }
        loadGoalsList();
        loadFocusScore();
      });
    });
  } catch {
    container.innerHTML = renderError('Could not reach the daemon. Is it running?');
  }
}

function renderGoalCard(goal) {
  const title = escapeHtml(goal.title ?? 'Untitled Goal');
  const description = goal.description
    ? `<div class="card-body" style="margin-top:8px;">${escapeHtml(goal.description)}</div>`
    : '';
  const h = HEALTH_META[goal.health] || HEALTH_META.aligned;
  const isTier1 = goal.tier === 1;
  const target = goal.target_date
    ? `<span class="card-meta">Target ${escapeHtml(formatDate(goal.target_date))}</span>`
    : '';
  const time = goal.minutes
    ? `<span class="card-meta">${formatMinutes(goal.minutes)} this week</span>`
    : '<span class="card-meta">no time logged</span>';
  const evidence = goal.lastEvidence
    ? `<div class="card-footer">Last: ${escapeHtml(goal.lastEvidence)}</div>`
    : '';
  // Collapsed by default (no `open`); summary stays glanceable, details expand.
  return `
    <details class="card goal-card">
      <summary class="goal-summary">
        <button class="tier-toggle ${isTier1 ? 'on' : ''}" data-goal-id="${escapeHtml(goal.id)}" data-tier="${isTier1 ? '1' : '2'}" title="Tier-1 counts toward your Focus Score">${isTier1 ? '★' : '☆'}</button>
        <span class="card-title">${title}</span>
        <span class="badge ${h.cls}">${h.label}</span>
      </summary>
      <div class="goal-body">
        <div class="goal-meta-row">${time}${target}</div>
        ${description}
        ${evidence}
        <div class="goal-actions">
          <button class="goal-done" data-goal-id="${escapeHtml(goal.id)}">✓ Done</button>
          <button class="goal-remove" data-goal-id="${escapeHtml(goal.id)}" title="Delete this goal permanently">✕ Remove</button>
        </div>
      </div>
    </details>`;
}

async function loadFocusScore() {
  const el = document.getElementById('focus-score');
  if (!el) return;
  try {
    const res = await fetch('/api/scorecard?days=7');
    const data = await res.json();
    const today = data.today;
    const pct = today ? Math.round((today.focus_score || 0) * 100) : 0;
    const trend = Array.isArray(data.trend) ? data.trend.slice().reverse() : [];
    const bars = trend
      .map((d) => {
        const p = Math.round((d.focus_score || 0) * 100);
        return `<span class="spark-bar" style="height:${Math.max(4, p)}%" title="${escapeHtml(d.date)}: ${p}%"></span>`;
      })
      .join('');
    const a = today ? today.aligned : 0;
    const dr = today ? today.drifting : 0;
    const n = today ? today.neglected : 0;
    el.innerHTML =
      `<div class="fs-main"><div class="fs-num">${pct}%</div><div class="fs-label">Focus Score<div class="fs-sub">Tier-1 time ÷ total tracked today</div></div></div>` +
      `<div class="fs-spark">${bars || '<span class="fs-sub">no history yet</span>'}</div>` +
      `<div class="fs-counts">` +
      `<span class="fs-stat"><i class="fs-dot ok"></i>${a} on track</span>` +
      `<span class="fs-stat"><i class="fs-dot warn"></i>${dr} at risk</span>` +
      `<span class="fs-stat"><i class="fs-dot bad"></i>${n} stalled</span>` +
      `</div>`;
  } catch {
    el.textContent = 'Focus score unavailable.';
  }
}

function intentionRow(item, idx) {
  const opts = ['<option value="">— link a goal —</option>']
    .concat(
      goalOptionsCache.map(
        (g) =>
          `<option value="${escapeHtml(g.id)}" ${item && item.goal_id === g.id ? 'selected' : ''}>${escapeHtml(g.title)}</option>`,
      ),
    )
    .join('');
  const row = document.createElement('div');
  row.className = 'intention-row';
  row.innerHTML =
    `<input type="checkbox" class="int-done" ${item && item.done ? 'checked' : ''} title="Done" />` +
    `<input type="text" class="int-text" placeholder="Priority ${idx + 1}" value="${item ? escapeHtml(item.text || '') : ''}" />` +
    `<select class="int-goal">${opts}</select>`;
  return row;
}

async function loadIntentions() {
  const wrap = document.getElementById('intentions-editor');
  if (!wrap) return;
  let items = [];
  let suggestions = [];
  try {
    const res = await fetch('/api/intentions');
    const data = await res.json();
    items = Array.isArray(data.items) ? data.items : [];
    suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
  } catch {
    /* ignore */
  }
  // When nothing's set yet, seed the rows with suggestions (yesterday's
  // unfinished + at-risk goals) so it's never a blank page.
  const seed = items.length
    ? items
    : suggestions.map((text) => ({ text, goal_id: null, done: false }));
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) wrap.appendChild(intentionRow(seed[i], i));
}

async function saveIntentions() {
  const wrap = document.getElementById('intentions-editor');
  const status = document.getElementById('intentions-status');
  if (!wrap) return;
  const items = [...wrap.querySelectorAll('.intention-row')]
    .map((r) => ({
      text: r.querySelector('.int-text').value.trim(),
      goal_id: r.querySelector('.int-goal').value || null,
      done: r.querySelector('.int-done').checked,
    }))
    .filter((x) => x.text);
  setMiniStatus(status, 'Saving…');
  try {
    const res = await fetch('/api/intentions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    setMiniStatus(status, res.ok ? 'Saved.' : 'Save failed.', !res.ok);
  } catch {
    setMiniStatus(status, 'Save failed.', true);
  }
}

async function loadWeeklyFocus() {
  const input = document.getElementById('weekly-focus-title');
  if (!input) return;
  try {
    const res = await fetch('/api/weekly-focus');
    const data = await res.json();
    input.value = data.title || '';
  } catch {
    /* ignore */
  }
}

async function saveWeeklyFocus() {
  const input = document.getElementById('weekly-focus-title');
  const status = document.getElementById('weekly-focus-status');
  if (!input) return;
  setMiniStatus(status, 'Saving…');
  try {
    const res = await fetch('/api/weekly-focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: input.value.trim(), notes: '', goal_ids: [] }),
    });
    setMiniStatus(status, res.ok ? 'Saved.' : 'Save failed.', !res.ok);
  } catch {
    setMiniStatus(status, 'Save failed.', true);
  }
}

function setMiniStatus(el, msg, isErr) {
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? 'var(--error)' : 'var(--success)';
}

// ------------------------------------------------------------------
// Tasks tab
// ------------------------------------------------------------------

// The Tasks tab is a hub: quick-add, an "Ambient noticed" suggestions inbox,
// date-grouped sections, inline edit, and goal-linked completion.

let taskGoalsCache = []; // {id, title} for the goal pickers
let taskMap = {}; // id -> task, from the last board render (for edit/undo)

async function loadTasks() {
  const board = document.getElementById('tasks-board');
  if (!board) return;
  board.textContent = 'Loading…';
  await loadTaskGoalOptions();
  try {
    const res = await fetch('/api/tasks/board');
    const data = await res.json();
    renderTaskBoard(data);
  } catch {
    board.textContent = 'Failed to load tasks.';
  }
}

async function loadTaskGoalOptions() {
  try {
    const res = await fetch('/api/goals/status');
    const goals = await res.json();
    taskGoalsCache = Array.isArray(goals) ? goals.map((g) => ({ id: g.id, title: g.title })) : [];
  } catch {
    taskGoalsCache = [];
  }
  const sel = document.getElementById('task-goal');
  if (sel) sel.innerHTML = '<option value="">No goal</option>' + goalOptionList(null);
}

function goalOptionList(selectedId) {
  return taskGoalsCache
    .map(
      (g) =>
        `<option value="${escapeHtml(g.id)}" ${g.id === selectedId ? 'selected' : ''}>${escapeHtml(g.title)}</option>`,
    )
    .join('');
}

function goalTitleFor(id) {
  const g = taskGoalsCache.find((x) => x.id === id);
  return g ? g.title : null;
}

function renderTaskBoard(d) {
  const board = document.getElementById('tasks-board');
  const counts = document.getElementById('task-counts');
  if (counts) {
    const c = d.counts || {};
    counts.textContent = `${c.open || 0} open · ${c.overdue || 0} overdue · ${c.doneToday || 0} done today`;
  }
  // Rebuild the lookup map for edit/undo.
  taskMap = {};
  [d.suggestions, d.overdue, d.today, d.upcoming, d.someday, d.doneToday].forEach((arr) => {
    (arr || []).forEach((t) => {
      taskMap[t.id] = t;
    });
  });

  let html = '';
  if (d.suggestions && d.suggestions.length) {
    html +=
      `<div class="task-section task-inbox"><h3 class="task-section-h">🔎 Ambient noticed <span class="task-count">${d.suggestions.length}</span></h3>` +
      d.suggestions.map(renderSuggestionRow).join('') +
      '</div>';
  }
  html += renderTaskSection('Overdue', d.overdue, 'overdue');
  html += renderTaskSection('Today', d.today, 'today');
  html += renderTaskSection('Upcoming', d.upcoming, 'upcoming');
  html += renderTaskSection('Someday', d.someday, 'someday');
  if (d.doneToday && d.doneToday.length) {
    html +=
      `<details class="task-section"><summary class="task-section-h">Done today <span class="task-count">${d.doneToday.length}</span></summary>` +
      d.doneToday.map(renderDoneRow).join('') +
      '</details>';
  }
  const openCount =
    (d.overdue || []).length + (d.today || []).length + (d.upcoming || []).length + (d.someday || []).length;
  if (openCount === 0 && (!d.suggestions || !d.suggestions.length)) {
    html += '<div class="empty-state">Nothing on your plate. Nice. ✨</div>';
  }
  board.innerHTML = html;
  wireTaskBoard(board);
}

function renderTaskSection(label, items, key) {
  if (!items || !items.length) return '';
  return (
    `<div class="task-section task-${key}"><h3 class="task-section-h">${label} <span class="task-count">${items.length}</span></h3>` +
    items.map(renderTaskRow).join('') +
    '</div>'
  );
}

function taskChips(t) {
  const due = t.due_date ? `<span class="task-chip">${escapeHtml(formatDate(t.due_date))}</span>` : '';
  const goalTitle = t.goal_id ? goalTitleFor(t.goal_id) : null;
  const goalChip = goalTitle ? `<span class="task-chip goal">🎯 ${escapeHtml(goalTitle)}</span>` : '';
  return due + goalChip;
}

function renderTaskRow(t) {
  return `
    <div class="task-row" data-id="${t.id}">
      <input type="checkbox" class="task-check" data-id="${t.id}" title="Mark done" />
      <span class="task-text" data-id="${t.id}">${escapeHtml(t.content)}</span>
      ${taskChips(t)}
      <button class="task-edit" data-id="${t.id}" title="Edit">✎</button>
      <button class="task-del" data-id="${t.id}" title="Delete">✕</button>
    </div>`;
}

function renderSuggestionRow(t) {
  return `
    <div class="task-row suggestion" data-id="${t.id}">
      <span class="task-text">${escapeHtml(t.content)}</span>
      ${taskChips(t)}
      <button class="sug-accept" data-id="${t.id}">Accept</button>
      <button class="sug-dismiss" data-id="${t.id}">Dismiss</button>
    </div>`;
}

function renderDoneRow(t) {
  return `
    <div class="task-row done" data-id="${t.id}">
      <span class="task-text struck">${escapeHtml(t.content)}</span>
      <button class="task-reopen" data-id="${t.id}">Reopen</button>
    </div>`;
}

function wireTaskBoard(board) {
  board.querySelectorAll('.task-check').forEach((box) => {
    box.addEventListener('change', async () => {
      const id = box.dataset.id;
      const row = box.closest('.task-row');
      if (row) row.classList.add('completing');
      try {
        await fetch(`/api/tasks/${id}/done`, { method: 'POST' });
      } catch {
        /* ignore */
      }
      showTaskToast('Completed ✓', 'Undo', async () => {
        await fetch(`/api/tasks/${id}/reopen`, { method: 'POST' });
        loadTasks();
      });
      loadTasks();
    });
  });
  board.querySelectorAll('.task-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const t = taskMap[id];
      try {
        await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      } catch {
        /* ignore */
      }
      showTaskToast('Deleted', 'Undo', async () => {
        if (t) {
          await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content: t.content,
              due_date: t.due_date || undefined,
              goal_id: t.goal_id || undefined,
            }),
          });
        }
        loadTasks();
      });
      loadTasks();
    });
  });
  board.querySelectorAll('.task-edit, .task-text[data-id]').forEach((el) => {
    el.addEventListener('click', () => startEditTask(el.dataset.id));
  });
  board.querySelectorAll('.sug-accept').forEach((btn) =>
    btn.addEventListener('click', () => taskActionThenReload(`/api/tasks/${btn.dataset.id}/accept`)),
  );
  board.querySelectorAll('.sug-dismiss').forEach((btn) =>
    btn.addEventListener('click', () => taskActionThenReload(`/api/tasks/${btn.dataset.id}/dismiss`)),
  );
  board.querySelectorAll('.task-reopen').forEach((btn) =>
    btn.addEventListener('click', () => taskActionThenReload(`/api/tasks/${btn.dataset.id}/reopen`)),
  );
}

async function taskActionThenReload(url) {
  try {
    await fetch(url, { method: 'POST' });
  } catch {
    /* ignore */
  }
  loadTasks();
}

function startEditTask(id) {
  const row = document.querySelector(`.task-row[data-id="${id}"]`);
  const t = taskMap[id];
  if (!row || !t) return;
  row.classList.add('editing');
  row.innerHTML = `
    <input type="text" class="edit-text" value="${escapeHtml(t.content)}" />
    <input type="date" class="edit-due" value="${t.due_date || ''}" />
    <select class="edit-goal"><option value="">No goal</option>${goalOptionList(t.goal_id)}</select>
    <button class="edit-save">Save</button>
    <button class="edit-cancel">Cancel</button>`;
  const text = row.querySelector('.edit-text');
  if (text) text.focus();
  row.querySelector('.edit-save').addEventListener('click', async () => {
    const content = row.querySelector('.edit-text').value.trim();
    if (!content) return;
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        due_date: row.querySelector('.edit-due').value,
        goal_id: row.querySelector('.edit-goal').value,
      }),
    });
    loadTasks();
  });
  row.querySelector('.edit-cancel').addEventListener('click', loadTasks);
}

let taskToastTimer = null;
function showTaskToast(msg, actionLabel, actionFn) {
  const el = document.getElementById('task-toast');
  if (!el) return;
  el.innerHTML =
    `<span>${escapeHtml(msg)}</span>` +
    (actionLabel ? `<button class="toast-action">${escapeHtml(actionLabel)}</button>` : '');
  el.hidden = false;
  const btn = el.querySelector('.toast-action');
  if (btn && actionFn) {
    btn.addEventListener('click', async () => {
      el.hidden = true;
      await actionFn();
    });
  }
  if (taskToastTimer) clearTimeout(taskToastTimer);
  taskToastTimer = setTimeout(() => {
    el.hidden = true;
  }, 6000);
}

async function addTask(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('task-input');
  const dueEl = document.getElementById('task-due');
  const goalEl = document.getElementById('task-goal');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  try {
    await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content,
        due_date: dueEl && dueEl.value ? dueEl.value : undefined,
        goal_id: goalEl && goalEl.value ? goalEl.value : undefined,
      }),
    });
    input.value = '';
    if (dueEl) dueEl.value = '';
    if (goalEl) goalEl.value = '';
    input.focus();
    loadTasks();
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------
// Ask tab — conversational memory Q&A
// ------------------------------------------------------------------

async function sendAsk() {
  const input = document.getElementById('ask-input');
  const answer = document.getElementById('ask-answer');
  const clearBtn = document.getElementById('ask-clear');
  if (!input || !answer) return;
  const question = input.value.trim();
  if (!question) return;
  answer.hidden = false;
  if (clearBtn) clearBtn.hidden = false;
  answer.textContent = 'Thinking…';
  try {
    const res = await fetch('/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    answer.textContent = res.ok ? data.answer : `Error: ${data.error || res.status}`;
  } catch (err) {
    answer.textContent = 'Request failed.';
  }
}

/** Hides the answer panel and resets the ask bar. */
function clearAsk() {
  const input = document.getElementById('ask-input');
  const answer = document.getElementById('ask-answer');
  const clearBtn = document.getElementById('ask-clear');
  if (answer) {
    answer.hidden = true;
    answer.textContent = '';
  }
  if (clearBtn) clearBtn.hidden = true;
  if (input) input.value = '';
}

// ------------------------------------------------------------------
// Goals — create a goal typed by the user
// ------------------------------------------------------------------

async function submitGoal(event) {
  event.preventDefault();
  const titleEl = document.getElementById('goal-title');
  const descEl = document.getElementById('goal-description');
  const targetEl = document.getElementById('goal-target');
  const tierEl = document.getElementById('goal-tier');
  const errorEl = document.getElementById('goal-form-error');
  if (!titleEl) return;

  const title = titleEl.value.trim();
  if (!title) return;
  if (errorEl) errorEl.hidden = true;

  try {
    const res = await fetch('/api/goals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        description: descEl ? descEl.value.trim() : '',
        target_date: targetEl ? targetEl.value : '',
        tier: tierEl && tierEl.checked ? 1 : 2,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (errorEl) {
        errorEl.textContent = data.error || 'Failed to add goal.';
        errorEl.hidden = false;
      }
      return;
    }
    titleEl.value = '';
    if (descEl) descEl.value = '';
    if (targetEl) targetEl.value = '';
    if (tierEl) tierEl.checked = false;
    const form = document.getElementById('goal-form');
    if (form) form.hidden = true; // re-collapse after adding
    loadGoalsList();
    loadFocusScore();
  } catch {
    if (errorEl) {
      errorEl.textContent = 'Request failed.';
      errorEl.hidden = false;
    }
  }
}

// ------------------------------------------------------------------
// Settings page — edit the morning-brief config profile
// ------------------------------------------------------------------

const SECTION_LABELS = {
  strategicCommand: 'Command Center',
  todaysSignal: "Today's Signal",
  overnight: 'While you slept',
  todaysFocus: "Today's Focus",
  intelligence: 'Intelligence (news / newsletters / competitors)',
  youtube: 'YouTube',
  closing: 'Closing (Vault + Inspiration)',
};
const RHYTHM_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const RHYTHM_STATUSES = ['pending', 'green', 'yellow', 'red', 'off'];

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function valOf(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}
function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v == null ? '' : v;
}
function setSettingsStatus(msg, isErr) {
  const el = document.getElementById('settings-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isErr ? 'var(--error)' : 'var(--success)';
}

async function loadSettings() {
  try {
    const res = await fetch('/api/brief-config');
    const cfg = await res.json();

    document.querySelectorAll('#settings-page [data-cc]').forEach((el) => {
      const v = getPath(cfg.commandCenter || {}, el.dataset.cc);
      el.value = v == null ? '' : v;
    });
    renderRhythm((cfg.commandCenter && cfg.commandCenter.weeklyRhythm) || {});
    renderListEditor(document.getElementById('youtubers-list'), cfg.youtubers || []);
    renderCompetitors(cfg.competitors || {});
    setVal('set-newsletterDocUrl', cfg.newsletterDocUrl);
    setVal('set-location', cfg.location);
    setVal('set-deliveryTime', cfg.deliveryTime);
    setVal('set-telegramNotifyTime', cfg.telegramNotifyTime);
    setVal('set-weeklyBudget', cfg.weeklyBudget);
    renderSectionToggles(cfg.sections || {});
    setSettingsStatus('');
  } catch {
    setSettingsStatus('Failed to load settings.', true);
  }
}

// ── list editor (rows of name + searchTerm) ──
function renderListEditor(container, items) {
  if (!container) return;
  container.innerHTML = '';
  (items || []).forEach((it) => container.appendChild(listRow(it.name, it.searchTerm)));
}
function listRow(name, searchTerm) {
  const row = document.createElement('div');
  row.className = 'list-row';
  row.innerHTML =
    `<input class="li-name" placeholder="Name" value="${escapeHtml(name || '')}" />` +
    `<input class="li-term" placeholder="Search term" value="${escapeHtml(searchTerm || '')}" />` +
    `<button type="button" class="li-remove" aria-label="Remove">×</button>`;
  row.querySelector('.li-remove').addEventListener('click', () => row.remove());
  return row;
}
function collectList(container) {
  if (!container) return [];
  return [...container.querySelectorAll('.list-row')]
    .map((r) => ({
      name: r.querySelector('.li-name').value.trim(),
      searchTerm: r.querySelector('.li-term').value.trim(),
    }))
    .filter((x) => x.name);
}

// ── competitors (categories of lists) ──
function renderCompetitors(comp) {
  const wrap = document.getElementById('competitors-groups');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.keys(comp || {}).forEach((cat) => wrap.appendChild(competitorCategory(cat, comp[cat])));
}
function competitorCategory(cat, items) {
  const box = document.createElement('div');
  box.className = 'competitor-cat';
  box.dataset.cat = cat;
  const head = document.createElement('div');
  head.className = 'competitor-cat-head';
  head.innerHTML = `<span>${escapeHtml(cat)}</span><button type="button" class="cat-remove">Remove</button>`;
  head.querySelector('.cat-remove').addEventListener('click', () => box.remove());
  const list = document.createElement('div');
  list.className = 'list-editor';
  (items || []).forEach((it) => list.appendChild(listRow(it.name, it.searchTerm)));
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'list-add';
  add.textContent = '+ Add competitor';
  add.addEventListener('click', () => list.appendChild(listRow('', '')));
  box.append(head, list, add);
  return box;
}
function collectCompetitors() {
  const wrap = document.getElementById('competitors-groups');
  const out = {};
  if (!wrap) return out;
  [...wrap.querySelectorAll('.competitor-cat')].forEach((box) => {
    out[box.dataset.cat] = collectList(box.querySelector('.list-editor'));
  });
  return out;
}

// ── weekly rhythm ──
function renderRhythm(rhythm) {
  const wrap = document.getElementById('rhythm-editor');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.dataset.weekStartDate = (rhythm && rhythm.weekStartDate) || '';
  const days = (rhythm && rhythm.days) || {};
  RHYTHM_DAYS.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'rhythm-row';
    row.dataset.day = d;
    const task = (days[d] && days[d].task) || '';
    const status = (days[d] && days[d].status) || 'pending';
    row.innerHTML =
      `<span class="rhythm-day">${d}</span>` +
      `<input class="rhythm-task" value="${escapeHtml(task)}" placeholder="Task" />` +
      `<select class="rhythm-status">${RHYTHM_STATUSES.map((s) => `<option ${s === status ? 'selected' : ''}>${s}</option>`).join('')}</select>`;
    wrap.appendChild(row);
  });
}
function collectRhythm() {
  const wrap = document.getElementById('rhythm-editor');
  const days = {};
  if (wrap) {
    [...wrap.querySelectorAll('.rhythm-row')].forEach((r) => {
      days[r.dataset.day] = {
        task: r.querySelector('.rhythm-task').value.trim(),
        status: r.querySelector('.rhythm-status').value,
      };
    });
  }
  return { weekStartDate: (wrap && wrap.dataset.weekStartDate) || '', days };
}

// ── section toggles ──
function renderSectionToggles(sections) {
  const wrap = document.getElementById('sections-toggles');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.keys(SECTION_LABELS).forEach((key) => {
    const on = sections[key] !== false;
    const label = document.createElement('label');
    label.className = 'toggle';
    label.innerHTML = `<input type="checkbox" data-section="${key}" ${on ? 'checked' : ''} /> ${escapeHtml(SECTION_LABELS[key])}`;
    wrap.appendChild(label);
  });
}
function collectSections() {
  const out = {};
  document.querySelectorAll('#sections-toggles [data-section]').forEach((el) => {
    out[el.dataset.section] = el.checked;
  });
  return out;
}

// ── gather + persist ──
function collectSettings() {
  const commandCenter = {};
  document.querySelectorAll('#settings-page [data-cc]').forEach((el) => {
    const [grp, field] = el.dataset.cc.split('.');
    commandCenter[grp] = commandCenter[grp] || {};
    let v = el.value;
    if (el.type === 'number') v = v === '' ? 0 : Number(v);
    commandCenter[grp][field] = v;
  });
  commandCenter.weeklyRhythm = collectRhythm();
  return {
    commandCenter,
    youtubers: collectList(document.getElementById('youtubers-list')),
    competitors: collectCompetitors(),
    newsletterDocUrl: valOf('set-newsletterDocUrl'),
    location: valOf('set-location'),
    deliveryTime: valOf('set-deliveryTime'),
    telegramNotifyTime: valOf('set-telegramNotifyTime'),
    weeklyBudget: Number(valOf('set-weeklyBudget') || 0),
    sections: collectSections(),
  };
}

async function postSettings() {
  const res = await fetch('/api/brief-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(collectSettings()),
  });
  return res.ok;
}

async function saveSettings() {
  setSettingsStatus('Saving…');
  try {
    setSettingsStatus(
      (await postSettings()) ? 'Saved — applies on the next brief generation.' : 'Save failed.',
      false,
    );
  } catch {
    setSettingsStatus('Save failed.', true);
  }
}

async function applySettings() {
  setSettingsStatus('Saving + re-rendering…');
  try {
    if (!(await postSettings())) {
      setSettingsStatus('Save failed.', true);
      return;
    }
    const res = await fetch('/api/brief/rerender', { method: 'POST' });
    if (res.ok) {
      setSettingsStatus('Applied — open Morning Coffee to see it.');
    } else {
      const e = await res.json().catch(() => ({}));
      setSettingsStatus(e.error || 'Re-render failed.', true);
    }
  } catch {
    setSettingsStatus('Apply failed.', true);
  }
}

// ------------------------------------------------------------------
// Router — decide which loader to call per tab
// ------------------------------------------------------------------

function loadTabData(tab) {
  switch (tab) {
    case 'morning-coffee':
      loadMorningCoffee();
      break;
    case 'settings-page':
      loadSettings();
      break;
    case 'activity':
      loadActivity();
      break;
    case 'time':
      loadBreakdown();
      break;
    case 'knowledge':
      loadKnowledge();
      break;
    case 'tasks':
      loadTasks();
      break;
    case 'errors':
      loadErrors();
      break;
    case 'goals':
      loadGoals();
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------
// Event listeners — controls within tabs
// ------------------------------------------------------------------

// Activity hours selector
const activityHoursSelect = document.getElementById('activity-hours');
if (activityHoursSelect) {
  activityHoursSelect.addEventListener('change', loadActivity);
}

// Knowledge search with 300 ms debounce
let searchTimeout = null;
const knowledgeSearch = document.getElementById('knowledge-search');
if (knowledgeSearch) {
  knowledgeSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(loadKnowledge, 300);
  });
}

// Tasks quick-add form
const taskAddForm = document.getElementById('task-add');
if (taskAddForm) {
  taskAddForm.addEventListener('submit', addTask);
}

// Time breakdown hours selector
const timeHoursSelect = document.getElementById('time-hours');
if (timeHoursSelect) {
  timeHoursSelect.addEventListener('change', loadBreakdown);
}

// Goal creation form — the "+ Add goal" button toggles it open.
const goalAddToggle = document.getElementById('goal-add-toggle');
if (goalAddToggle) {
  goalAddToggle.addEventListener('click', () => {
    const form = document.getElementById('goal-form');
    if (!form) return;
    form.hidden = !form.hidden;
    if (!form.hidden) {
      const title = document.getElementById('goal-title');
      if (title) title.focus();
    }
  });
}

const goalForm = document.getElementById('goal-form');
if (goalForm) {
  goalForm.addEventListener('submit', submitGoal);
}

// Goals & Tracker — save intentions / weekly focus
const intentionsSaveBtn = document.getElementById('intentions-save');
if (intentionsSaveBtn) intentionsSaveBtn.addEventListener('click', saveIntentions);
const weeklyFocusSaveBtn = document.getElementById('weekly-focus-save');
if (weeklyFocusSaveBtn) weeklyFocusSaveBtn.addEventListener('click', saveWeeklyFocus);

// Settings page — save / apply / add-row controls
const settingsSaveBtn = document.getElementById('settings-save');
if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', saveSettings);
const settingsApplyBtn = document.getElementById('settings-apply');
if (settingsApplyBtn) settingsApplyBtn.addEventListener('click', applySettings);
const addYoutuberBtn = document.querySelector('[data-add-youtuber]');
if (addYoutuberBtn) {
  addYoutuberBtn.addEventListener('click', () => {
    const list = document.getElementById('youtubers-list');
    if (list) list.appendChild(listRow('', ''));
  });
}
const addCatBtn = document.getElementById('add-competitor-cat');
if (addCatBtn) {
  addCatBtn.addEventListener('click', () => {
    const inp = document.getElementById('new-competitor-cat');
    const cat = inp ? inp.value.trim() : '';
    const wrap = document.getElementById('competitors-groups');
    if (!cat || !wrap) return;
    wrap.appendChild(competitorCategory(cat, []));
    if (inp) inp.value = '';
  });
}

// Settings gear dropdown (top-right). Holds Errors + Log out.
const settingsGear = document.getElementById('settings-gear');
const settingsMenu = document.getElementById('settings-menu');
const settingsNote = document.getElementById('settings-note');

function closeSettingsMenu() {
  if (!settingsMenu || !settingsGear) return;
  settingsMenu.hidden = true;
  settingsGear.setAttribute('aria-expanded', 'false');
  if (settingsNote) settingsNote.hidden = true;
}

if (settingsGear && settingsMenu) {
  settingsGear.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = settingsMenu.hidden;
    settingsMenu.hidden = !willOpen;
    settingsGear.setAttribute('aria-expanded', String(willOpen));
    if (!willOpen && settingsNote) settingsNote.hidden = true;
  });

  // Close on outside click or Escape.
  document.addEventListener('click', (e) => {
    if (!settingsMenu.hidden && !(e.target.closest && e.target.closest('#settings'))) {
      closeSettingsMenu();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettingsMenu();
  });

  document.querySelectorAll('.settings-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      if (action === 'settings') {
        activateSection('settings-page');
        closeSettingsMenu();
      } else if (action === 'errors') {
        activateSection('errors');
        closeSettingsMenu();
      } else if (action === 'logout') {
        // Placeholder — the local dashboard has no session to end. Wires to a
        // real /logout when Ambient accounts exist.
        if (settingsNote) {
          settingsNote.textContent = 'No session to end yet — sign-in arrives with Ambient accounts.';
          settingsNote.hidden = false;
        }
      }
    });
  });
}

// Ask: button click + Enter key + clear (global bar, present on every tab)
const askSend = document.getElementById('ask-send');
if (askSend) {
  askSend.addEventListener('click', sendAsk);
}
const askClear = document.getElementById('ask-clear');
if (askClear) {
  askClear.addEventListener('click', clearAsk);
}
const askInput = document.getElementById('ask-input');
if (askInput) {
  askInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendAsk();
  });
}

// ------------------------------------------------------------------
// Helper utilities
// ------------------------------------------------------------------

/**
 * Returns a human-readable relative time string for an ISO timestamp.
 * Falls back to a locale date string for timestamps older than 48 hours.
 */
function formatTime(iso) {
  if (!iso) return '—';
  let d;
  try {
    d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
  } catch {
    return iso;
  }

  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 172_800_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Formats an ISO date string as a locale date (no time component).
 */
function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Computes a human-readable duration between two ISO timestamps.
 * Returns null when either value is missing or invalid.
 */
function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return null;
  try {
    const start = new Date(startIso).getTime();
    const end = new Date(endIso).getTime();
    if (isNaN(start) || isNaN(end)) return null;
    const diffMin = Math.round((end - start) / 60_000);
    if (diffMin < 1) return null;
    if (diffMin < 60) return `${diffMin}m`;
    const hours = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  } catch {
    return null;
  }
}

/**
 * Safely parses a JSON array value from the store.
 * Returns null on any parse failure.
 */
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Escapes a string for safe insertion into HTML content.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whitelists a category string for use in CSS class names.
 * Only allows known categories; falls back to 'other'.
 */
function escapeCssClass(category) {
  const allowed = ['coding', 'browsing', 'other', 'error', 'decision', 'learning', 'active', 'completed', 'paused'];
  const normalized = (category ?? '').toLowerCase();
  return allowed.includes(normalized) ? normalized : 'other';
}

/**
 * Returns an error card HTML string for API failures.
 */
function renderError(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

// ------------------------------------------------------------------
// Boot sequence
// ------------------------------------------------------------------

// Load initial data — Morning Coffee is the default home page.
loadStatus();
loadMorningCoffee();

// The Ask bar is hidden on the default (Morning Coffee) page; it shows on others.
const initialAskBar = document.getElementById('ask-bar');
if (initialAskBar) initialAskBar.hidden = true;

// Status refreshes every 30 seconds regardless of active tab
setInterval(loadStatus, STATUS_REFRESH_MS);

// Activity auto-refresh starts only when its tab is opened (via activateSection).
