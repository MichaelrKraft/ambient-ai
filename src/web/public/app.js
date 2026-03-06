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

/** Currently visible tab name. */
let activeTab = 'activity';

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

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const targetTab = tab.dataset.tab;
    if (!targetTab) return;

    // Update tab button styles
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');

    // Update visible section
    document.querySelectorAll('.tab-content').forEach((s) => s.classList.remove('active'));
    const section = document.getElementById(targetTab);
    if (section) section.classList.add('active');

    activeTab = targetTab;

    // Stop auto-refresh for tabs that don't use it, restart for those that do.
    stopAutoRefresh('activity');
    stopAutoRefresh('errors');

    loadTabData(targetTab);

    if (targetTab === 'activity') startAutoRefresh('activity', loadActivity);
    if (targetTab === 'errors') startAutoRefresh('errors', loadErrors);
  });
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

async function loadGoals() {
  const container = document.getElementById('goals-list');
  if (!container) return;

  try {
    const res = await fetch('/api/goals');
    if (!res.ok) {
      container.innerHTML = renderError('Failed to load goals.');
      return;
    }
    const goals = await res.json();

    if (!Array.isArray(goals) || goals.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No active goals. Add goals via the config file.</div>';
      return;
    }

    container.innerHTML = goals.map(renderGoalCard).join('');
  } catch {
    container.innerHTML = renderError('Could not reach the daemon. Is it running?');
  }
}

function renderGoalCard(goal) {
  const title = escapeHtml(goal.title ?? 'Untitled Goal');
  const description = goal.description ? escapeHtml(goal.description) : null;
  const status = escapeHtml(goal.status ?? 'active');
  const createdAt = formatTime(goal.created_at);

  const descriptionHtml = description
    ? `<div class="card-body" style="margin-top:8px;">${description}</div>`
    : '';

  const targetDateHtml = goal.target_date
    ? `<div class="target-date">Target: ${escapeHtml(formatDate(goal.target_date))}</div>`
    : '';

  return `
    <div class="card">
      <div class="card-header">
        <div class="card-header-left">
          <span class="card-title">${title}</span>
          <span class="badge badge-${escapeCssClass(status)}">${status}</span>
        </div>
        <span class="card-meta">${escapeHtml(createdAt)}</span>
      </div>
      ${descriptionHtml}
      ${targetDateHtml}
    </div>
  `;
}

// ------------------------------------------------------------------
// Router — decide which loader to call per tab
// ------------------------------------------------------------------

function loadTabData(tab) {
  switch (tab) {
    case 'activity':
      loadActivity();
      break;
    case 'knowledge':
      loadKnowledge();
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

// Load initial data
loadStatus();
loadActivity();

// Status refreshes every 30 seconds regardless of active tab
setInterval(loadStatus, STATUS_REFRESH_MS);

// Activity auto-refreshes every 60 seconds when its tab is active (default tab)
startAutoRefresh('activity', loadActivity);
