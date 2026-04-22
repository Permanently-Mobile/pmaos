/**
 * Dashboard HTML -- Grafana-style customizable tile system.
 * 22 tiles across 5 categories: Usage, Agents, Network, Vault, Trading.
 * Layout persists to localStorage. Edit mode for repositioning.
 * Chart.js for cost/memory time series. Auto-refresh with configurable interval.
 */

export function getDashboardHtml(chatId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>PMAOS</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3.1.0/dist/chartjs-plugin-annotation.min.js"><\/script>
<style>
/* ══════════════════════════════════════════════════
   DESIGN TOKENS (Grafana Dark)
   ══════════════════════════════════════════════════ */
:root {
  --g-bg:          #111217;
  --g-panel:       #181b1f;
  --g-panel-hover: #1e2127;
  --g-surface:     #2c2f36;
  --g-border:      #2c2f36;
  --g-border-hover:#3d3f46;
  --g-divider:     #222530;
  --g-text:        #d8d9da;
  --g-muted:       #8e8e8e;
  --g-dim:         #5a5a5a;
  --g-white:       #ffffff;
  --g-green:       #73BF69;
  --g-green-dim:   rgba(115,191,105,0.15);
  --g-yellow:      #FADE2A;
  --g-yellow-dim:  rgba(250,222,42,0.15);
  --g-red:         #F2495C;
  --g-red-dim:     rgba(242,73,92,0.15);
  --g-blue:        #5794F2;
  --g-blue-dim:    rgba(87,148,242,0.15);
  --g-purple:      #B877D9;
  --g-purple-dim:  rgba(184,119,217,0.15);
  --g-orange:      #FF9830;
  --g-panel-radius: 4px;
  --g-gap:         8px;
}

/* ── Base ── */
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--g-bg);
  color: var(--g-text);
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 13px;
  line-height: 1.4;
  -webkit-tap-highlight-color: transparent;
  overflow-y: auto;
}
.hidden { display: none !important; }

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--g-border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--g-border-hover); }

/* ══════════════════════════════════════════════════
   TOP BAR
   ══════════════════════════════════════════════════ */
.g-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--g-panel);
  border-bottom: 1px solid var(--g-border);
  position: sticky;
  top: 0;
  z-index: 200;
  gap: 16px;
}
.g-topbar-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--g-white);
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 8px;
}
.g-topbar-center {
  display: flex;
  align-items: center;
  gap: 4px;
}
.g-topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
}

/* Time range pills */
.g-tr-pill {
  padding: 3px 10px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  color: var(--g-muted);
  background: transparent;
  border: 1px solid transparent;
  transition: all 0.15s;
  user-select: none;
}
.g-tr-pill:hover { color: var(--g-text); background: var(--g-surface); }
.g-tr-pill.active {
  color: var(--g-white);
  background: var(--g-blue);
  border-color: var(--g-blue);
}

/* Auto-refresh select */
.g-refresh-select {
  background: var(--g-surface);
  color: var(--g-muted);
  border: 1px solid var(--g-border);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  cursor: pointer;
  outline: none;
}
.g-refresh-select:hover { border-color: var(--g-border-hover); }

/* Icon buttons */
.g-icon-btn {
  background: none;
  border: 1px solid transparent;
  color: var(--g-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 3px;
  display: flex;
  align-items: center;
  transition: all 0.15s;
}
.g-icon-btn:hover { color: var(--g-text); background: var(--g-surface); }
.g-icon-btn.active { color: var(--g-orange); border-color: var(--g-orange); }
.g-icon-btn svg { width: 16px; height: 16px; }

/* Status dot */
.g-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--g-green);
  animation: g-pulse 2s infinite;
}
.g-status-dot.error { background: var(--g-red); }
@keyframes g-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes g-spin { to { transform: rotate(360deg); } }
.g-spinning { animation: g-spin 1s linear infinite; }

/* Last updated */
.g-last-updated { font-size: 11px; color: var(--g-dim); }

/* ══════════════════════════════════════════════════
   TILE GRID
   ══════════════════════════════════════════════════ */
.g-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--g-gap);
  padding: var(--g-gap);
  min-height: calc(100vh - 50px);
  align-content: start;
}

/* ══════════════════════════════════════════════════
   TILE CHROME
   ══════════════════════════════════════════════════ */
.g-tile {
  background: var(--g-panel);
  border: 1px solid var(--g-border);
  border-radius: var(--g-panel-radius);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s;
  min-height: 0;
}
.g-tile:hover { border-color: var(--g-border-hover); }

.g-tile-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid var(--g-divider);
  min-height: 28px;
  flex-shrink: 0;
}
.g-tile-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--g-muted);
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.g-tile-body {
  padding: 12px;
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.g-tile-body.no-pad { padding: 0; }

/* ══════════════════════════════════════════════════
   STAT TILES
   ══════════════════════════════════════════════════ */
.g-stat-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--g-white);
  line-height: 1.1;
}
.g-stat-unit {
  font-size: 13px;
  font-weight: 400;
  color: var(--g-muted);
  margin-left: 3px;
}
.g-stat-sub {
  font-size: 11px;
  color: var(--g-muted);
  margin-top: 4px;
}
.g-stat-sparkline {
  height: 24px;
  width: 100%;
  margin-top: 8px;
}

/* Threshold colors */
.g-val-green { color: var(--g-green) !important; }
.g-val-yellow { color: var(--g-yellow) !important; }
.g-val-red { color: var(--g-red) !important; }

/* ══════════════════════════════════════════════════
   GAUGE (CSS semicircle)
   ══════════════════════════════════════════════════ */
.g-gauge-wrap {
  width: 100px;
  height: 50px;
  position: relative;
  overflow: hidden;
  margin: 0 auto;
}
.g-gauge-bg, .g-gauge-fill {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  position: absolute;
  top: 0;
  left: 0;
  border: 10px solid transparent;
}
.g-gauge-bg { border-top-color: var(--g-surface); border-left-color: var(--g-surface); transform: rotate(-45deg); }
.g-gauge-fill { border-top-color: var(--g-blue); border-left-color: var(--g-blue); transform: rotate(-45deg); clip-path: none; transition: transform 0.5s; }
.g-gauge-label {
  position: absolute;
  bottom: 2px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 18px;
  font-weight: 700;
  color: var(--g-white);
}

/* ══════════════════════════════════════════════════
   BUDGET GAUGE BARS
   ══════════════════════════════════════════════════ */
.g-budget-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.g-budget-row:last-child { margin-bottom: 0; }
.g-budget-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--g-muted);
  min-width: 65px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.g-budget-track {
  flex: 1;
  height: 6px;
  background: var(--g-surface);
  border-radius: 3px;
  overflow: hidden;
}
.g-budget-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}
.g-budget-fill.green { background: var(--g-green); }
.g-budget-fill.yellow { background: var(--g-yellow); }
.g-budget-fill.red { background: var(--g-red); }
.g-budget-pct {
  font-size: 11px;
  font-weight: 600;
  min-width: 32px;
  text-align: right;
}

/* ══════════════════════════════════════════════════
   STATUS MAP (Agent Health)
   ══════════════════════════════════════════════════ */
.g-status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 6px;
}
.g-status-tile {
  padding: 8px 10px;
  border-radius: 4px;
  text-align: center;
}
.g-status-tile.healthy { background: var(--g-green-dim); border: 1px solid rgba(115,191,105,0.3); }
.g-status-tile.degraded { background: var(--g-yellow-dim); border: 1px solid rgba(250,222,42,0.3); }
.g-status-tile.offline { background: var(--g-red-dim); border: 1px solid rgba(242,73,92,0.3); }
.g-status-tile.unknown { background: rgba(90,90,90,0.1); border: 1px solid rgba(90,90,90,0.2); }
.g-status-name { font-size: 12px; font-weight: 600; color: var(--g-white); }
.g-status-role { font-size: 10px; color: var(--g-muted); margin-top: 1px; }

/* ══════════════════════════════════════════════════
   LOG PANEL (Hive Mind / Firewall)
   ══════════════════════════════════════════════════ */
.g-log-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  border-bottom: 1px solid var(--g-divider);
}
.g-log-entry:last-child { border-bottom: none; }
.g-log-time { color: var(--g-dim); white-space: nowrap; min-width: 50px; font-size: 11px; }
.g-log-level { font-weight: 700; text-transform: uppercase; min-width: 65px; font-size: 11px; }
.g-log-level.claim    { color: var(--g-green); }
.g-log-level.complete { color: var(--g-purple); }
.g-log-level.fail     { color: var(--g-red); }
.g-log-level.dispatch { color: var(--g-yellow); }
.g-log-level.start    { color: var(--g-blue); }
.g-log-level.heartbeat { color: var(--g-dim); }
.g-log-agent { color: var(--g-blue); font-weight: 600; min-width: 65px; }
.g-log-msg { color: var(--g-text); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ══════════════════════════════════════════════════
   TABLE STYLES (Dispatch, Positions, Devices)
   ══════════════════════════════════════════════════ */
.g-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.g-table th {
  text-align: left;
  color: var(--g-muted);
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--g-border);
  position: sticky;
  top: 0;
  background: var(--g-panel);
}
.g-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--g-divider);
  vertical-align: middle;
}
.g-table tr:last-child td { border-bottom: none; }
.g-table tr:hover td { background: rgba(87,148,242,0.04); }

/* Stoplight dots */
.g-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.g-dot.online { background: var(--g-green); box-shadow: 0 0 6px rgba(115,191,105,0.4); }
.g-dot.working { background: var(--g-green); box-shadow: 0 0 6px rgba(115,191,105,0.4); }
.g-dot.queued { background: var(--g-yellow); box-shadow: 0 0 6px rgba(250,222,42,0.3); }
.g-dot.idle { background: var(--g-dim); }
.g-dot.offline { background: var(--g-red); box-shadow: 0 0 6px rgba(242,73,92,0.3); }
.g-dot.completed { background: var(--g-green); }
.g-dot.failed { background: var(--g-red); }
.g-dot.running { background: var(--g-yellow); animation: g-pulse 1s infinite; }

/* Badge */
.g-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 700;
  background: var(--g-blue-dim);
  color: var(--g-blue);
}
.g-badge.zero { background: transparent; color: var(--g-dim); }
.g-badge.pending { background: var(--g-yellow-dim); color: var(--g-yellow); }

/* Mono text for tasks/prompts */
.g-mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
}

/* ══════════════════════════════════════════════════
   TASK LIST (Vault)
   ══════════════════════════════════════════════════ */
.g-task-group { margin-bottom: 10px; }
.g-task-group:last-child { margin-bottom: 0; }
.g-task-group-header { font-size: 11px; font-weight: 600; color: var(--g-purple); margin-bottom: 4px; padding-left: 2px; }
.g-task-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 3px 4px;
  font-size: 12px;
  color: var(--g-text);
  border-radius: 3px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.g-task-item:hover { background: var(--g-blue-dim); }
.g-task-check { color: var(--g-dim); flex-shrink: 0; }
.g-task-done .g-task-text { text-decoration: line-through; color: var(--g-dim); }
.g-task-done .g-task-check { color: var(--g-green); }

/* ══════════════════════════════════════════════════
   PROGRESS BARS (Projects)
   ══════════════════════════════════════════════════ */
.g-prog-track {
  height: 4px;
  background: var(--g-surface);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 4px;
}
.g-prog-fill {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--g-blue), var(--g-purple));
  transition: width 0.3s;
}

/* ══════════════════════════════════════════════════
   TRADING
   ══════════════════════════════════════════════════ */
.g-pill {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 3px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--g-border);
  color: var(--g-muted);
  background: transparent;
  transition: all 0.15s;
  user-select: none;
}
.g-pill:hover { border-color: var(--g-border-hover); color: var(--g-text); }
.g-pill.active { background: var(--g-blue); color: var(--g-white); border-color: var(--g-blue); }
.g-ind-card {
  background: var(--g-bg);
  border: 1px solid var(--g-border);
  border-radius: 4px;
  padding: 8px 12px;
  min-width: 80px;
}
.g-ind-label { font-size: 10px; color: var(--g-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
.g-ind-val { font-size: 13px; font-weight: 700; }
.g-bull { color: var(--g-green); }
.g-bear { color: var(--g-red); }
.g-neutral { color: var(--g-muted); }

/* Eye toggle */
.g-eye-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--g-muted);
  padding: 2px;
  transition: color 0.15s;
}
.g-eye-btn:hover { color: var(--g-white); }
.g-eye-btn svg { width: 16px; height: 16px; }

/* ══════════════════════════════════════════════════
   EDIT MODE
   ══════════════════════════════════════════════════ */
.g-edit-mode .g-tile {
  border-style: dashed;
  border-color: var(--g-orange);
}
.g-tile-controls {
  display: none;
  gap: 2px;
  align-items: center;
}
.g-edit-mode .g-tile-controls { display: flex; }
.g-tile-ctrl {
  background: none;
  border: none;
  color: var(--g-dim);
  cursor: pointer;
  padding: 2px;
  font-size: 14px;
  line-height: 1;
  border-radius: 2px;
  transition: all 0.1s;
}
.g-tile-ctrl:hover { color: var(--g-orange); background: var(--g-surface); }
.g-tile-ctrl.remove:hover { color: var(--g-red); }

/* Add tile button */
.g-add-tile {
  border: 2px dashed var(--g-border);
  border-radius: var(--g-panel-radius);
  display: none;
  align-items: center;
  justify-content: center;
  min-height: 80px;
  cursor: pointer;
  color: var(--g-dim);
  font-size: 12px;
  transition: all 0.15s;
}
.g-edit-mode .g-add-tile { display: flex; }
.g-add-tile:hover { border-color: var(--g-orange); color: var(--g-orange); }

/* Reset layout button */
.g-reset-btn {
  display: none;
  padding: 4px 10px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  background: var(--g-red-dim);
  color: var(--g-red);
  border: 1px solid rgba(242,73,92,0.3);
  transition: all 0.15s;
}
.g-edit-mode .g-reset-btn { display: inline-flex; }
.g-reset-btn:hover { background: var(--g-red); color: var(--g-white); }

/* Add tile dropdown */
.g-add-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--g-surface);
  border: 1px solid var(--g-border);
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  z-index: 300;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
.g-add-option {
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--g-text);
  border-bottom: 1px solid var(--g-divider);
}
.g-add-option:last-child { border-bottom: none; }
.g-add-option:hover { background: var(--g-blue-dim); }
.g-add-option .cat { font-size: 10px; color: var(--g-dim); text-transform: uppercase; }

/* ══════════════════════════════════════════════════
   LOADING SKELETON
   ══════════════════════════════════════════════════ */
.g-skeleton {
  background: linear-gradient(90deg, var(--g-surface) 25%, var(--g-border) 50%, var(--g-surface) 75%);
  background-size: 200% 100%;
  animation: g-shimmer 1.5s infinite;
  border-radius: 3px;
}
@keyframes g-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.g-skel-line { height: 12px; margin-bottom: 8px; }
.g-skel-line:last-child { margin-bottom: 0; width: 60%; }
.g-skel-stat { height: 28px; width: 80px; margin-bottom: 4px; }
.g-skel-bar { height: 6px; margin-top: 8px; }

/* ══════════════════════════════════════════════════
   RESPONSIVE
   ══════════════════════════════════════════════════ */
@media (max-width: 1200px) {
  .g-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 768px) {
  .g-grid { grid-template-columns: 1fr; }
  .g-topbar { flex-wrap: wrap; gap: 8px; }
  .g-topbar-center { order: 3; width: 100%; justify-content: center; }
}
</style>
</head>
<body>

<!-- ══════════════════════════════════════════════════
     TOP BAR
     ══════════════════════════════════════════════════ -->
<div class="g-topbar">
  <div class="g-topbar-title">
    <span>PMAOS</span>
    <span class="g-status-dot" id="statusDot"></span>
  </div>
  <div class="g-topbar-center">
    <span class="g-tr-pill" data-range="1h">1h</span>
    <span class="g-tr-pill" data-range="6h">6h</span>
    <span class="g-tr-pill active" data-range="24h">24h</span>
    <span class="g-tr-pill" data-range="7d">7d</span>
    <span class="g-tr-pill" data-range="30d">30d</span>
  </div>
  <div class="g-topbar-right">
    <button class="g-icon-btn" id="maxToggle" title="Toggle MAX plan view" style="font-size:10px;font-weight:700;padding:2px 6px;letter-spacing:0.5px;">MAX</button>
    <select class="g-refresh-select" id="refreshSelect" title="Auto-refresh interval">
      <option value="0">Off</option>
      <option value="5000">5s</option>
      <option value="10000">10s</option>
      <option value="30000" selected>30s</option>
      <option value="60000">1m</option>
      <option value="300000">5m</option>
    </select>
    <button class="g-reset-btn" id="resetBtn" onclick="resetLayout()" title="Reset to default layout">Reset Layout</button>
    <button class="g-icon-btn" id="editToggle" title="Edit layout">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    </button>
    <button class="g-icon-btn" id="refreshBtn" onclick="doRefresh()" title="Refresh now">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
    </button>
    <span class="g-last-updated" id="lastUpdated">--</span>
  </div>
</div>

<!-- ══════════════════════════════════════════════════
     TILE GRID
     ══════════════════════════════════════════════════ -->
<div class="g-grid" id="tileGrid"></div>

<script>
/* ══════════════════════════════════════════════════
   CONFIG
   ══════════════════════════════════════════════════ */
var CHAT_ID = ${JSON.stringify(chatId)};
var BASE = location.origin;
var TRADE_BASE = location.origin + '/trading';

/* MAX plan toggle -- persists in localStorage */
var isMaxPlan = localStorage.getItem('apex-max-plan') === 'true';
var maxBtn = document.getElementById('maxToggle');
function updateMaxBtn() {
  if (isMaxPlan) {
    maxBtn.style.background = 'var(--g-green)';
    maxBtn.style.color = 'var(--g-bg)';
  } else {
    maxBtn.style.background = 'var(--g-surface)';
    maxBtn.style.color = 'var(--g-muted)';
  }
}
updateMaxBtn();
maxBtn.addEventListener('click', function() {
  isMaxPlan = !isMaxPlan;
  localStorage.setItem('apex-max-plan', isMaxPlan ? 'true' : 'false');
  updateMaxBtn();
  doRefresh();
});

/* ══════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════ */
function api(path) { return fetch(BASE + path, { credentials: 'same-origin' }).then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); }).catch(function(e) { console.warn('API error:', path, e); return {}; }); }
function tradeApi(path) { return fetch(TRADE_BASE + path, { credentials: 'same-origin' }).then(function(r) { if (!r.ok) throw new Error(r.status); return r.json(); }).catch(function(e) { console.warn('Trade API error:', path, e); return {}; }); }
function esc(s) { if (!s) return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function timeAgo(ts) {
  if (!ts) return '--';
  var d = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
  var diff = Math.floor((Date.now() - d) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
function timeUntil(ts) {
  if (!ts) return '--';
  var d = typeof ts === 'number' ? ts * 1000 : new Date(ts).getTime();
  var diff = Math.floor((d - Date.now()) / 1000);
  if (diff < 0) return 'overdue';
  if (diff < 60) return diff + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ' + Math.floor((diff % 3600) / 60) + 'm';
  return Math.floor(diff / 86400) + 'd';
}
function formatMem(b) { return b ? (b / 1048576).toFixed(0) + ' MB' : '--'; }
function formatUptime(ms) {
  if (!ms) return '--';
  var s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
function usageColor(pct) { return pct < 50 ? 'green' : pct < 80 ? 'yellow' : 'red'; }
function formatPrice(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toFixed(6);
}
function skeleton(lines) {
  var h = '';
  for (var i = 0; i < (lines || 3); i++) h += '<div class="g-skeleton g-skel-line"></div>';
  return h;
}
function skelStat() { return '<div class="g-skeleton g-skel-stat"></div><div class="g-skeleton g-skel-line" style="width:50%"></div>'; }

/* ══════════════════════════════════════════════════
   TIME RANGE STATE
   ══════════════════════════════════════════════════ */
var currentRange = '24h';
var RANGES = { '1h': { hours: 1 }, '6h': { hours: 6 }, '24h': { days: 1 }, '7d': { days: 7 }, '30d': { days: 30 } };

document.querySelectorAll('.g-tr-pill').forEach(function(p) {
  p.addEventListener('click', function() {
    currentRange = p.dataset.range;
    document.querySelectorAll('.g-tr-pill').forEach(function(x) { x.classList.toggle('active', x.dataset.range === currentRange); });
    refreshTimeSeries();
  });
});

function getRangeParam() { return 'range=' + currentRange; }

/* ══════════════════════════════════════════════════
   AUTO-REFRESH
   ══════════════════════════════════════════════════ */
var refreshTimer = null;
document.getElementById('refreshSelect').addEventListener('change', function() {
  if (refreshTimer) clearInterval(refreshTimer);
  var ms = parseInt(this.value, 10);
  if (ms > 0) refreshTimer = setInterval(doRefresh, ms);
});
// Start default 30s
refreshTimer = setInterval(doRefresh, 30000);

/* ══════════════════════════════════════════════════
   CHART.JS GLOBAL CONFIG
   ══════════════════════════════════════════════════ */
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = '#8e8e8e';
  Chart.defaults.borderColor = 'rgba(44,47,54,0.5)';
  Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1a1226';
  Chart.defaults.plugins.tooltip.titleColor = '#fafafa';
  Chart.defaults.plugins.tooltip.bodyColor = '#8e8e8e';
  Chart.defaults.plugins.tooltip.borderColor = '#2c2f36';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.cornerRadius = 4;
  Chart.defaults.plugins.tooltip.padding = 8;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 4;
  Chart.defaults.elements.line.tension = 0.3;
  Chart.defaults.scale.grid = { color: 'rgba(44,47,54,0.5)' };
}
var charts = {};

/* ══════════════════════════════════════════════════
   TILE REGISTRY
   ══════════════════════════════════════════════════ */
var AGENT_META = {
  'researcher-1': { label: 'Researcher 1', role: 'Research' }, 'researcher-2': { label: 'Researcher 2', role: 'Research' },
  'coder-1': { label: 'Coder 1', role: 'Code Dev' }, 'coder-2': { label: 'Coder 2', role: 'Code Dev' }, 'coder-3': { label: 'Coder 3', role: 'Code Dev' },
  'processor-1': { label: 'Processor 1', role: 'Note-Taker' }, 'creative-1': { label: 'Creative 1', role: 'Builder' },
  'audit-1': { label: 'Audit-1', role: 'Audit' }, 'network-1': { label: 'Network-1', role: 'Network Mon.' },
  'trader-1': { label: 'Trader-1', role: 'Trader 1x' }, 'trader-2': { label: 'Trader-2', role: 'Trader 3x' }
};

var TILES = {};
var tileState = {}; /* runtime state per tile (chart instances, cached data, etc) */

function regTile(id, def) {
  TILES[id] = Object.assign({ id: id, minW: 1, minH: 1, maxW: 4, maxH: 3 }, def);
}

/* ── Usage Tiles ── */
regTile('stat-monthly-spend', { title: 'Monthly Spend', category: 'usage', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatMonthly(el); }
});
regTile('stat-today-cost', { title: "Today's Cost", category: 'usage', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatToday(el); }
});
regTile('stat-venice', { title: 'Venice Balance', category: 'usage', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatVenice(el); }
});
regTile('stat-openrouter', { title: 'OpenRouter', category: 'usage', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatOpenRouter(el); }
});
regTile('budget-gauges', { title: 'Budget Utilization', category: 'usage', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(3); },
  load: function(el) { loadBudgetGauges(el); }
});
regTile('cost-timeline', { title: 'Cost Over Time', category: 'usage', defaultW: 2, defaultH: 1, minH: 1,
  render: function() { return '<canvas id="chart-cost" style="width:100%;height:160px;"></canvas>'; },
  init: function(el) { initCostChart(); },
  load: function(el) { loadCostChart(); }
});
regTile('memory-timeline', { title: 'Memory Creation', category: 'usage', defaultW: 2, defaultH: 1, minH: 1,
  render: function() { return '<canvas id="chart-memory" style="width:100%;height:160px;"></canvas>'; },
  init: function(el) { initMemoryChart(); },
  load: function(el) { loadMemoryChart(); }
});

/* ── Agent Tiles ── */
regTile('stat-active-agents', { title: 'Active Agents', category: 'agents', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatAgents(el); }
});
regTile('stat-context', { title: 'Context Window', category: 'agents', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatContext(el); }
});
regTile('agent-status-map', { title: 'Agent Health', category: 'agents', defaultW: 2, defaultH: 1,
  render: function() { return '<div class="g-status-grid" id="agentGrid">' + skeleton(2) + '</div>'; },
  load: function(el) { loadAgentMap(el); }
});
regTile('dispatch-board', { title: 'Dispatch Board', category: 'agents', defaultW: 4, defaultH: 1, minW: 2,
  render: function() { return skeleton(5); },
  load: function(el) { loadDispatch(el); },
  bodyClass: 'no-pad'
});
regTile('hive-log', { title: 'Hive Mind', category: 'agents', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(4); },
  load: function(el) { loadHive(el); },
  bodyClass: 'no-pad'
});

/* ── Network Tiles ── */
regTile('pfsense-system', { title: 'Firewall Status', category: 'network', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadPfSense(el); }
});
regTile('net-interfaces', { title: 'Interfaces', category: 'network', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(3); },
  load: function(el) { loadInterfaces(el); },
  bodyClass: 'no-pad'
});
regTile('net-devices', { title: 'Connected Devices', category: 'network', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(4); },
  load: function(el) { loadDevices(el); },
  bodyClass: 'no-pad'
});
regTile('net-firewall-log', { title: 'Firewall Log', category: 'network', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(4); },
  load: function(el) { loadFirewallLog(el); },
  bodyClass: 'no-pad'
});
regTile('stat-device-count', { title: 'Device Count', category: 'network', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatDevices(el); }
});

/* ── Vault Tiles ── */
regTile('stat-memories', { title: 'Total Memories', category: 'vault', defaultW: 1, defaultH: 1,
  render: function() { return skelStat(); },
  load: function(el) { loadStatMemories(el); }
});
regTile('active-tasks', { title: 'Active Tasks', category: 'vault', defaultW: 1, defaultH: 1,
  render: function() { return skeleton(5); },
  load: function(el) { loadTasks(el); }
});
regTile('projects', { title: 'Projects', category: 'vault', defaultW: 1, defaultH: 1,
  render: function() { return skeleton(3); },
  load: function(el) { loadProjects(el); }
});
regTile('workflows', { title: 'Workflows', category: 'vault', defaultW: 1, defaultH: 1,
  render: function() { return skeleton(3); },
  load: function(el) { loadWorkflows(el); },
  bodyClass: 'no-pad'
});

/* ── Trading Tiles ── */
regTile('trading-indicators', { title: 'Trading Indicators', category: 'trading', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(3); },
  load: function(el) { loadTradingIndicators(el); }
});
regTile('trading-positions', { title: 'Open Positions', category: 'trading', defaultW: 2, defaultH: 1,
  render: function() { return skeleton(4); },
  load: function(el) { loadTradingPositions(el); },
  bodyClass: 'no-pad',
  headerExtra: function() { return '<button class="g-eye-btn" onclick="togglePnl()" title="Toggle P&amp;L visibility"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg></button>'; }
});

/* ══════════════════════════════════════════════════
   DEFAULT LAYOUT
   ══════════════════════════════════════════════════ */
var DEFAULT_LAYOUT = [
  { id: 'stat-monthly-spend', col: 1, row: 1, w: 1, h: 1 },
  { id: 'stat-active-agents', col: 2, row: 1, w: 1, h: 1 },
  { id: 'stat-context',       col: 3, row: 1, w: 1, h: 1 },
  { id: 'pfsense-system',     col: 4, row: 1, w: 1, h: 1 },
  { id: 'cost-timeline',      col: 1, row: 2, w: 2, h: 1 },
  { id: 'memory-timeline',    col: 3, row: 2, w: 2, h: 1 },
  { id: 'agent-status-map',   col: 1, row: 3, w: 1, h: 1 },
  { id: 'hive-log',           col: 2, row: 3, w: 3, h: 1 },
  { id: 'dispatch-board',     col: 1, row: 4, w: 4, h: 1 },
  /* ── Cost Row ── */
  { id: 'stat-today-cost',    col: 1, row: 5, w: 1, h: 1 },
  { id: 'stat-venice',        col: 2, row: 5, w: 1, h: 1 },
  { id: 'stat-openrouter',    col: 3, row: 5, w: 1, h: 1 },
  { id: 'stat-memories',      col: 4, row: 5, w: 1, h: 1 },
  /* ── Vault & Network ── */
  { id: 'budget-gauges',      col: 1, row: 6, w: 2, h: 1 },
  { id: 'stat-device-count',  col: 3, row: 6, w: 1, h: 1 },
  { id: 'active-tasks',       col: 1, row: 7, w: 1, h: 1 },
  { id: 'projects',           col: 2, row: 7, w: 1, h: 1 },
  { id: 'workflows',          col: 3, row: 7, w: 1, h: 1 },
  { id: 'net-firewall-log',   col: 4, row: 7, w: 1, h: 1 },
  { id: 'net-interfaces',     col: 1, row: 8, w: 2, h: 1 },
  { id: 'net-devices',        col: 3, row: 8, w: 2, h: 1 },
  { id: 'trading-indicators', col: 1, row: 9, w: 2, h: 1 },
  { id: 'trading-positions',  col: 3, row: 9, w: 2, h: 1 },
];

/* ══════════════════════════════════════════════════
   LAYOUT ENGINE
   ══════════════════════════════════════════════════ */
var LAYOUT_KEY = 'apex-dashboard-layout';
var layout = [];
var editMode = false;

function loadLayout() {
  try {
    var saved = localStorage.getItem(LAYOUT_KEY);
    if (saved) {
      var parsed = JSON.parse(saved);
      /* Validate: all tiles must exist in registry */
      var valid = parsed.filter(function(t) { return TILES[t.id]; });
      if (valid.length > 0) { layout = valid; return; }
    }
  } catch(e) {}
  layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
}

function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch(e) {}
}

function resetLayout() {
  layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  saveLayout();
  renderGrid();
  doRefresh();
}

function renderGrid() {
  var grid = document.getElementById('tileGrid');
  grid.innerHTML = '';
  for (var i = 0; i < layout.length; i++) {
    var item = layout[i];
    var def = TILES[item.id];
    if (!def) continue;
    var tile = document.createElement('div');
    tile.className = 'g-tile';
    tile.id = 'tile-' + item.id;
    tile.style.gridColumn = item.col + ' / span ' + item.w;
    tile.style.gridRow = item.row + ' / span ' + item.h;
    /* Header */
    var header = '<div class="g-tile-header">';
    header += '<span class="g-tile-title">' + esc(def.title) + '</span>';
    if (def.headerExtra) header += def.headerExtra();
    header += '<div class="g-tile-controls">';
    header += '<button class="g-tile-ctrl" onclick="moveTile(\\''+item.id+'\\',\\'up\\')" title="Move up">&#9650;</button>';
    header += '<button class="g-tile-ctrl" onclick="moveTile(\\''+item.id+'\\',\\'down\\')" title="Move down">&#9660;</button>';
    header += '<button class="g-tile-ctrl" onclick="moveTile(\\''+item.id+'\\',\\'left\\')" title="Move left">&#9664;</button>';
    header += '<button class="g-tile-ctrl" onclick="moveTile(\\''+item.id+'\\',\\'right\\')" title="Move right">&#9654;</button>';
    header += '<button class="g-tile-ctrl" onclick="cycleTileSize(\\''+item.id+'\\')" title="Resize">&#8596;</button>';
    header += '<button class="g-tile-ctrl remove" onclick="removeTile(\\''+item.id+'\\')" title="Remove">&times;</button>';
    header += '</div>';
    header += '</div>';
    /* Body */
    var bodyClass = def.bodyClass ? ' ' + def.bodyClass : '';
    var body = '<div class="g-tile-body' + bodyClass + '" id="body-' + item.id + '">' + def.render() + '</div>';
    tile.innerHTML = header + body;
    grid.appendChild(tile);
  }
  /* Add tile button (visible in edit mode) */
  var addBtn = document.createElement('div');
  addBtn.className = 'g-add-tile';
  addBtn.style.gridColumn = 'span 1';
  addBtn.innerHTML = '+ Add Tile';
  addBtn.onclick = showAddMenu;
  addBtn.id = 'addTileBtn';
  grid.appendChild(addBtn);
  /* Init tiles that need it (charts) */
  for (var i = 0; i < layout.length; i++) {
    var def = TILES[layout[i].id];
    if (def && def.init) def.init(document.getElementById('body-' + layout[i].id));
  }
}

/* ══════════════════════════════════════════════════
   EDIT MODE CONTROLS
   ══════════════════════════════════════════════════ */
document.getElementById('editToggle').addEventListener('click', function() {
  editMode = !editMode;
  document.getElementById('tileGrid').classList.toggle('g-edit-mode', editMode);
  this.classList.toggle('active', editMode);
});

function moveTile(id, dir) {
  var item = layout.find(function(t) { return t.id === id; });
  if (!item) return;
  if (dir === 'up' && item.row > 1) item.row--;
  if (dir === 'down') item.row++;
  if (dir === 'left' && item.col > 1) item.col--;
  if (dir === 'right' && item.col + item.w <= 4) item.col++;
  saveLayout();
  renderGrid();
  doRefresh();
}

function cycleTileSize(id) {
  var item = layout.find(function(t) { return t.id === id; });
  var def = TILES[id];
  if (!item || !def) return;
  /* Cycle: 1 -> 2 -> 3 -> 4 -> 1 (clamped to max) */
  var next = item.w >= (def.maxW || 4) ? (def.minW || 1) : item.w + 1;
  item.w = next;
  if (item.col + item.w > 5) item.col = 5 - item.w;
  saveLayout();
  renderGrid();
  doRefresh();
}

function removeTile(id) {
  layout = layout.filter(function(t) { return t.id !== id; });
  saveLayout();
  renderGrid();
}

function showAddMenu() {
  var existing = document.getElementById('addDropdown');
  if (existing) { existing.remove(); return; }
  var placed = {};
  layout.forEach(function(t) { placed[t.id] = true; });
  var available = Object.keys(TILES).filter(function(id) { return !placed[id]; });
  if (available.length === 0) return;
  var dd = document.createElement('div');
  dd.className = 'g-add-dropdown';
  dd.id = 'addDropdown';
  dd.style.position = 'fixed';
  dd.style.bottom = '60px';
  dd.style.right = '20px';
  dd.style.width = '220px';
  available.forEach(function(id) {
    var def = TILES[id];
    var opt = document.createElement('div');
    opt.className = 'g-add-option';
    opt.innerHTML = '<span class="cat">' + esc(def.category) + '</span> ' + esc(def.title);
    opt.onclick = function() { addTile(id); dd.remove(); };
    dd.appendChild(opt);
  });
  document.body.appendChild(dd);
  setTimeout(function() { document.addEventListener('click', function dismiss(e) { if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener('click', dismiss); } }); }, 10);
}

function addTile(id) {
  var def = TILES[id];
  if (!def) return;
  /* Find next available row */
  var maxRow = 0;
  layout.forEach(function(t) { if (t.row + (t.h || 1) > maxRow) maxRow = t.row + (t.h || 1); });
  layout.push({ id: id, col: 1, row: maxRow, w: def.defaultW || 1, h: def.defaultH || 1 });
  saveLayout();
  renderGrid();
  doRefresh();
}

/* Keyboard shortcut: r to refresh */
document.addEventListener('keydown', function(e) {
  if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement === document.body) doRefresh();
});

/* ══════════════════════════════════════════════════
   DATA LOADERS
   ══════════════════════════════════════════════════ */

/* Shared data cache */
var cache = { usage: null, health: null, hive: null, dispatch: null, tasks: null, projects: null, workflows: null, memories: null, tokens: null, positions: null, network: null };

/* ── Usage Stat Tiles ── */
async function loadStatMonthly(el) {
  try {
    if (!cache.usage) cache.usage = await api('/api/usage?chatId=' + encodeURIComponent(CHAT_ID));
    var d = cache.usage;
    if (isMaxPlan) {
      var turns = (d.monthly && d.monthly.monthTurns) || 0;
      el.innerHTML = '<div class="g-stat-value g-val-green">MAX</div><div class="g-stat-sub">' + turns + ' turns this month</div>';
    } else {
      var cost = (d.monthly && d.monthly.monthCost) || 0;
      var budget = (d.budgets && d.budgets.monthlyUsd) || 200;
      var pct = Math.round((cost / budget) * 100);
      var col = usageColor(pct);
      el.innerHTML = '<div class="g-stat-value g-val-' + col + '">$' + cost.toFixed(2) + '</div><div class="g-stat-sub">' + pct + '% of $' + budget + ' budget</div>';
    }
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadStatToday(el) {
  try {
    if (!cache.usage) cache.usage = await api('/api/usage?chatId=' + encodeURIComponent(CHAT_ID));
    var d = cache.usage;
    var turns = (d.daily && d.daily.todayTurns) || 0;
    if (isMaxPlan) {
      el.innerHTML = '<div class="g-stat-value">' + turns + '</div><div class="g-stat-sub">turns today</div>';
    } else {
      var cost = (d.daily && d.daily.todayCost) || 0;
      el.innerHTML = '<div class="g-stat-value">$' + cost.toFixed(2) + '</div><div class="g-stat-sub">' + turns + ' turns today</div>';
    }
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadStatVenice(el) {
  try {
    if (!cache.usage) cache.usage = await api('/api/usage?chatId=' + encodeURIComponent(CHAT_ID));
    var d = cache.usage;
    if (d.veniceBalance && d.veniceBalance.balanceUsd != null) {
      var bal = d.veniceBalance.balanceUsd;
      var col = bal > 20 ? 'green' : bal >= 5 ? 'yellow' : 'red';
      el.innerHTML = '<div class="g-stat-value g-val-' + col + '">$' + bal.toFixed(2) + '</div><div class="g-stat-sub">Venice credits</div>';
    } else {
      el.innerHTML = '<div class="g-stat-value" style="color:var(--g-muted)">--</div><div class="g-stat-sub">Venice unavailable</div>';
    }
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadStatOpenRouter(el) {
  try {
    if (!cache.usage) cache.usage = await api('/api/usage?chatId=' + encodeURIComponent(CHAT_ID));
    var d = cache.usage;
    if (d.openrouter) {
      var cost = d.openrouter.monthCost || 0;
      var turns = d.openrouter.todayTurns || 0;
      var col = cost < 5 ? 'green' : cost < 20 ? 'yellow' : 'red';
      el.innerHTML = '<div class="g-stat-value g-val-' + col + '">$' + cost.toFixed(2) + '</div><div class="g-stat-sub">' + turns + ' turns today</div>';
    } else {
      el.innerHTML = '<div class="g-stat-value" style="color:var(--g-muted)">$0.00</div><div class="g-stat-sub">OpenRouter this month</div>';
    }
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadBudgetGauges(el) {
  try {
    if (!cache.usage) cache.usage = await api('/api/usage?chatId=' + encodeURIComponent(CHAT_ID));
    var d = cache.usage;
    function bar(label, pct) {
      var c = usageColor(pct);
      return '<div class="g-budget-row"><span class="g-budget-label">'+label+'</span><div class="g-budget-track"><div class="g-budget-fill '+c+'" style="width:'+pct+'%"></div></div><span class="g-budget-pct g-val-'+c+'">'+pct+'%</span></div>';
    }
    if (isMaxPlan) {
      /* MAX plan: show token volume only, no cost budgets */
      var dailyTokens = d.daily ? (d.daily.todayInput||0) + (d.daily.todayOutput||0) : 0;
      var weeklyTokens = d.weekly ? (d.weekly.weekInput||0) + (d.weekly.weekOutput||0) : 0;
      function fmtK(n) { return n > 1000000 ? (n/1000000).toFixed(1)+'M' : n > 1000 ? Math.round(n/1000)+'k' : n; }
      el.innerHTML = '<div class="g-budget-row"><span class="g-budget-label">Today</span><span class="g-budget-pct" style="color:var(--g-text);margin-left:auto">' + fmtK(dailyTokens) + ' tokens</span></div>' +
        '<div class="g-budget-row"><span class="g-budget-label">Weekly</span><span class="g-budget-pct" style="color:var(--g-text);margin-left:auto">' + fmtK(weeklyTokens) + ' tokens</span></div>' +
        '<div class="g-budget-row"><span class="g-budget-label">Plan</span><span class="g-budget-pct" style="color:var(--g-green);margin-left:auto">MAX (unlimited)</span></div>';
    } else {
      var dailyBudget = (d.budgets && d.budgets.daily) || 1000000;
      var weeklyBudget = (d.budgets && d.budgets.weekly) || 5000000;
      var monthlyBudget = (d.budgets && d.budgets.monthlyUsd) || 200;
      var dailyTokens = d.daily ? (d.daily.todayInput||0) + (d.daily.todayOutput||0) : 0;
      var weeklyTokens = d.weekly ? (d.weekly.weekInput||0) + (d.weekly.weekOutput||0) : 0;
      var monthCost = d.monthly ? d.monthly.monthCost || 0 : 0;
      var dp = Math.min(Math.round(dailyTokens/dailyBudget*100),100);
      var wp = Math.min(Math.round(weeklyTokens/weeklyBudget*100),100);
      var mp = Math.min(Math.round(monthCost/monthlyBudget*100),100);
      el.innerHTML = bar('Daily', dp) + bar('Weekly', wp) + bar('Monthly', mp);
    }
  } catch(e) { el.innerHTML = skeleton(3); }
}

/* ── Agent Stat Tiles ── */
async function loadStatAgents(el) {
  try {
    if (!cache.hive) cache.hive = await api('/api/hive');
    var agents = cache.hive.agents || [];
    var online = agents.filter(function(a) { return a.pm2_status === 'online'; }).length;
    el.innerHTML = '<div class="g-stat-value">' + online + '<span class="g-stat-unit">/ ' + agents.length + '</span></div><div class="g-stat-sub">agents online</div>';
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadStatContext(el) {
  try {
    if (!cache.health) cache.health = await api('/api/health?chatId=' + encodeURIComponent(CHAT_ID));
    var d = cache.health;
    var pct = d.contextPct || 0;
    var col = pct < 50 ? 'green' : pct < 80 ? 'yellow' : 'red';
    el.innerHTML = '<div class="g-stat-value g-val-'+col+'">' + pct + '<span class="g-stat-unit">%</span></div><div class="g-stat-sub">' + d.turns + ' turns, ' + d.compactions + ' compactions</div>';
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadAgentMap(el) {
  try {
    if (!cache.hive) cache.hive = await api('/api/hive');
    var agents = cache.hive.agents || [];
    var html = '<div class="g-status-grid">';
    for (var i = 0; i < agents.length; i++) {
      var a = agents[i];
      var cls = a.pm2_status === 'online' ? (a.healthy ? 'healthy' : 'degraded') : (a.pm2_status === 'stopped' ? 'offline' : 'unknown');
      var meta = AGENT_META[a.name] || { label: a.name, role: '' };
      html += '<div class="g-status-tile '+cls+'"><div class="g-status-name">'+esc(meta.label)+'</div><div class="g-status-role">'+esc(meta.role)+'</div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="color:var(--g-red)">Failed to load</div>'; }
}
async function loadDispatch(el) {
  try {
    if (!cache.dispatch) cache.dispatch = await api('/api/dispatch');
    var data = cache.dispatch;
    if (!data.agents || data.agents.length === 0) { el.innerHTML = '<div style="padding:12px;color:var(--g-muted)">No agents</div>'; return; }
    var html = '<table class="g-table"><thead><tr><th>Agent</th><th></th><th>Status</th><th>Current Task</th><th>Queue</th><th>Last Done</th></tr></thead><tbody>';
    for (var i = 0; i < data.agents.length; i++) {
      var a = data.agents[i];
      var working = a.current !== null;
      var hasPending = a.pending_count > 0;
      var isOffline = a.pm2_status !== 'online';
      var dotCls = isOffline ? 'offline' : working ? 'working' : hasPending ? 'queued' : 'idle';
      var statusText = isOffline ? 'Offline' : working ? 'Working' : hasPending ? 'Queued' : 'Idle';
      var statusColor = isOffline ? 'var(--g-red)' : working ? 'var(--g-green)' : hasPending ? 'var(--g-yellow)' : 'var(--g-dim)';
      var job = working ? '<span class="g-mono">'+esc(a.current.prompt_preview)+'</span>' : '<span style="color:var(--g-dim);font-style:italic">--</span>';
      var badgeCls = a.pending_count > 0 ? 'pending' : 'zero';
      var last = '--';
      if (a.recent_completed && a.recent_completed.length > 0) {
        last = esc(a.recent_completed[0].prompt_preview.slice(0,35)) + ' <span style="color:var(--g-dim);font-size:11px">'+timeAgo(a.recent_completed[0].completed_at)+'</span>';
      }
      var name = a.name.charAt(0).toUpperCase() + a.name.slice(1);
      var rowOp = (!working && !hasPending && !isOffline) ? ' style="opacity:0.45"' : '';
      html += '<tr'+rowOp+'><td style="white-space:nowrap"><strong style="color:var(--g-white)">'+esc(name)+'</strong><br><span style="font-size:11px;color:var(--g-dim)">'+esc(a.role||'')+'</span></td>';
      html += '<td><span class="g-dot '+dotCls+'"></span></td>';
      html += '<td style="font-size:11px;font-weight:600;color:'+statusColor+'">'+statusText+'</td>';
      html += '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+job+'</td>';
      html += '<td><span class="g-badge '+badgeCls+'">'+a.pending_count+'</span></td>';
      html += '<td style="font-size:11px">'+last+'</td></tr>';
    }
    html += '</tbody></table>';
    /* Scheduled tasks */
    if (data.scheduled && data.scheduled.length > 0) {
      html += '<div style="padding:8px 10px 4px"><span style="font-size:10px;font-weight:700;color:var(--g-dim);text-transform:uppercase;letter-spacing:1px">Scheduled ('+data.scheduled.length+')</span></div>';
      var sorted = data.scheduled.slice().sort(function(a,b) { return (a.status==='active'?0:1) - (b.status==='active'?0:1) || new Date(a.next_run).getTime() - new Date(b.next_run).getTime(); });
      for (var j = 0; j < Math.min(sorted.length, 10); j++) {
        var s = sorted[j];
        var sc = s.status === 'active' ? 'color:var(--g-green)' : 'color:var(--g-yellow)';
        html += '<div class="g-log-entry"><span style="font-size:10px;font-weight:600;text-transform:uppercase;'+sc+';min-width:45px">'+s.status+'</span>';
        html += '<span class="g-mono" style="min-width:80px;color:var(--g-dim)">'+esc(s.schedule)+'</span>';
        html += '<span class="g-log-msg">'+esc(s.prompt_preview)+'</span>';
        html += '<span style="font-size:11px;color:var(--g-purple);white-space:nowrap">'+(s.status==='paused'?'paused':timeUntil(s.next_run))+'</span></div>';
      }
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed to load</div>'; }
}
async function loadHive(el) {
  try {
    var data = await api('/api/hive/log?limit=25');
    if (!data.entries || data.entries.length === 0) { el.innerHTML = '<div style="padding:12px;color:var(--g-muted)">No activity</div>'; return; }
    var html = '';
    for (var i = 0; i < data.entries.length; i++) {
      var e = data.entries[i];
      if (e.action === 'heartbeat') continue;
      html += '<div class="g-log-entry"><span class="g-log-time">'+timeAgo(e.created_at)+'</span>';
      html += '<span class="g-log-agent">'+esc(e.agent)+'</span>';
      html += '<span class="g-log-level '+e.action+'">'+esc(e.action)+'</span>';
      html += '<span class="g-log-msg">'+esc(e.detail||'--')+'</span></div>';
    }
    el.innerHTML = html || '<div style="padding:12px;color:var(--g-muted)">All quiet</div>';
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed to load</div>'; }
}

/* ── Network Tiles ── */
async function loadPfSense(el) {
  try {
    var data = await api('/api/network/status');
    if (data.error || !data.cpu && data.cpu !== 0) {
      el.innerHTML = '<div class="g-stat-value" style="color:var(--g-dim)">--</div><div class="g-stat-sub">pfSense unreachable</div>';
      return;
    }
    el.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">'
      + '<div><div style="font-size:10px;color:var(--g-muted)">CPU</div><div style="font-size:16px;font-weight:700;color:var(--g-white)">'+data.cpu+'%</div></div>'
      + '<div><div style="font-size:10px;color:var(--g-muted)">RAM</div><div style="font-size:16px;font-weight:700;color:var(--g-white)">'+data.memory+'%</div></div>'
      + '<div><div style="font-size:10px;color:var(--g-muted)">Temp</div><div style="font-size:16px;font-weight:700;color:var(--g-white)">'+(data.temperature||'--')+'&deg;C</div></div>'
      + '<div><div style="font-size:10px;color:var(--g-muted)">Uptime</div><div style="font-size:16px;font-weight:700;color:var(--g-white)">'+(data.uptime ? Math.floor(data.uptime/86400)+'d' : '--')+'</div></div>'
      + '</div>';
  } catch(e) { el.innerHTML = '<div class="g-stat-value" style="color:var(--g-dim)">--</div><div class="g-stat-sub">Not available</div>'; }
}
async function loadInterfaces(el) {
  try {
    var data = await api('/api/network/interfaces');
    if (!data.interfaces || data.interfaces.length === 0) { el.innerHTML = '<div style="padding:12px;color:var(--g-muted)">No interfaces</div>'; return; }
    var html = '<table class="g-table"><thead><tr><th>Name</th><th>Status</th><th>In</th><th>Out</th><th>Speed</th></tr></thead><tbody>';
    for (var i = 0; i < data.interfaces.length; i++) {
      var iface = data.interfaces[i];
      var up = iface.status === 'up' || iface.status === 'active';
      html += '<tr><td style="color:var(--g-white);font-weight:600">'+esc(iface.name)+'</td>';
      html += '<td><span class="g-dot '+(up?'online':'offline')+'"></span></td>';
      html += '<td style="font-size:11px">'+(iface.bytesIn ? (iface.bytesIn/1048576).toFixed(1)+' MB' : '--')+'</td>';
      html += '<td style="font-size:11px">'+(iface.bytesOut ? (iface.bytesOut/1048576).toFixed(1)+' MB' : '--')+'</td>';
      html += '<td style="font-size:11px;color:var(--g-dim)">'+esc(iface.speed||'--')+'</td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed</div>'; }
}
async function loadDevices(el) {
  try {
    var data = await api('/api/network/devices');
    if (!data.devices || data.devices.length === 0) { el.innerHTML = '<div style="padding:12px;color:var(--g-muted)">No devices</div>'; return; }
    var html = '<table class="g-table"><thead><tr><th>IP</th><th>Host</th><th>Vendor</th><th>VLAN</th><th>Seen</th></tr></thead><tbody>';
    for (var i = 0; i < Math.min(data.devices.length, 50); i++) {
      var d = data.devices[i];
      html += '<tr><td class="g-mono" style="color:var(--g-white)">'+esc(d.ip)+'</td>';
      html += '<td>'+esc(d.hostname||'--')+'</td>';
      html += '<td style="color:var(--g-dim);font-size:11px">'+esc(d.vendor||'--')+'</td>';
      html += '<td style="font-size:11px">'+esc(d.vlan||'--')+'</td>';
      html += '<td style="font-size:11px;color:var(--g-dim)">'+timeAgo(d.lastSeen)+'</td></tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed</div>'; }
}
async function loadFirewallLog(el) {
  try {
    var data = await api('/api/network/firewall');
    if (!data.entries || data.entries.length === 0) { el.innerHTML = '<div style="padding:12px;color:var(--g-muted)">No entries</div>'; return; }
    var html = '';
    for (var i = 0; i < Math.min(data.entries.length, 20); i++) {
      var e = data.entries[i];
      var actCls = e.action === 'block' || e.action === 'Block' ? 'fail' : 'claim';
      html += '<div class="g-log-entry"><span class="g-log-time">'+esc(e.time||'')+'</span>';
      html += '<span class="g-log-level '+actCls+'">'+esc(e.action)+'</span>';
      html += '<span class="g-log-msg">'+esc(e.source)+' &rarr; '+esc(e.destination)+'</span>';
      html += '<span style="font-size:10px;color:var(--g-dim)">'+esc(e.protocol||'')+'</span></div>';
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed</div>'; }
}
async function loadStatDevices(el) {
  try {
    var data = await api('/api/network/devices');
    var count = data.devices ? data.devices.length : 0;
    el.innerHTML = '<div class="g-stat-value">' + count + '</div><div class="g-stat-sub">connected devices</div>';
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}

/* ── Vault Tiles ── */
async function loadStatMemories(el) {
  try {
    if (!cache.memories) cache.memories = await api('/api/memories?chatId=' + encodeURIComponent(CHAT_ID));
    var s = cache.memories.stats || {};
    el.innerHTML = '<div class="g-stat-value">' + (s.total||0) + '</div><div class="g-stat-sub">' + (s.semantic||0) + ' semantic, ' + (s.episodic||0) + ' episodic</div>';
  } catch(e) { el.innerHTML = '<div class="g-stat-value">--</div>'; }
}
async function loadTasks(el) {
  try {
    if (!cache.tasks) cache.tasks = await api('/api/daily-tasks');
    var data = cache.tasks;
    if (!data.tasks || data.tasks.length === 0) { el.innerHTML = '<div style="color:var(--g-muted)">All clear</div>'; return; }
    var groups = {}, order = [];
    for (var i = 0; i < data.tasks.length; i++) {
      var t = data.tasks[i];
      if (!groups[t.section]) { groups[t.section] = []; order.push(t.section); }
      groups[t.section].push(t);
    }
    var html = '';
    for (var g = 0; g < order.length; g++) {
      var sec = order[g];
      html += '<div class="g-task-group"><div class="g-task-group-header">' + esc(sec) + '</div>';
      for (var j = 0; j < groups[sec].length; j++) {
        var tk = groups[sec][j];
        var dc = tk.done ? ' g-task-done' : '';
        var ch = tk.done ? '\\u2611' : '\\u2610';
        html += '<div class="g-task-item'+dc+'" data-section="'+escAttr(sec)+'" data-task="'+escAttr(tk.task)+'" data-done="'+tk.done+'" onclick="toggleTask(this)">';
        html += '<span class="g-task-check">'+ch+'</span><span class="g-task-text">'+esc(tk.task)+'</span></div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="color:var(--g-red)">Failed</div>'; }
}
async function toggleTask(elem) {
  var section = elem.dataset.section, task = elem.dataset.task, wasDone = elem.dataset.done === 'true';
  var newDone = !wasDone;
  elem.dataset.done = String(newDone);
  elem.querySelector('.g-task-check').textContent = newDone ? '\\u2611' : '\\u2610';
  if (newDone) elem.classList.add('g-task-done'); else elem.classList.remove('g-task-done');
  try {
    var res = await fetch(BASE + '/api/daily-tasks/toggle', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section: section, task: task, done: newDone }) });
    var data = await res.json();
    if (!data.success) { elem.dataset.done = String(wasDone); elem.querySelector('.g-task-check').textContent = wasDone ? '\\u2611' : '\\u2610'; if (wasDone) elem.classList.add('g-task-done'); else elem.classList.remove('g-task-done'); }
    else { cache.tasks = null; cache.projects = null; }
  } catch(e) { elem.dataset.done = String(wasDone); elem.querySelector('.g-task-check').textContent = wasDone ? '\\u2611' : '\\u2610'; if (wasDone) elem.classList.add('g-task-done'); else elem.classList.remove('g-task-done'); }
}
async function loadProjects(el) {
  try {
    if (!cache.projects) cache.projects = await api('/api/projects');
    var data = cache.projects;
    if (!data.projects || data.projects.length === 0) { el.innerHTML = '<div style="color:var(--g-muted)">No active projects</div>'; return; }
    var html = '';
    for (var i = 0; i < data.projects.length; i++) {
      var p = data.projects[i];
      var pct = p.total > 0 ? Math.round(p.done/p.total*100) : 0;
      html += '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:12px;color:var(--g-white)">'+esc(p.name)+'</span><span style="font-size:11px;color:var(--g-purple)">'+p.done+'/'+p.total+'</span></div>';
      html += '<div class="g-prog-track"><div class="g-prog-fill" style="width:'+pct+'%"></div></div></div>';
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="color:var(--g-red)">Failed</div>'; }
}
async function loadWorkflows(el) {
  try {
    if (!cache.workflows) cache.workflows = await api('/api/workflows');
    var data = cache.workflows;
    if (!data.workflows || data.workflows.length === 0) { el.innerHTML = '<div style="padding:12px;color:var(--g-muted)">None defined</div>'; return; }
    var html = '';
    for (var i = 0; i < data.workflows.length; i++) {
      var w = data.workflows[i];
      var sc = 'idle';
      if (w.lastRun) sc = w.lastRun.status === 'completed' ? 'completed' : w.lastRun.status === 'failed' ? 'failed' : 'running';
      if (!w.enabled) sc = 'idle';
      var lastStr = w.lastRun ? w.lastRun.status + ' ' + timeAgo(w.lastRun.at) : '--';
      html += '<div class="g-log-entry" style="gap:8px"><span class="g-dot '+sc+'" style="flex-shrink:0"></span>';
      html += '<span style="color:var(--g-white);font-weight:600;min-width:90px;font-size:12px">'+esc(w.workflow)+'</span>';
      html += '<span style="flex:1;color:var(--g-dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc((w.triggers||[]).join(', ')||'manual')+'</span>';
      html += '<span style="font-size:11px;color:var(--g-muted);white-space:nowrap">'+esc(lastStr)+'</span></div>';
    }
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed</div>'; }
}

/* ── Trading Tiles ── */
var currentPair = 'BTC-USDT', currentTF = '15m', pnlVisible = true;

async function loadTradingIndicators(el) {
  try {
    /* Build selector + indicator panel */
    var limit = { '5m': 288, '15m': 96, '1H': 24, '4H': 6, '1D': 1 }[currentTF] || 96;
    var candles = await tradeApi('/api/candles?pair='+currentPair+'&timeframe='+currentTF+'&limit='+limit);
    var indData = await tradeApi('/api/indicators?pair='+currentPair+'&timeframe='+currentTF+'&limit='+limit);
    var price = 0, change = 0, changePct = 0;
    if (candles.candles && candles.candles.length > 0) {
      var last = candles.candles[candles.candles.length-1];
      var prev = candles.candles.length >= 2 ? candles.candles[candles.candles.length-2] : last;
      price = last.close;
      change = last.close - prev.close;
      changePct = ((change/prev.close)*100).toFixed(2);
    }
    /* Pair selector */
    var pairs = ['BTC-USDT','ETH-USDT','SOL-USDT','XRP-USDT','SUI-USDT'];
    try { var wl = await tradeApi('/api/watchlist?timeframe='+currentTF); if (wl.pairs && wl.pairs.length) pairs = wl.pairs; } catch(e){}
    var html = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">';
    for (var i = 0; i < pairs.length; i++) {
      var active = pairs[i] === currentPair ? ' active' : '';
      html += '<span class="g-pill'+active+'" onclick="selectPair(\\''+pairs[i]+'\\')" style="cursor:pointer">'+pairs[i].replace('-USDT','')+'</span>';
    }
    html += '</div>';
    /* TF selector */
    html += '<div style="display:flex;gap:4px;margin-bottom:8px">';
    ['5m','15m','1H','4H','1D'].forEach(function(tf) {
      var active = tf === currentTF ? ' active' : '';
      html += '<span class="g-pill'+active+'" onclick="selectTF(\\''+tf+'\\')" style="cursor:pointer">'+tf+'</span>';
    });
    html += '</div>';
    /* Price */
    var chgCls = change >= 0 ? 'g-bull' : 'g-bear';
    html += '<div style="margin-bottom:8px"><span style="font-size:20px;font-weight:700;color:var(--g-white)">$'+formatPrice(price)+'</span> ';
    html += '<span class="'+chgCls+'" style="font-size:13px;font-weight:600">'+(change>=0?'+':'')+formatPrice(change)+' ('+(change>=0?'+':'')+changePct+'%)</span></div>';
    /* Indicators */
    var latest = indData.latest || [];
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px">';
    for (var i = 0; i < latest.length; i++) {
      var ind = latest[i];
      var label = ind.indicator.replace('_',' ').toUpperCase();
      var val = '--', cls = 'g-neutral';
      if (ind.indicator === 'sma_9' || ind.indicator === 'vidya') { var above = price > (ind.value||0); val = above ? 'Above' : 'Below'; cls = above ? 'g-bull' : 'g-bear'; }
      else if (ind.indicator === 'zlema') { var t = ind.extra ? ind.extra.trend : 0; val = t===1?'Bullish':t===-1?'Bearish':'Neutral'; cls = t===1?'g-bull':t===-1?'g-bear':'g-neutral'; }
      else if (ind.indicator === 'two_pole') { var up = (ind.value||0) > 0; val = up?'Up':'Down'; cls = up?'g-bull':'g-bear'; }
      else if (ind.indicator === 'momentum_bias') { var bull = ind.extra ? ind.extra.bullish : false; val = bull?'Bullish':'Bearish'; cls = bull?'g-bull':'g-bear'; }
      else if (ind.indicator === 'smc') {
        var t = ind.extra ? ind.extra.trend : 'neutral';
        val = t==='bullish'?'Bull':t==='bearish'?'Bear':'Flat';
        if (ind.extra && ind.extra.signal) val += ' ['+ind.extra.signal.replace('_',' ').toUpperCase()+']';
        cls = t==='bullish'?'g-bull':t==='bearish'?'g-bear':'g-neutral';
      }
      html += '<div class="g-ind-card"><div class="g-ind-label">'+label+'</div><div class="g-ind-val '+cls+'">'+val+'</div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div style="color:var(--g-red)">Failed to load trading data</div>'; }
}
function selectPair(p) { currentPair = p; var el = document.getElementById('body-trading-indicators'); if (el) loadTradingIndicators(el); var el2 = document.getElementById('body-trading-positions'); if (el2) loadTradingPositions(el2); }
function selectTF(tf) { currentTF = tf; var el = document.getElementById('body-trading-indicators'); if (el) loadTradingIndicators(el); }
function togglePnl() { pnlVisible = !pnlVisible; var el = document.getElementById('body-trading-positions'); if (el) loadTradingPositions(el); }

async function loadTradingPositions(el) {
  try {
    var data = await tradeApi('/api/multi-positions?limit=5');
    cache.positions = data;
    var html = '';
    ['trader-1','trader-2'].forEach(function(bot) {
      var bd = data[bot];
      if (!bd) return;
      var all = bd.positions || [];
      var openCount = (bd.openPositions || []).length;
      var label = bot === 'trader-1' ? 'Trader-1 (1x)' : 'Trader-2 (3x)';
      html += '<div style="padding:8px 10px 4px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:11px;font-weight:700;color:var(--g-purple)">'+label+'</span>';
      html += '<span style="font-size:11px;color:var(--g-dim)">'+all.length+' trades'+(openCount>0?' ('+openCount+' open)':'')+'</span></div>';
      if (all.length === 0) { html += '<div style="padding:12px;text-align:center;color:var(--g-dim)">No trades yet</div>'; return; }
      html += '<table class="g-table"><thead><tr><th>Pair</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Status</th></tr></thead><tbody>';
      for (var i = 0; i < all.length; i++) {
        var p = all[i];
        var sc = p.side==='long'?'g-bull':'g-bear';
        var stc = p.status==='open'?'color:var(--g-blue)':'color:var(--g-dim)';
        var pnl = '--';
        if (p.pnl_usd != null) pnl = pnlVisible ? ((p.pnl_usd>=0?'+':'')+p.pnl_usd.toFixed(2)) : '***';
        var pnlCls = p.pnl_usd != null ? (p.pnl_usd>=0?'g-bull':'g-bear') : 'g-neutral';
        html += '<tr><td style="color:var(--g-white);font-weight:600">'+p.pair.replace('-USDT','')+'</td>';
        html += '<td class="'+sc+'" style="font-weight:600">'+p.side.toUpperCase()+'</td>';
        html += '<td>$'+formatPrice(p.entry_price)+'</td>';
        html += '<td>'+(p.exit_price != null ? '$'+formatPrice(p.exit_price) : '--')+'</td>';
        html += '<td class="'+(pnlVisible?pnlCls:'g-neutral')+'" style="font-weight:600">'+pnl+'</td>';
        html += '<td style="'+stc+'">'+p.status.toUpperCase()+'</td></tr>';
      }
      html += '</tbody></table>';
    });
    el.innerHTML = html || '<div style="padding:12px;color:var(--g-muted)">No trading data</div>';
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:var(--g-red)">Failed</div>'; }
}

/* ── Chart Tiles ── */
function initCostChart() {
  var canvas = document.getElementById('chart-cost');
  if (!canvas || typeof Chart === 'undefined') return;
  charts.cost = new Chart(canvas, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: '#B877D9', backgroundColor: 'rgba(184,119,217,0.12)', fill: 'origin', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: true, ticks: { maxTicksToSkip: 3 } }, y: { display: true, beginAtZero: true } }, plugins: { tooltip: { callbacks: { label: function(ctx) { return '$' + ctx.parsed.y.toFixed(2); } } } } }
  });
}
function initMemoryChart() {
  var canvas = document.getElementById('chart-memory');
  if (!canvas || typeof Chart === 'undefined') return;
  charts.memory = new Chart(canvas, {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Semantic', data: [], backgroundColor: 'rgba(184,119,217,0.7)', borderRadius: 2 },
      { label: 'Episodic', data: [], backgroundColor: 'rgba(87,148,242,0.7)', borderRadius: 2 }
    ] },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
  });
}
async function loadCostChart() {
  if (!charts.cost) return;
  try {
    var data = await api('/api/tokens?chatId='+encodeURIComponent(CHAT_ID)+'&'+getRangeParam());
    // Use hourly data for sub-day ranges, daily otherwise
    var ht = data.hourlyTimeline || [];
    if (ht.length > 0) {
      charts.cost.data.labels = ht.map(function(d) { return d.hour.slice(11, 16); });
      charts.cost.data.datasets[0].data = ht.map(function(d) { return d.cost; });
    } else {
      var tl = data.costTimeline || [];
      charts.cost.data.labels = tl.map(function(d) { return d.date.slice(5); });
      charts.cost.data.datasets[0].data = tl.map(function(d) { return d.cost; });
    }
    charts.cost.update('none');
  } catch(e) {}
}
async function loadMemoryChart() {
  if (!charts.memory) return;
  try {
    var data = await api('/api/memories?chatId='+encodeURIComponent(CHAT_ID)+'&'+getRangeParam());
    var tl = data.timeline || [];
    charts.memory.data.labels = tl.map(function(d) { return d.date.slice(5); });
    charts.memory.data.datasets[0].data = tl.map(function(d) { return d.semantic; });
    charts.memory.data.datasets[1].data = tl.map(function(d) { return d.episodic; });
    charts.memory.update('none');
  } catch(e) {}
}

function refreshTimeSeries() {
  loadCostChart();
  loadMemoryChart();
}

/* ══════════════════════════════════════════════════
   MASTER REFRESH
   ══════════════════════════════════════════════════ */
async function doRefresh() {
  var btn = document.querySelector('#refreshBtn svg');
  if (btn) btn.classList.add('g-spinning');
  /* Clear cache */
  cache = { usage: null, health: null, hive: null, dispatch: null, tasks: null, projects: null, workflows: null, memories: null, tokens: null, positions: null, network: null };
  /* Load all placed tiles */
  var promises = [];
  for (var i = 0; i < layout.length; i++) {
    var item = layout[i];
    var def = TILES[item.id];
    if (!def || !def.load) continue;
    var body = document.getElementById('body-' + item.id);
    if (body) promises.push(def.load(body));
  }
  var results = await Promise.allSettled(promises);
  var anyFailed = results.some(function(r) { return r.status === 'rejected'; });
  document.getElementById('statusDot').className = anyFailed ? 'g-status-dot error' : 'g-status-dot';
  if (btn) btn.classList.remove('g-spinning');
  document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
}

/* ══════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════ */
loadLayout();
renderGrid();
doRefresh();
<\/script>
</body>
</html>`;
}
