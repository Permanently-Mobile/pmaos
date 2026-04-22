/**
 * Avatar Display HTML (v20.0) - KIOSK CONTROL CENTER
 *
 * Three-column layout: Chat (left, collapsible) | Avatar (center, 85%) | Quick Links (right, collapsible)
 * Bottom bar: model selectors, status, mic
 * Renders pre-computed ASCII face edges over matrix rain.
 * Face mask dims rain inside the face silhouette.
 * Edge characters drawn with cyan-white gradient based on weight.
 * Breathing pulse, scan line, CRT overlay.
 */

import { AVATAR_VERSION } from './avatar-state.js';

// ═══════════════════════════════════════════════
//  STYLES
// ═══════════════════════════════════════════════
function generateStyles(): string {
  return `<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#000;font-family:'Consolas','Courier New',monospace;touch-action:none}
body{display:flex;flex-direction:column}

/* ── Layout Shell ── */
#kioskRoot{display:flex;flex:1;min-height:0;position:relative}

/* ── Left Panel (Chat) ── */
#leftPanel{
  width:280px;min-width:220px;max-width:380px;
  display:flex;flex-direction:column;
  background:rgba(2,4,12,0.95);
  border-right:1px solid rgba(40,100,200,0.2);
  transition:margin-left 0.3s ease,opacity 0.3s ease;
  z-index:10;position:relative;flex-shrink:0;
}
#leftPanel.collapsed{margin-left:-280px;opacity:0;pointer-events:none}
#leftPanelHeader{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 12px;border-bottom:1px solid rgba(40,100,200,0.15);
  color:rgba(120,200,255,0.7);font-size:11px;letter-spacing:1px;text-transform:uppercase;
  flex-shrink:0;
}
#chatLog{flex:1;overflow-y:auto;padding:10px 12px;color:rgba(120,200,255,0.85);word-wrap:break-word;min-height:0;font-size:13px;line-height:1.5}
#chatInputBar{
  display:flex;border-top:1px solid rgba(40,100,200,0.15);
  padding:8px 10px;gap:6px;align-items:flex-end;flex-shrink:0;
  min-height:20%;max-height:30%;position:relative;
}
#chatInput{
  flex:1;background:rgba(8,16,32,0.8);border:1px solid rgba(40,100,200,0.25);
  border-radius:6px;padding:8px 10px;color:rgba(180,230,255,0.9);
  font:13px 'Consolas','Courier New',monospace;outline:none;
  resize:none;overflow-y:auto;white-space:pre-wrap;word-wrap:break-word;
  min-height:100%;max-height:100%;line-height:1.4;
}
#chatInput:focus{border-color:rgba(80,180,255,0.5)}
#chatInput::placeholder{color:rgba(80,140,200,0.4)}

/* ── Center Panel (Avatar) ── */
#centerPanel{flex:1;display:flex;flex-direction:column;position:relative;min-width:0;overflow:hidden}
#avatarContainer{flex:1;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden}
#avatarContainer canvas{display:block;max-width:100%;max-height:100%}

/* ── Top Bar ── */
#topBar{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 14px;height:36px;flex-shrink:0;
  background:rgba(2,4,12,0.9);border-bottom:1px solid rgba(40,100,200,0.15);
  z-index:20;
}
#topBarLeft{display:flex;align-items:center;gap:10px}
#topBarCenter{color:rgba(120,200,255,0.6);font-size:12px;letter-spacing:2px;text-transform:uppercase}
#topBarRight{display:flex;align-items:center;gap:10px}

/* ── Bottom Bar ── */
#bottomBar{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 14px;height:44px;flex-shrink:0;
  background:rgba(2,4,12,0.9);border-top:1px solid rgba(40,100,200,0.15);
  z-index:20;
}
.bar-group{display:flex;align-items:center;gap:10px}
.bar-center{gap:12px}

/* ── Right Panel (Quick Links) ── */
#rightPanel{
  width:200px;min-width:160px;
  display:flex;flex-direction:column;
  background:rgba(2,4,12,0.95);
  border-left:1px solid rgba(40,100,200,0.2);
  transition:margin-right 0.3s ease,opacity 0.3s ease;
  z-index:10;position:relative;flex-shrink:0;
}
#rightPanel.collapsed{margin-right:-200px;opacity:0;pointer-events:none}
#rightPanelHeader{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 12px;border-bottom:1px solid rgba(40,100,200,0.15);
  color:rgba(120,200,255,0.7);font-size:11px;letter-spacing:1px;text-transform:uppercase;
  flex-shrink:0;
}
#rightPanelContent{flex:1;overflow-y:auto;padding:10px 12px}

/* ── Shared UI Elements ── */
.kiosk-btn{
  display:flex;align-items:center;justify-content:center;
  border-radius:6px;cursor:pointer;user-select:none;transition:all 0.15s;
  border:1px solid rgba(40,100,200,0.25);background:rgba(8,16,32,0.6);
}
.kiosk-btn:hover{background:rgba(20,50,100,0.6);border-color:rgba(80,180,255,0.4)}
.kiosk-pill{
  height:28px;border-radius:14px;padding:0 14px;
  display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;
  background:rgba(8,20,45,0.8);border:1px solid rgba(40,100,200,0.25);
  font-size:11px;color:rgba(140,220,255,0.7);transition:all 0.2s;
}
.kiosk-pill:hover{background:rgba(20,50,100,0.6);border-color:rgba(80,180,255,0.4)}
.kiosk-pill .pill-label{color:rgba(80,180,255,0.5);font-size:9px;text-transform:uppercase;letter-spacing:1px}
.kiosk-pill .pill-value{color:rgba(180,230,255,0.85)}
.kiosk-pill .pill-arrow{color:rgba(80,180,255,0.4);font-size:8px}
.link-item{
  display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;
  color:rgba(120,200,255,0.7);font-size:12px;cursor:pointer;user-select:none;
  transition:all 0.15s;margin-bottom:4px;
}
.link-item:hover{background:rgba(20,50,100,0.4);color:rgba(180,230,255,0.9)}
.link-item svg{flex-shrink:0;opacity:0.5}
.link-item:hover svg{opacity:0.8}
.collapse-btn{
  width:24px;height:24px;border-radius:4px;display:flex;align-items:center;justify-content:center;
  cursor:pointer;user-select:none;transition:all 0.15s;color:rgba(80,180,255,0.4);font-size:14px;
}
.collapse-btn:hover{background:rgba(20,50,100,0.4);color:rgba(140,220,255,0.7)}
.panel-toggle{
  position:absolute;top:50%;width:20px;height:48px;
  display:flex;align-items:center;justify-content:center;
  background:rgba(8,20,45,0.9);border:1px solid rgba(40,100,200,0.25);
  cursor:pointer;user-select:none;z-index:15;transition:all 0.2s;
  color:rgba(80,180,255,0.5);font-size:12px;border-radius:0 6px 6px 0;
}
.panel-toggle:hover{background:rgba(20,50,100,0.6);color:rgba(140,220,255,0.8)}
.panel-toggle.right{border-radius:6px 0 0 6px}
#micBtnWrap{
  width:40px;height:40px;border-radius:50%;
  background:rgba(15,40,80,0.6);border:2px solid rgba(40,100,200,0.3);
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;
  transition:all 0.2s;flex-shrink:0;
}

/* ── Status indicators ── */
#statusDot{width:8px;height:8px;border-radius:50%;background:rgba(40,120,220,0.6);transition:background 0.3s}
#statusText{font-size:10px;color:rgba(40,120,220,0.4);font:10px 'Consolas','Courier New',monospace;text-transform:uppercase;letter-spacing:1px;transition:color 0.3s}
#convoLife{font-size:10px;color:rgba(80,180,255,0.4);font-variant-numeric:tabular-nums}
#dbg{position:fixed;top:42px;left:8px;color:rgba(80,180,255,0.3);font:10px monospace;z-index:100;pointer-events:none}

/* ── Model dropdown panels ── */
.model-panel{
  position:absolute;bottom:50px;min-width:160px;z-index:300;display:none;
  background:rgba(5,10,25,0.97);border:1px solid rgba(40,100,200,0.3);
  border-radius:8px;padding:4px 0;font-size:11px;
  backdrop-filter:blur(12px);max-height:280px;overflow-y:auto;
  box-shadow:0 8px 32px rgba(0,0,0,0.6);
}

/* ── Layer 3: Emergency Panel Controls ── */
.bottom-divider{
  width:1px;height:22px;background:rgba(40,100,200,0.2);flex-shrink:0;margin:0 2px;
}
.status-dot{
  width:8px;height:8px;border-radius:50%;flex-shrink:0;transition:background 0.3s;
}
.status-dot.online{background:rgba(60,220,120,0.9)}
.status-dot.offline{background:rgba(255,80,80,0.9)}
.status-dot.warning{background:rgba(255,200,60,0.9)}
.l3-panel{
  position:absolute;bottom:50px;min-width:200px;max-width:340px;z-index:300;display:none;
  background:rgba(5,10,25,0.97);border:1px solid rgba(40,100,200,0.3);
  border-radius:8px;padding:6px 0;font-size:11px;
  backdrop-filter:blur(12px);max-height:360px;overflow-y:auto;
  box-shadow:0 8px 32px rgba(0,0,0,0.6);
}
.l3-panel-header{
  padding:6px 12px;font-size:10px;text-transform:uppercase;letter-spacing:1px;
  color:rgba(80,180,255,0.5);border-bottom:1px solid rgba(40,100,200,0.15);
}
.fleet-row{
  display:flex;align-items:center;gap:8px;padding:6px 12px;
  transition:background 0.15s;
}
.fleet-row:hover{background:rgba(20,50,100,0.3)}
.fleet-name{flex:1;color:rgba(180,230,255,0.85);font-size:11px}
.fleet-meta{font-size:9px;color:rgba(80,180,255,0.4)}
.fleet-restart-btn{
  font-size:9px;padding:2px 8px;border-radius:4px;cursor:pointer;
  background:rgba(20,50,100,0.4);border:1px solid rgba(40,100,200,0.3);
  color:rgba(140,220,255,0.7);transition:all 0.15s;
}
.fleet-restart-btn:hover{background:rgba(40,80,160,0.5);border-color:rgba(80,180,255,0.5)}
.task-item{
  padding:5px 12px;color:rgba(180,230,255,0.75);font-size:11px;line-height:1.4;
  border-left:2px solid transparent;transition:all 0.15s;
}
.task-item:hover{background:rgba(20,50,100,0.2);border-left-color:rgba(80,180,255,0.4)}
.task-section{
  padding:4px 12px 2px;font-size:9px;text-transform:uppercase;letter-spacing:1px;
  color:rgba(80,180,255,0.4);
}
.sys-output{
  padding:8px 12px;font:10px 'Consolas','Courier New',monospace;
  color:rgba(180,230,255,0.8);white-space:pre-wrap;line-height:1.5;
  max-height:300px;overflow-y:auto;
}
.trade-section{
  padding:4px 12px 2px;font-size:9px;text-transform:uppercase;letter-spacing:1px;
  color:rgba(80,180,255,0.4);margin-top:4px;
}
.trade-bot-row{
  display:flex;align-items:center;gap:8px;padding:5px 12px;transition:background 0.15s;
}
.trade-bot-row:hover{background:rgba(20,50,100,0.3)}
.trade-pos-row{
  display:flex;align-items:center;gap:6px;padding:3px 12px 3px 24px;font-size:10px;
  color:rgba(180,230,255,0.7);
}
.trade-pnl-plus{color:rgba(60,220,120,0.9)}
.trade-pnl-minus{color:rgba(255,100,100,0.9)}
.trade-stat{
  display:flex;justify-content:space-between;padding:4px 12px;
  font-size:10px;color:rgba(180,230,255,0.7);
}
@keyframes l3pulse{
  0%,100%{opacity:0.4} 50%{opacity:1}
}
.l3-spinner{
  color:rgba(80,180,255,0.6);font-size:10px;padding:12px;text-align:center;
  animation:l3pulse 1.2s ease-in-out infinite;
}

/* ── Scrollbar ── */
#chatLog::-webkit-scrollbar{width:5px}
#chatLog::-webkit-scrollbar-track{background:transparent}
#chatLog::-webkit-scrollbar-thumb{background:rgba(40,100,200,0.3);border-radius:3px}
#chatLog::-webkit-scrollbar-thumb:hover{background:rgba(80,180,255,0.4)}
#rightPanelContent::-webkit-scrollbar{width:5px}
#rightPanelContent::-webkit-scrollbar-track{background:transparent}
#rightPanelContent::-webkit-scrollbar-thumb{background:rgba(40,100,200,0.3);border-radius:3px}
#chatInput::-webkit-scrollbar{width:4px}
#chatInput::-webkit-scrollbar-track{background:transparent}
#chatInput::-webkit-scrollbar-thumb{background:rgba(40,100,200,0.25);border-radius:2px}
.shortcut-slot.empty{opacity:0.35;border:1px dashed rgba(40,100,200,0.2);border-radius:6px}

/* ── Mic device select ── */
#micDeviceSelect{
  position:fixed;bottom:56px;left:50%;transform:translateX(-50%);width:320px;z-index:400;display:none;
  background:rgba(5,10,25,0.97);color:rgba(140,220,255,0.9);border:1px solid rgba(40,100,200,0.4);
  border-radius:6px;padding:8px;font:12px 'Consolas','Courier New',monospace;outline:none;cursor:pointer;
  box-shadow:0 8px 32px rgba(0,0,0,0.6);
}

/* ── Responsive: portrait/tablet ── */
@media (max-width: 768px) {
  #kioskRoot{flex-direction:column}
  #leftPanel{width:100%;max-width:100%;height:60%;min-width:0;border-right:none;border-bottom:1px solid rgba(40,100,200,0.2)}
  #leftPanel.collapsed{margin-left:0;margin-top:-60%;height:60%}
  #rightPanel{display:none}
  #centerPanel{height:40%}
  .panel-toggle{display:none}
}
@media (max-width: 480px) {
  #leftPanel{height:65%}
  #leftPanel.collapsed{margin-top:-65%;height:65%}
  #centerPanel{height:35%}
  #bottomBar{padding:4px 8px;height:38px}
  .bar-group{gap:6px}
  .kiosk-pill{height:24px;padding:0 10px;font-size:10px}
}
</style>`;
}

// ═══════════════════════════════════════════════
//  HTML BODY
// ═══════════════════════════════════════════════
function generateHTML(): string {
  return `
<!-- Top Bar -->
<div id="topBar">
  <div id="topBarLeft">
    <div id="settingsBtn" class="kiosk-btn" style="width:28px;height:28px" title="Settings">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(120,200,255,0.6)" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
    </div>
  </div>
  <div id="topBarCenter">APEX v21.0</div>
  <div id="topBarRight">
    <div id="statusDot" title="Status"></div>
    <span id="statusText"></span>
    <span id="convoLife"></span>
  </div>
</div>

<!-- Main 3-Column Layout -->
<div id="kioskRoot">

  <!-- Left Panel: Chat -->
  <div id="leftPanel">
    <div id="leftPanelHeader">
      <span>CHAT</span>
      <div class="collapse-btn" id="collapseLeft" title="Collapse chat">&lsaquo;</div>
    </div>
    <div id="chatLog"></div>
    <div id="chatInputBar">
      <textarea id="chatInput" placeholder="Type a message..." autocomplete="off" rows="4"></textarea>
      <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
        <div id="emojiBtn" class="kiosk-btn" style="width:32px;height:32px;background:rgba(40,30,20,0.4);border-color:rgba(200,180,60,0.3)" title="Emoji picker">
          <span style="font-size:16px;line-height:1">&#128578;</span>
        </div>
        <div id="chatScrollBtn" class="kiosk-btn" style="width:32px;height:32px;background:rgba(20,60,40,0.4);border-color:rgba(60,200,120,0.3)" title="Scroll to bottom">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(160,255,200,0.8)" stroke-width="3" stroke-linecap="round"><polyline points="6 8 12 16 18 8"/></svg>
        </div>
        <div id="chatSend" class="kiosk-btn" style="width:32px;height:32px" title="Send">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(140,220,255,0.7)" stroke-width="2" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </div>
      </div>
      <div id="emojiPicker" style="display:none;position:absolute;bottom:100%;right:0;margin-bottom:6px;background:rgba(10,20,40,0.95);border:1px solid rgba(40,100,200,0.25);border-radius:8px;padding:8px;z-index:200;max-width:260px;box-shadow:0 4px 20px rgba(0,0,0,0.5)">
        <div style="display:grid;grid-template-columns:repeat(8,1fr);gap:2px;font-size:20px;cursor:pointer" id="emojiGrid"></div>
      </div>
    </div>
  </div>

  <!-- Left Panel Toggle (visible when collapsed) -->
  <div id="leftToggle" class="panel-toggle" style="left:0;transform:translateY(-50%);display:none" title="Show chat">&#9656;</div>

  <!-- Center Panel: Avatar -->
  <div id="centerPanel">
    <div id="avatarContainer">
      <canvas id="av"></canvas>
    </div>
  </div>

  <!-- Right Panel Toggle (visible when collapsed) -->
  <div id="rightToggle" class="panel-toggle right" style="right:0;transform:translateY(-50%);display:none" title="Show links">&#9666;</div>

  <!-- Right Panel: Quick Links -->
  <div id="rightPanel">
    <div id="rightPanelHeader">
      <span>LINKS</span>
      <div class="collapse-btn" id="collapseRight" title="Collapse links">&rsaquo;</div>
    </div>
    <div id="rightPanelContent">
      <div style="padding:4px 10px 6px;color:rgba(80,140,200,0.4);font-size:10px;text-transform:uppercase;letter-spacing:1px">Shortcuts</div>
      <div class="link-item shortcut-slot" data-slot="0" id="linkFullscreen" title="Toggle fullscreen">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
        <span>Fullscreen</span>
      </div>
      <div class="link-item shortcut-slot" data-slot="1" id="linkMicSettings" title="Mic settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        <span>Mic Device</span>
      </div>
      <div class="link-item shortcut-slot" data-slot="2" id="linkDashboard" title="Open Dashboard">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        <span>Dashboard</span>
      </div>
      <div class="link-item shortcut-slot" data-slot="3" id="linkTradingView" title="Open TradingView">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span>TradingView</span>
      </div>
      <div style="height:1px;background:rgba(40,100,200,0.15);margin:10px 0"></div>
      <div style="padding:4px 10px;color:rgba(80,140,200,0.4);font-size:10px;text-transform:uppercase;letter-spacing:1px">Status</div>
      <div id="rightStatus" style="padding:4px 10px;color:rgba(100,180,240,0.6);font-size:11px;line-height:1.6">
        <div>State: <span id="stateLabel">...</span></div>
        <div>WS: <span id="wsLabel">connecting</span></div>
      </div>
      <div style="height:1px;background:rgba(40,100,200,0.15);margin:10px 0"></div>
      <div style="padding:4px 10px;color:rgba(80,140,200,0.4);font-size:10px;text-transform:uppercase;letter-spacing:1px">Session</div>
      <div id="sessionStats" style="padding:4px 10px;color:rgba(100,180,240,0.6);font-size:11px;line-height:1.8">
        <div>Memories: <span id="statMemories" style="color:rgba(180,220,255,0.8)">--</span></div>
        <div>Context: <span id="statContext" style="color:rgba(180,220,255,0.8)">--</span></div>
        <div style="margin-top:4px">
          <div style="width:100%;height:4px;background:rgba(20,40,80,0.6);border-radius:2px;overflow:hidden">
            <div id="contextBar" style="height:100%;width:0%;background:rgba(80,180,255,0.6);border-radius:2px;transition:width 0.5s"></div>
          </div>
        </div>
        <div style="margin-top:4px;font-size:10px;color:rgba(80,140,200,0.4)">Turns: <span id="statTurns">--</span> &middot; Compactions: <span id="statCompactions">--</span></div>
      </div>
    </div>
  </div>
</div>

<!-- Bottom Bar -->
<div id="bottomBar">
  <!-- Left group: Rain, Paladin, Fleet -->
  <div class="bar-group">
    <div id="matrixToggle" class="kiosk-btn" style="width:28px;height:28px" title="Toggle matrix rain">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(80,200,120,0.6)" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M6 4v16M18 6v12M3 8v8M21 10v4M9 2v20M15 4v16"/></svg>
    </div>
    <div id="paladinBtn" class="kiosk-pill" title="Paladin security engine">
      <span class="status-dot offline" id="paladinDot"></span>
      <span class="pill-label">PAL</span>
      <span id="paladinLabel" class="pill-value" style="font-size:10px">--</span>
    </div>
    <div id="vaultBtn" class="kiosk-pill" title="Browse Vault">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(100,220,180,0.7)" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="pill-label" style="color:rgba(100,220,180,0.7)">VAULT</span>
    </div>
    <div id="fleetBtn" class="kiosk-pill" title="Fleet status">
      <span class="pill-label">FLEET</span>
      <span id="fleetLabel" class="pill-value">--</span>
      <span class="pill-arrow">&#9662;</span>
    </div>
  </div>

  <!-- Center group: Chat, Mic, Code -->
  <div class="bar-group bar-center">
    <div id="chatModelBtn" class="kiosk-pill" title="Switch chat model">
      <span class="pill-label">CHAT</span>
      <span id="chatModelLabel" class="pill-value">Auto</span>
      <span class="pill-arrow">&#9662;</span>
    </div>
    <div id="micBtnWrap" title="Push to talk">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(140,220,255,0.7)" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0014 0"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    </div>
    <div id="coderModelBtn" class="kiosk-pill" title="Switch coder model">
      <span class="pill-label">CODE</span>
      <span id="coderModelLabel" class="pill-value">--</span>
      <span class="pill-arrow">&#9662;</span>
    </div>
  </div>

  <!-- Right group: Content Board, Trading, Tasks, Systems Check -->
  <div class="bar-group">
    <div id="contentBoardBtn" class="kiosk-pill" title="Open Content Board">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(192,132,252,0.7)" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      <span class="pill-label" style="color:rgba(192,132,252,0.7)">CONTENT</span>
    </div>
    <div id="calendarBtn" class="kiosk-pill" title="Calendar">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(80,180,255,0.7)" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span class="pill-label">CAL</span>
    </div>
    <div id="tradingBtn" class="kiosk-pill" title="Trading plugin status">
      <span class="status-dot offline" id="tradingDot"></span>
      <span class="pill-label">TRADE</span>
      <span id="tradingLabel" class="pill-value">--</span>
      <span class="pill-arrow">&#9662;</span>
    </div>
    <div id="tasksBtn" class="kiosk-pill" title="Open tasks">
      <span class="pill-label">TASKS</span>
      <span id="tasksLabel" class="pill-value">--</span>
      <span class="pill-arrow">&#9662;</span>
    </div>
    <div id="sysCheckBtn" class="kiosk-btn" style="width:28px;height:28px" title="Run systems check">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(80,220,200,0.6)" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
    </div>
  </div>
</div>

<!-- Model Dropdown Panels -->
<div id="chatModelPanel" class="model-panel" style="left:50%;transform:translateX(-50%)"></div>
<div id="coderModelPanel" class="model-panel" style="left:50%;transform:translateX(10%)"></div>

<!-- Layer 3 Flyout Panels -->
<div id="paladinPanel" class="l3-panel" style="left:40px"></div>
<div id="fleetPanel" class="l3-panel" style="left:100px"></div>
<div id="sysPanel" class="l3-panel" style="right:10px;min-width:320px"></div>
<div id="tasksPanel" class="l3-panel" style="right:50px"></div>
<div id="tradingPanel" class="l3-panel" style="right:140px;min-width:280px"></div>

<!-- Mic Device Dropdown -->
<select id="micDeviceSelect">
  <option value="">Loading devices...</option>
</select>

<!-- Hidden elements for compat -->
<div id="ttext" style="display:none"></div>
<div id="dbg">v21.0</div>
<div id="status" style="display:none">...</div>`;
}

// ═══════════════════════════════════════════════
//  CORE JS - Constants, state, canvas setup
// ═══════════════════════════════════════════════
function generateCoreJS(): string {
  return `'use strict';

var CLIENT_VERSION = '${AVATAR_VERSION}';
var TARGET_FPS = 12;
var FRAME_MS = 1000 / TARGET_FPS;

// Color palette (blue/cyan theme)
var RAIN_DIM  = [15, 50, 120];
var RAIN_MID  = [40, 120, 220];
var RAIN_HI   = [140, 220, 255];
var EDGE_HI   = [180, 235, 255];
var EDGE_MID  = [60, 170, 245];
var EDGE_DIM  = [25, 90, 190];
var FACE_FILL_HI  = [50, 140, 220];
var FACE_FILL_MID = [25, 80, 160];
var FACE_FILL_DIM = [10, 40, 90];
var HALFTONE = ' .:-=+*#%@';

var RAIN_CHARS = '01';
(function() {
  var k = [0x30A7,0x30A3,0x30A5,0x30A9,0x30AB,0x30AD,0x30AF,0x30B1,0x30B3,0x30B5,0x30B7,0x30B9,0x30BB,0x30BD,0x30BF,0x30C1,0x30C4,0x30C6,0x30C8,0x30CA,0x30CB,0x30CC,0x30CD,0x30CE,0x30CF,0x30D2,0x30D5,0x30D8,0x30DB,0x30DE,0x30DF,0x30E0,0x30E1,0x30E2,0x30E4,0x30E6,0x30E8,0x30E9,0x30EA,0x30EB,0x30EC,0x30ED,0x30EF,0x30F2,0x30F3];
  for (var i = 0; i < k.length; i++) RAIN_CHARS += String.fromCharCode(k[i]);
})();
var RAIN_LEN = RAIN_CHARS.length;
var matrixEnabled = true; // toggle for rain effect

var state = 'screensaver';
var stateChangedAt = 0;
var voiceLevel = 0;
var meta = null, edgeGrid = null, edgeWeight = null, faceMask = null, brightness = null;
var faceImg = null;
var imgReady = false;
var imageReveal = 0;
var IMAGE_FADE_FRAMES = 72;

// Audio system
var audioCtx = null, analyser = null, audioGain = null;
var localVoiceLevel = 0;
var isRecording = false, mediaRecorder = null, audioChunks = [];
var preferredMicId = localStorage.getItem('bot_mic_device') || '';
var textHideTimer = null;
var micBtn = null, ttextEl = null;
var chatPanel = null, chatLog = null, chatInput = null, chatSend = null;
var chatScrollBtn = null;

// Conversation mode streaming
var streamAudioQueue = [];
var streamAudioPlaying = false;
var streamActive = false;
var streamChatDiv = null;
var streamContentEl = null;
var streamTextChunks = [];
var streamTotalChunks = 0;

// Panel state
var leftCollapsed = false;
var rightCollapsed = false;

var canvas = document.getElementById('av');
var ctx = canvas.getContext('2d', { alpha: false });
var dbgEl = document.getElementById('dbg');
var statusEl = document.getElementById('status');
var statusDot = document.getElementById('statusDot');
var statusText = document.getElementById('statusText');
var stateLabel = document.getElementById('stateLabel');
var wsLabel = document.getElementById('wsLabel');`;
}

// ═══════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════
function generateWebSocketJS(): string {
  return `
// ═══ WS ═══
var ws = null, wsRetry = null;
function connectWS() {
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/ws');
  ws.onopen = function() {
    if (wsRetry) { clearTimeout(wsRetry); wsRetry = null; }
    if (statusEl) statusEl.textContent = 'ws:open';
    if (wsLabel) wsLabel.textContent = 'connected';
    if (wsLabel) wsLabel.style.color = 'rgba(80,220,120,0.8)';
  };
  ws.onmessage = function(e) {
    var m = JSON.parse(e.data);
    if (m.type === 'version') {
      if (m.version !== CLIENT_VERSION) {
        if (dbgEl) dbgEl.textContent = 'RELOADING TO ' + m.version + '...';
        setTimeout(function() { location.href = '/?_=' + Date.now(); }, 500);
        return;
      }
    } else if (m.type === 'state') {
      state = m.state;
      stateChangedAt = performance.now();
      if (statusEl) statusEl.textContent = m.state;
      if (stateLabel) stateLabel.textContent = m.state;
      updateStatusColor(m.state);
      // Interruption: new message processing clears any in-progress audio stream
      if (m.state === 'thinking' || m.state === 'materializing') {
        clearAudioQueue();
      }
    } else if (m.type === 'voice_activity') {
      voiceLevel = m.level;
    } else if (m.type === 'audio_play') {
      playKioskAudio(m.audioId);
    } else if (m.type === 'text_response') {
      showResponseText(m.text);
    } else if (m.type === 'text_user') {
      appendChat('user', m.text);
    } else if (m.type === 'text_system') {
      appendChat('system', m.text);
    } else if (m.type === 'stream_start') {
      // Conversation mode: progressive sentence delivery starting
      streamActive = true;
      streamTotalChunks = m.totalChunks || 0;
      streamAudioQueue = [];
      streamAudioPlaying = false;
      streamTextChunks = [];
      startStreamChat();
    } else if (m.type === 'text_chunk') {
      // One sentence of the response text
      streamTextChunks[m.index] = m.text;
      updateStreamChat(m.index, m.text);
    } else if (m.type === 'audio_chunk') {
      // Queue audio chunk for sequential playback
      streamAudioQueue.push({ audioId: m.audioId, index: m.index, total: m.total, isLast: m.isLast });
      if (!streamAudioPlaying) playNextAudioChunk();
    } else if (m.type === 'stream_end') {
      // Server done sending chunks -- finalize when audio queue drains
      streamActive = false;
      if (!streamAudioPlaying && streamAudioQueue.length === 0) {
        finalizeStreamChat();
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio_ended' }));
      }
    }
  };
  ws.onclose = function() {
    if (statusEl) statusEl.textContent = 'ws:closed';
    if (wsLabel) { wsLabel.textContent = 'disconnected'; wsLabel.style.color = 'rgba(220,80,80,0.8)'; }
    wsRetry = setTimeout(connectWS, 3000);
  };
  ws.onerror = function() { try { ws.close(); } catch(e) {} };
}`;
}

// ═══════════════════════════════════════════════
//  STATUS COLORS
// ═══════════════════════════════════════════════
function generateStatusJS(): string {
  return `
// ═══ STATUS COLORS ═══
function updateStatusColor(s) {
  if (statusEl) {
    if (s === 'thinking' || s === 'processing' || s === 'materializing' || s === 'recording') {
      statusEl.style.color = 'rgba(220,50,50,0.7)';
    } else if (s === 'speaking') {
      statusEl.style.color = 'rgba(50,220,80,0.7)';
    } else {
      statusEl.style.color = 'rgba(40,120,220,0.4)';
    }
  }
  // Update status text label in top bar
  if (statusText) {
    statusText.textContent = s;
    if (s === 'thinking' || s === 'processing' || s === 'materializing' || s === 'recording') {
      statusText.style.color = 'rgba(220,60,60,0.7)';
    } else if (s === 'speaking') {
      statusText.style.color = 'rgba(60,220,80,0.7)';
    } else if (s === 'active') {
      statusText.style.color = 'rgba(80,180,255,0.6)';
    } else {
      statusText.style.color = 'rgba(40,120,220,0.4)';
    }
  }
  // Update status dot in top bar
  if (statusDot) {
    if (s === 'thinking' || s === 'processing' || s === 'materializing' || s === 'recording') {
      statusDot.style.background = 'rgba(220,60,60,0.8)';
    } else if (s === 'speaking') {
      statusDot.style.background = 'rgba(60,220,80,0.8)';
    } else if (s === 'active') {
      statusDot.style.background = 'rgba(80,180,255,0.8)';
    } else {
      statusDot.style.background = 'rgba(40,120,220,0.4)';
    }
  }
}`;
}

// ═══════════════════════════════════════════════
//  DATA LOADING + RESIZE
// ═══════════════════════════════════════════════
function generateDataJS(): string {
  return `
// ═══ DATA ═══
function loadData(cb) {
  var stamp = '?_=' + Date.now();
  var loaded = 0;
  var total = 5;
  function check() { loaded++; if (loaded >= total) cb(); }
  function fetchJSON(url, fn) {
    var x = new XMLHttpRequest();
    x.open('GET', url + stamp, true);
    x.onload = function() { if (x.status === 200) fn(JSON.parse(x.responseText)); else { fn(null); } check(); };
    x.onerror = function() { fn(null); check(); };
    x.send();
  }
  fetchJSON('/data/meta.json', function(d) { meta = d; });
  fetchJSON('/data/edge_grid.json', function(d) { edgeGrid = d; });
  fetchJSON('/data/edge_weight.json', function(d) { edgeWeight = d; });
  fetchJSON('/data/face_mask.json', function(d) { faceMask = d; });
  fetchJSON('/data/brightness.json', function(d) { brightness = d; });
}

function resize() {
  if (!meta) return;
  var container = document.getElementById('avatarContainer');
  if (!container) return;
  var sw = container.clientWidth, sh = container.clientHeight;
  if (sw < 10 || sh < 10) return;
  var da = meta.canvasW / meta.canvasH, sa = sw / sh;
  if (sa > da) { canvas.height = sh; canvas.width = Math.round(sh * da); }
  else { canvas.width = sw; canvas.height = Math.round(sw / da); }
}`;
}

// ═══════════════════════════════════════════════
//  FACE OPACITY
// ═══════════════════════════════════════════════
function generateVisibilityJS(): string {
  return `
// ═══ VISIBILITY ═══
function faceOpacity() {
  var t = performance.now() - stateChangedAt;
  switch (state) {
    case 'screensaver': return 0.2;
    case 'materializing': return Math.min(1, 0.2 + 0.8 * (t / 3000));
    case 'active': case 'speaking': case 'thinking': return 1;
    case 'shutdown': return Math.max(0.2, 1 - 0.8 * (t / 8000));
    default: return 0.2;
  }
}`;
}

// ═══════════════════════════════════════════════
//  RAIN SYSTEM
// ═══════════════════════════════════════════════
function generateRainJS(): string {
  return `
// ═══ RAIN ═══
function Col(x, h) { this.x = x; this.h = h; this.reset(); }
Col.prototype.reset = function() {
  this.y = -Math.floor(Math.random() * this.h) - 1;
  this.spd = 0.3 + Math.random() * 0.9;
  this.len = 4 + (Math.random() * 14 | 0);
  this.ch = [];
  for (var i = 0; i < this.len; i++) this.ch.push(RAIN_CHARS[Math.random() * RAIN_LEN | 0]);
  this.on = true;
};
Col.prototype.tick = function() {
  this.y += this.spd;
  if (this.y - this.len > this.h) { if (Math.random() < 0.4) this.reset(); else this.on = false; }
  if (Math.random() < 0.15 && this.ch.length > 0) this.ch[Math.random() * this.ch.length | 0] = RAIN_CHARS[Math.random() * RAIN_LEN | 0];
};

var cols = [];
function initRain() {
  cols = [];
  for (var x = 0; x < meta.gridW; x++) {
    var n = 1 + (Math.random() * 3 | 0);
    for (var s = 0; s < n; s++) cols.push(new Col(x, meta.gridH));
  }
}`;
}

// ═══════════════════════════════════════════════
//  AUDIO FUNCTIONS
// ═══════════════════════════════════════════════
function generateAudioJS(): string {
  return `
// ═══ AUDIO FUNCTIONS ═══
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    audioGain = audioCtx.createGain();
    audioGain.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playKioskAudio(audioId) {
  ensureAudio();
  var x = new XMLHttpRequest();
  x.open('GET', '/audio/' + audioId, true);
  x.responseType = 'arraybuffer';
  x.onload = function() {
    if (x.status !== 200) { if (statusEl) statusEl.textContent = 'audio err ' + x.status; return; }
    audioCtx.decodeAudioData(x.response, function(buffer) {
      var src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioGain);
      src.start();
      if (statusEl) { statusEl.textContent = 'speaking'; } updateStatusColor('speaking');
      src.onended = function() {
        localVoiceLevel = 0;
        if (statusEl) { statusEl.textContent = 'active'; } updateStatusColor('active');
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'audio_ended' }));
        }
      };
    }, function(err) {
      if (statusEl) statusEl.textContent = 'decode err';
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'audio_ended' }));
      }
    });
  };
  x.onerror = function() { if (statusEl) statusEl.textContent = 'audio fetch err'; };
  x.send();
}

function pollAmplitude() {
  if (analyser && audioCtx && audioCtx.state === 'running') {
    var data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    var sum = 0;
    for (var i = 0; i < data.length; i++) sum += data[i];
    localVoiceLevel = Math.min(1, (sum / data.length) / 128);
  } else {
    localVoiceLevel *= 0.9;
  }
  requestAnimationFrame(pollAmplitude);
}

function showResponseText(text) {
  appendChat('bot', text);
}

// ═══ AUDIO QUEUE (Conversation Mode) ═══
function playNextAudioChunk() {
  if (streamAudioQueue.length === 0) {
    streamAudioPlaying = false;
    // If stream is done and queue is empty, finalize
    if (!streamActive) {
      finalizeStreamChat();
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio_ended' }));
      if (statusEl) statusEl.textContent = 'active';
      updateStatusColor('active');
    }
    return;
  }
  streamAudioPlaying = true;
  var chunk = streamAudioQueue.shift();
  ensureAudio();
  var x = new XMLHttpRequest();
  x.open('GET', '/audio/' + chunk.audioId, true);
  x.responseType = 'arraybuffer';
  x.onload = function() {
    if (x.status !== 200) {
      // Skip failed chunk, try next
      playNextAudioChunk();
      return;
    }
    audioCtx.decodeAudioData(x.response, function(buffer) {
      var src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioGain);
      src.start();
      if (statusEl) statusEl.textContent = 'speaking';
      updateStatusColor('speaking');
      src.onended = function() {
        localVoiceLevel = 0;
        playNextAudioChunk();
      };
    }, function(err) {
      // Decode error, skip to next
      playNextAudioChunk();
    });
  };
  x.onerror = function() { playNextAudioChunk(); };
  x.send();
}

function clearAudioQueue() {
  streamAudioQueue = [];
  streamAudioPlaying = false;
  streamActive = false;
  streamTextChunks = [];
}`;
}

// ═══════════════════════════════════════════════
//  CHAT FUNCTIONS
// ═══════════════════════════════════════════════
function generateChatJS(): string {
  return `
// ═══ CHAT FUNCTIONS ═══
function appendChat(sender, text, fromHistory, ts) {
  if (!chatLog) return;
  var div = document.createElement('div');
  div.style.marginBottom = '8px';
  div.style.lineHeight = '1.5';
  div.style.paddingBottom = '8px';
  div.style.borderBottom = '1px solid rgba(40,100,200,0.08)';
  var label = document.createElement('div');
  label.style.fontWeight = 'bold';
  label.style.marginBottom = '2px';
  label.style.fontSize = '11px';
  label.style.textTransform = 'uppercase';
  label.style.letterSpacing = '0.5px';
  if (sender === 'bot') {
    label.style.color = 'rgba(180,100,255,0.9)';
    label.textContent = 'Bot';
  } else if (sender === 'user') {
    label.style.color = 'rgba(100,255,180,0.9)';
    label.textContent = 'You';
  } else if (sender === 'system') {
    label.style.color = 'rgba(220,50,50,0.9)';
    label.textContent = 'SYSTEM';
  } else {
    label.style.color = 'rgba(80,200,255,0.9)';
    label.textContent = sender;
  }
  div.appendChild(label);
  var content = document.createElement('div');
  content.style.whiteSpace = 'pre-wrap';
  content.style.wordWrap = 'break-word';
  content.style.fontSize = '13px';
  content.textContent = text;
  if (sender === 'system') content.style.color = 'rgba(220,80,80,0.85)';
  div.appendChild(content);
  var stamp = document.createElement('div');
  stamp.style.fontSize = '10px';
  stamp.style.color = 'rgba(100,160,220,0.45)';
  stamp.style.marginTop = '3px';
  stamp.style.textAlign = 'right';
  var d = ts ? new Date(ts) : new Date();
  var h = d.getHours(); var ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  var min = ('0' + d.getMinutes()).slice(-2);
  stamp.textContent = h + ':' + min + ' ' + ampm;
  div.appendChild(stamp);
  var wasAtBottom = !chatLog.lastElementChild || (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60);
  chatLog.appendChild(div);
  if (wasAtBottom || fromHistory) {
    chatLog.scrollTop = chatLog.scrollHeight;
    if (chatScrollBtn) { chatScrollBtn.style.opacity = '0.5'; chatScrollBtn.style.background = 'rgba(20,60,40,0.4)'; }
  } else if (chatScrollBtn) {
    chatScrollBtn.style.opacity = '1'; chatScrollBtn.style.background = 'rgba(40,180,80,0.6)'; chatScrollBtn.style.borderColor = 'rgba(60,200,120,0.8)';
  }
  if (!fromHistory) saveChatMessage(sender, text);
}

function sendChatText() {
  if (!chatInput || !chatInput.value.trim()) return;
  var text = chatInput.value.trim();
  chatInput.value = '';
  appendChat('user', text);
  if (statusEl) { statusEl.textContent = 'processing'; } updateStatusColor('processing');
  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/text', true);
  x.setRequestHeader('Content-Type', 'application/json');
  x.onload = function() {
    if (x.status === 200) { if (statusEl) statusEl.textContent = 'thinking'; updateStatusColor('thinking'); }
    else { appendChat('bot', '[send error ' + x.status + ']'); }
  };
  x.onerror = function() { appendChat('bot', '[connection error]'); };
  x.send(JSON.stringify({ text: text }));
}

// ═══ PROGRESSIVE TEXT (Conversation Mode) ═══
function startStreamChat() {
  if (!chatLog) return;
  streamChatDiv = document.createElement('div');
  streamChatDiv.style.marginBottom = '8px';
  streamChatDiv.style.lineHeight = '1.5';
  streamChatDiv.style.paddingBottom = '8px';
  streamChatDiv.style.borderBottom = '1px solid rgba(40,100,200,0.08)';
  var label = document.createElement('div');
  label.style.fontWeight = 'bold';
  label.style.marginBottom = '2px';
  label.style.fontSize = '11px';
  label.style.textTransform = 'uppercase';
  label.style.letterSpacing = '0.5px';
  label.style.color = 'rgba(180,100,255,0.9)';
  label.textContent = 'Bot';
  streamChatDiv.appendChild(label);
  streamContentEl = document.createElement('div');
  streamContentEl.style.whiteSpace = 'pre-wrap';
  streamContentEl.style.wordWrap = 'break-word';
  streamContentEl.style.fontSize = '13px';
  streamContentEl.textContent = '';
  streamChatDiv.appendChild(streamContentEl);
  var wasAtBottom = !chatLog.lastElementChild || (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60);
  chatLog.appendChild(streamChatDiv);
  if (wasAtBottom) chatLog.scrollTop = chatLog.scrollHeight;
}

function updateStreamChat(index, text) {
  if (!streamContentEl) return;
  // Build full text from all received chunks so far
  var fullText = '';
  for (var i = 0; i <= index; i++) {
    if (streamTextChunks[i]) {
      if (fullText.length > 0) fullText += ' ';
      fullText += streamTextChunks[i];
    }
  }
  streamContentEl.textContent = fullText;
  // Auto-scroll if near bottom
  if (chatLog) {
    var atBottom = (chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 80);
    if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }
}

function finalizeStreamChat() {
  if (!streamChatDiv) return;
  // Add timestamp
  var stamp = document.createElement('div');
  stamp.style.fontSize = '10px';
  stamp.style.color = 'rgba(100,160,220,0.45)';
  stamp.style.marginTop = '3px';
  stamp.style.textAlign = 'right';
  var d = new Date();
  var h = d.getHours(); var ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  var min = ('0' + d.getMinutes()).slice(-2);
  stamp.textContent = h + ':' + min + ' ' + ampm;
  streamChatDiv.appendChild(stamp);
  // Save full text to chat history
  var fullText = streamTextChunks.join(' ');
  if (fullText.trim()) saveChatMessage('bot', fullText);
  // Cleanup
  streamChatDiv = null;
  streamContentEl = null;
  streamTextChunks = [];
  streamTotalChunks = 0;
}`;
}

// ═══════════════════════════════════════════════
//  VOICE / VAD / MIC CAPTURE
// ═══════════════════════════════════════════════
function generateVoiceJS(): string {
  return `
// ═══ MIC CAPTURE + VAD ═══
var vadStream = null;
var vadAnalyser = null;
var vadSourceNode = null;
var vadListening = false;
var vadSilenceStart = 0;
var vadRecordStart = 0;
var vadCooldownUntil = 0;
var vadManualOverride = false;
var micButtonActive = false;
var lastMicToggle = 0;
var lastAudioActivity = 0;
var micFailCount = 0;
var recordPeakLevel = 0;
var VAD_THRESHOLD = 0.08;
var VAD_SILENCE_MS = 1500;
var VAD_MIN_MS = 800;
var VAD_COOLDOWN_MS = 2000;

function getVADLevel() {
  if (!vadAnalyser) return 0;
  var data = new Uint8Array(vadAnalyser.frequencyBinCount);
  vadAnalyser.getByteFrequencyData(data);
  var sum = 0;
  for (var i = 0; i < data.length; i++) sum += data[i];
  return Math.min(1, (sum / data.length) / 128);
}

function vadCanListen() {
  var now = Date.now();
  return vadListening && !vadManualOverride
    && state !== 'speaking' && state !== 'thinking'
    && state !== 'processing' && state !== 'materializing'
    && now >= vadCooldownUntil;
}

function vadLoop() {
  if (!vadStream) return;
  var now = Date.now();
  var level = getVADLevel();

  if (level > 0.02) lastAudioActivity = now;

  // MIC-BUTTON recording
  if (isRecording && micButtonActive) {
    if (level > recordPeakLevel) recordPeakLevel = level;
    if (micBtn) {
      var glow = Math.floor(level * 25);
      var r = Math.min(255, 180 + Math.floor(level * 75));
      var gb = Math.floor(30 + level * 60);
      micBtn.style.background = 'rgba(' + r + ',' + gb + ',' + gb + ',0.6)';
      micBtn.style.boxShadow = level > 0.05 ? '0 0 ' + (8 + glow) + 'px rgba(255,60,60,' + (0.3 + level * 0.5).toFixed(2) + ')' : '0 0 8px rgba(255,60,60,0.2)';
    }
    if (statusEl) statusEl.textContent = 'recording ' + level.toFixed(2);
    if (level > VAD_THRESHOLD * 0.5) {
      vadSilenceStart = 0;
    } else {
      if (vadSilenceStart === 0) {
        vadSilenceStart = now;
      } else if (now - vadSilenceStart > 3000 && now - vadRecordStart > 2000) {
        micButtonActive = false;
        stopRecording();
        vadCooldownUntil = now + VAD_COOLDOWN_MS;
      }
    }
    requestAnimationFrame(vadLoop);
    return;
  }

  // SPACEBAR recording
  if (isRecording && vadManualOverride) {
    if (micBtn) {
      var glow = Math.floor(level * 25);
      var r = Math.min(255, 180 + Math.floor(level * 75));
      var gb = Math.floor(30 + level * 60);
      micBtn.style.background = 'rgba(' + r + ',' + gb + ',' + gb + ',0.6)';
      micBtn.style.boxShadow = level > 0.05 ? '0 0 ' + (8 + glow) + 'px rgba(255,60,60,' + (0.3 + level * 0.5).toFixed(2) + ')' : '0 0 8px rgba(255,60,60,0.2)';
    }
    requestAnimationFrame(vadLoop);
    return;
  }

  // VAD auto-listen mode (state-gated)
  if (micBtn && vadCanListen() && !isRecording) {
    var g = Math.min(255, 80 + Math.floor(level * 400));
    micBtn.style.background = 'rgba(15,' + Math.floor(40 + level * 60) + ',60,0.5)';
    micBtn.style.borderColor = 'rgba(40,' + g + ',120,0.3)';
  }

  if (micBtn && isRecording) {
    var glow = Math.floor(level * 25);
    var r = Math.min(255, 180 + Math.floor(level * 75));
    var gb = Math.floor(30 + level * 60);
    micBtn.style.background = 'rgba(' + r + ',' + gb + ',' + gb + ',0.6)';
    micBtn.style.boxShadow = level > 0.05 ? '0 0 ' + (8 + glow) + 'px rgba(255,60,60,' + (0.3 + level * 0.5).toFixed(2) + ')' : '0 0 8px rgba(255,60,60,0.2)';
  }

  if (!vadCanListen()) {
    if (isRecording && !vadManualOverride && !micButtonActive) stopRecording();
    if (micBtn && !isRecording && !vadManualOverride) {
      micBtn.style.background = 'rgba(15,40,80,0.6)';
      micBtn.style.borderColor = 'rgba(40,100,200,0.3)';
    }
    requestAnimationFrame(vadLoop);
    return;
  }

  if (isRecording && !vadManualOverride && !micButtonActive) {
    if (level > VAD_THRESHOLD * 0.7) {
      vadSilenceStart = 0;
    } else {
      if (vadSilenceStart === 0) {
        vadSilenceStart = now;
      } else if (now - vadSilenceStart > VAD_SILENCE_MS && now - vadRecordStart > VAD_MIN_MS) {
        stopRecording();
        vadCooldownUntil = now + VAD_COOLDOWN_MS;
      }
    }
  }

  requestAnimationFrame(vadLoop);
}

function initVAD(onReady) {
  if (vadListening && vadStream) { if (onReady) onReady(); return; }
  ensureAudio();
  var audioConstraints = preferredMicId ? { deviceId: { exact: preferredMicId } } : true;
  navigator.mediaDevices.getUserMedia({ audio: audioConstraints }).then(function(stream) {
    vadStream = stream;
    vadSourceNode = audioCtx.createMediaStreamSource(stream);
    vadAnalyser = audioCtx.createAnalyser();
    vadAnalyser.fftSize = 256;
    vadSourceNode.connect(vadAnalyser);
    vadListening = true;
    var tracks = stream.getAudioTracks();
    if (tracks.length > 0) {
      var settings = tracks[0].getSettings();
      var label = tracks[0].label || 'unknown';
      appendChat('system', 'Mic: ' + label + (settings.sampleRate ? ' (' + settings.sampleRate + 'Hz)' : ''));
    }
    if (micBtn) {
      micBtn.style.background = 'rgba(15,60,40,0.5)';
      micBtn.style.borderColor = 'rgba(40,200,100,0.3)';
    }
    if (statusEl) statusEl.textContent = 'listening';
    requestAnimationFrame(vadLoop);
    if (onReady) onReady();
  }).catch(function(err) {
    if (statusEl) statusEl.textContent = 'vad: ' + err.message;
    appendChat('system', 'Mic error: ' + err.message);
  });
}

function isStreamAlive(stream) {
  if (!stream) return false;
  var tracks = stream.getAudioTracks();
  return tracks.length > 0 && tracks[0].readyState === 'live' && tracks[0].enabled;
}

function reinitStream(cb) {
  if (vadStream) {
    try { vadStream.getAudioTracks().forEach(function(t) { t.stop(); }); } catch(e) {}
  }
  vadStream = null;
  vadListening = false;
  vadAnalyser = null;
  vadSourceNode = null;
  lastAudioActivity = 0;
  if (statusEl) statusEl.textContent = 'mic: reconnecting...';
  initVAD(cb);
}

function startRecording() {
  if (isRecording) return;
  ensureAudio();
  var stream = vadStream;
  if (!stream) {
    if (statusEl) statusEl.textContent = 'mic: starting...';
    initVAD(function() { startRecording(); });
    return;
  }
  if (!isStreamAlive(stream)) {
    if (statusEl) statusEl.textContent = 'mic dead -- reinitializing...';
    appendChat('system', 'Mic track dead. Reinitializing... tap mic again after.');
    reinitStream(null);
    return;
  }
  var now = Date.now();
  if (lastAudioActivity > 0 && now - lastAudioActivity > 60000) {
    if (statusEl) statusEl.textContent = 'mic stale -- refreshing...';
    appendChat('system', 'Mic stream stale (no audio in 60s). Refreshing... tap mic again after.');
    micFailCount = 0;
    reinitStream(null);
    return;
  }
  if (micFailCount >= 2) {
    if (statusEl) statusEl.textContent = 'mic retry -- full reinit...';
    appendChat('system', 'Multiple failures. Full mic reinit... tap mic again after.');
    micFailCount = 0;
    reinitStream(null);
    return;
  }
  var options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options = { mimeType: 'audio/webm' };
  }
  mediaRecorder = new MediaRecorder(stream, options);
  audioChunks = [];
  mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = function() {
    var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    var peakReport = recordPeakLevel.toFixed(3);
    recordPeakLevel = 0;
    if (blob.size > 5000) {
      micFailCount = 0;
      appendChat('system', 'Sent ' + (blob.size/1024).toFixed(1) + 'KB, peak: ' + peakReport);
      sendVoice(blob);
    } else {
      micButtonActive = false;
      micFailCount++;
      if (micFailCount >= 2 || !isStreamAlive(vadStream)) {
        if (statusEl) statusEl.textContent = 'mic not capturing -- reinitializing...';
        updateStatusColor('active');
        appendChat('system', 'Mic not capturing audio. Reinitializing... tap mic again after.');
        reinitStream(null);
      } else {
        if (statusEl) statusEl.textContent = 'no voice detected (' + blob.size + 'b)';
        updateStatusColor('active');
        appendChat('system', 'No voice detected (' + blob.size + 'b). Tap mic to try again.');
      }
    }
    if (micBtn) micBtn.style.boxShadow = 'none';
  };
  mediaRecorder.start(100);
  isRecording = true;
  if (micBtn) { micBtn.style.background = 'rgba(200,40,40,0.6)'; micBtn.style.borderColor = 'rgba(255,80,80,0.8)'; }
  if (statusEl) { statusEl.textContent = 'recording'; } updateStatusColor('recording');
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  try { mediaRecorder.stop(); } catch(e) {}
  if (micBtn) {
    micBtn.style.background = 'rgba(15,40,80,0.6)';
    micBtn.style.borderColor = 'rgba(40,100,200,0.3)';
    micBtn.style.boxShadow = 'none';
  }
  if (statusEl) { statusEl.textContent = 'processing'; } updateStatusColor('processing');
}

function sendVoice(blob) {
  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/voice', true);
  x.setRequestHeader('Content-Type', blob.type || 'audio/webm');
  x.onload = function() {
    if (x.status === 200) { if (statusEl) statusEl.textContent = 'thinking'; updateStatusColor('thinking'); }
    else { if (statusEl) statusEl.textContent = 'send err ' + x.status; }
  };
  x.onerror = function() { if (statusEl) statusEl.textContent = 'send err'; };
  x.send(blob);
}`;
}

// ═══════════════════════════════════════════════
//  CANVAS RENDER
// ═══════════════════════════════════════════════
function generateRenderJS(): string {
  return `
// ═══ RENDER ═══
var rGrid = null, rInt = null;
function allocGrids() {
  rGrid = []; rInt = [];
  for (var y = 0; y < meta.gridH; y++) {
    rGrid.push(new Array(meta.gridW)); rInt.push(new Array(meta.gridW));
    for (var x = 0; x < meta.gridW; x++) { rGrid[y][x] = ''; rInt[y][x] = 0; }
  }
}

var fc = 0;
function render() {
  if (!meta || !edgeGrid || !edgeWeight || !faceMask) return;
  fc++;
  var gw = meta.gridW, gh = meta.gridH;
  var scX = canvas.width / meta.canvasW, scY = canvas.height / meta.canvasH;
  var cw = meta.charW * scX, ch = meta.charH * scY;

  ctx.fillStyle = 'rgb(2,2,5)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  var fs = Math.max(7, Math.round(12 * scY));
  ctx.font = fs + 'px Consolas,"Courier New",monospace';
  ctx.textBaseline = 'top';

  var fOp = faceOpacity();
  var phase = (fc % (TARGET_FPS * 8)) / (TARGET_FPS * 8);
  var breathVal = 0.82 + 0.18 * Math.sin(fc * 0.06);
  var voicePulse = 1.0 + Math.max(voiceLevel, localVoiceLevel) * 0.3;

  // Tick rain
  for (var i = 0; i < cols.length; i++) { cols[i].tick(); if (!cols[i].on) cols[i].reset(); }

  // Build rain grid
  for (var y = 0; y < gh; y++) for (var x = 0; x < gw; x++) { rGrid[y][x] = ''; rInt[y][x] = 0; }
  if (matrixEnabled) {
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i], hy = c.y | 0;
      for (var t = 0; t < c.len; t++) {
        var ry = hy - t;
        if (ry >= 0 && ry < gh && c.x >= 0 && c.x < gw) {
          var fade = 1.0 - t / c.len;
          rGrid[ry][c.x] = c.ch[t % c.ch.length];
          rInt[ry][c.x] = t === 0 ? fade * 0.9 : fade * 0.4;
        }
      }
    }
  }

  // Dim rain inside face mask
  for (var y = 0; y < gh; y++) {
    if (!faceMask[y]) continue;
    for (var x = 0; x < gw; x++) {
      if (faceMask[y][x] === 1 && rInt[y][x] > 0) {
        rInt[y][x] *= (1.0 - fOp * 0.45);
      }
    }
  }

  // Draw rain
  for (var y = 0; y < gh; y++) {
    var py = y * ch;
    for (var x = 0; x < gw; x++) {
      if (rInt[y][x] > 0) {
        var ri = rInt[y][x];
        var r, g, b;
        if (ri > 0.7) { r = RAIN_HI[0]*ri|0; g = RAIN_HI[1]*ri|0; b = RAIN_HI[2]*ri|0; }
        else if (ri > 0.2) { r = RAIN_MID[0]*ri|0; g = RAIN_MID[1]*ri|0; b = RAIN_MID[2]*ri|0; }
        else { var m = Math.max(0.3, ri); r = RAIN_DIM[0]*m|0; g = RAIN_DIM[1]*m|0; b = RAIN_DIM[2]*m|0; }
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillText(rGrid[y][x], x * cw, py);
      }
    }
  }

  // Face halftone fill
  if (fOp > 0.05 && brightness) {
    ctx.globalAlpha = fOp * 0.7;
    for (var y = 0; y < gh; y++) {
      if (!faceMask[y] || !brightness[y]) continue;
      var py = y * ch;
      for (var x = 0; x < gw; x++) {
        if (faceMask[y][x] === 1 && edgeWeight[y][x] === 0) {
          var bv = brightness[y][x];
          if (bv < 0.08) continue;
          var bi = bv * breathVal * voicePulse;
          if (bi > 1) bi = 1;
          var ci = Math.min(HALFTONE.length - 1, bi * HALFTONE.length | 0);
          var hc = HALFTONE[ci];
          if (hc === ' ') continue;
          var r, g, b;
          if (bv > 0.6) {
            r = FACE_FILL_HI[0] * bi | 0; g = FACE_FILL_HI[1] * bi | 0; b = FACE_FILL_HI[2] * bi | 0;
          } else if (bv > 0.3) {
            r = FACE_FILL_MID[0] * bi | 0; g = FACE_FILL_MID[1] * bi | 0; b = FACE_FILL_MID[2] * bi | 0;
          } else {
            r = FACE_FILL_DIM[0] * bi | 0; g = FACE_FILL_DIM[1] * bi | 0; b = FACE_FILL_DIM[2] * bi | 0;
          }
          ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
          ctx.fillText(hc, x * cw, py);
        }
      }
    }
    ctx.globalAlpha = 1.0;
  }

  // Face edges
  if (fOp > 0.05) {
    ctx.globalAlpha = fOp;
    for (var y = 0; y < gh; y++) {
      if (!edgeGrid[y] || !edgeWeight[y]) continue;
      var py = y * ch;
      for (var x = 0; x < gw; x++) {
        var ew = edgeWeight[y][x];
        if (ew > 0 && edgeGrid[y][x]) {
          var ei = ew * breathVal * voicePulse;
          if (ei > 1) ei = 1;
          var r, g, b;
          if (ew > 0.7) {
            r = EDGE_HI[0] * ei | 0; g = EDGE_HI[1] * ei | 0; b = EDGE_HI[2] * ei | 0;
          } else if (ew > 0.3) {
            r = EDGE_MID[0] * ei | 0; g = EDGE_MID[1] * ei | 0; b = EDGE_MID[2] * ei | 0;
          } else {
            r = EDGE_DIM[0] * ei | 0; g = EDGE_DIM[1] * ei | 0; b = EDGE_DIM[2] * ei | 0;
          }
          ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
          ctx.fillText(edgeGrid[y][x], x * cw, py);
        }
      }
    }
    ctx.globalAlpha = 1.0;
  }

  // Face image reveal
  if (imgReady && faceImg) {
    var wantImage = (state === 'active' || state === 'speaking' || state === 'thinking' || state === 'materializing') ? 1 : 0;
    if (state === 'shutdown') wantImage = 0;
    if (state === 'screensaver') { imageReveal = 0; wantImage = 0; }

    if (wantImage && imageReveal < 0.55) {
      imageReveal += 1.0 / IMAGE_FADE_FRAMES;
      if (imageReveal > 0.55) imageReveal = 0.55;
    } else if (!wantImage && imageReveal > 0) {
      imageReveal -= 1.0 / IMAGE_FADE_FRAMES;
      if (imageReveal < 0) imageReveal = 0;
    }

    if (imageReveal > 0.01) {
      ctx.globalAlpha = imageReveal * fOp;
      var imgAsp = faceImg.width / faceImg.height;
      var canAsp = canvas.width / canvas.height;
      var dw, dh, dx, dy;
      if (canAsp > imgAsp) {
        dh = canvas.height; dw = dh * imgAsp;
        dx = (canvas.width - dw) / 2; dy = 0;
      } else {
        dw = canvas.width; dh = dw / imgAsp;
        dx = 0; dy = (canvas.height - dh) / 2;
      }
      ctx.drawImage(faceImg, dx, dy, dw, dh);
      ctx.globalAlpha = 1.0;
    }
  }

  // Scan line
  var scanY = ((phase * 1.5) % 1.0) * canvas.height | 0;
  ctx.fillStyle = 'rgba(80,180,255,0.12)';
  ctx.fillRect(0, scanY - 15, canvas.width, 30);

  // CRT scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  for (var sy = 0; sy < canvas.height; sy += 3) ctx.fillRect(0, sy, canvas.width, 1);

  // Debug HUD
  if (fc % 12 === 0 && dbgEl) {
    dbgEl.textContent = state + ' | fOp:' + fOp.toFixed(2) + ' | img:' + imageReveal.toFixed(2);
  }
}`;
}

// ═══════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════
function generateInitJS(): string {
  return `
// ═══ INIT ═══
function init() {
  if (dbgEl) dbgEl.textContent = 'v21.0 LOADING DATA...';
  loadData(function() {
    if (!meta || !edgeGrid || !edgeWeight || !faceMask) {
      if (dbgEl) dbgEl.textContent = 'v21.0 DATA LOAD FAILED';
      return;
    }
    if (dbgEl) dbgEl.textContent = 'v21.0 STARTING...';
    faceImg = new Image();
    faceImg.onload = function() { imgReady = true; };
    faceImg.src = '/face.jpg?_=' + Date.now();
    resize();
    window.addEventListener('resize', resize);
    allocGrids();
    initRain();
    connectWS();
    var last = 0;
    function loop(ts) { if (ts - last >= FRAME_MS) { last = ts; render(); } requestAnimationFrame(loop); }
    requestAnimationFrame(loop);
  });
}

try { init(); } catch(e) { if (dbgEl) dbgEl.textContent = 'v21.0 CRASH: ' + e.message; }`;
}

// ═══════════════════════════════════════════════
//  I/O SETUP - DOM refs, chat persistence, panels, events
// ═══════════════════════════════════════════════
function generateIOSetupJS(): string {
  return `
// ═══ KIOSK I/O SETUP ═══
ttextEl = document.getElementById('ttext');
micBtn = document.getElementById('micBtnWrap');
chatLog = document.getElementById('chatLog');
chatInput = document.getElementById('chatInput');
chatSend = document.getElementById('chatSend');
chatScrollBtn = document.getElementById('chatScrollBtn');

// ═══ PANEL COLLAPSE ═══
var leftPanel = document.getElementById('leftPanel');
var rightPanel = document.getElementById('rightPanel');
var collapseLeftBtn = document.getElementById('collapseLeft');
var collapseRightBtn = document.getElementById('collapseRight');
var leftToggle = document.getElementById('leftToggle');
var rightToggle = document.getElementById('rightToggle');

// Restore panel state from localStorage
leftCollapsed = localStorage.getItem('bot_kiosk_left_collapsed') === 'true';
rightCollapsed = localStorage.getItem('bot_kiosk_right_collapsed') === 'true';

function updatePanels() {
  if (leftPanel) {
    if (leftCollapsed) { leftPanel.classList.add('collapsed'); } else { leftPanel.classList.remove('collapsed'); }
  }
  if (leftToggle) leftToggle.style.display = leftCollapsed ? 'flex' : 'none';
  if (rightPanel) {
    if (rightCollapsed) { rightPanel.classList.add('collapsed'); } else { rightPanel.classList.remove('collapsed'); }
  }
  if (rightToggle) rightToggle.style.display = rightCollapsed ? 'flex' : 'none';
  // Re-fit canvas after panel toggle
  setTimeout(resize, 350);
}
updatePanels();

if (collapseLeftBtn) {
  collapseLeftBtn.addEventListener('click', function() {
    leftCollapsed = true;
    localStorage.setItem('bot_kiosk_left_collapsed', 'true');
    updatePanels();
  });
}
if (leftToggle) {
  leftToggle.addEventListener('click', function() {
    leftCollapsed = false;
    localStorage.setItem('bot_kiosk_left_collapsed', 'false');
    updatePanels();
    if (chatInput) chatInput.focus();
  });
}
if (collapseRightBtn) {
  collapseRightBtn.addEventListener('click', function() {
    rightCollapsed = true;
    localStorage.setItem('bot_kiosk_right_collapsed', 'true');
    updatePanels();
  });
}
if (rightToggle) {
  rightToggle.addEventListener('click', function() {
    rightCollapsed = false;
    localStorage.setItem('bot_kiosk_right_collapsed', 'false');
    updatePanels();
  });
}

// ═══ QUICK LINKS ═══
var linkFullscreen = document.getElementById('linkFullscreen');
if (linkFullscreen) {
  linkFullscreen.addEventListener('click', function() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(function(){});
    } else {
      document.exitFullscreen().catch(function(){});
    }
  });
}
var linkDashboard = document.getElementById('linkDashboard');
if (linkDashboard) {
  linkDashboard.addEventListener('click', function() {
    var dashPort = window.__BOT_DASHBOARD_PORT || 3141;
    var url = location.protocol + '//' + location.hostname + ':' + dashPort + '/';
    window.open(url, '_blank');
  });
}
var linkTradingView = document.getElementById('linkTradingView');
if (linkTradingView) {
  linkTradingView.addEventListener('click', function() {
    window.open('https://www.tradingview.com/chart/', '_blank');
  });
}

// ═══ MATRIX TOGGLE ═══
var matrixToggleBtn = document.getElementById('matrixToggle');
if (matrixToggleBtn) {
  matrixToggleBtn.addEventListener('click', function() {
    matrixEnabled = !matrixEnabled;
    matrixToggleBtn.style.borderColor = matrixEnabled ? 'rgba(40,100,200,0.25)' : 'rgba(200,60,60,0.4)';
    matrixToggleBtn.style.opacity = matrixEnabled ? '1' : '0.5';
  });
}

// ═══ 24-HOUR CHAT PERSISTENCE ═══
var CHAT_STORAGE_KEY = 'bot_kiosk_chat';
var CHAT_DATE_KEY = 'bot_kiosk_chat_date';

function getTodayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function loadFromServer() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/chat-messages?_=' + Date.now(), true);
  x.onload = function() {
    if (x.status === 200) {
      try {
        var data = JSON.parse(x.responseText);
        if (data.messages && data.messages.length > 0) {
          for (var i = 0; i < data.messages.length; i++) {
            appendChat(data.messages[i].sender, data.messages[i].text, true, data.messages[i].ts);
          }
          localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(data.messages));
          localStorage.setItem(CHAT_DATE_KEY, data.date || getTodayStr());
        }
      } catch(e) {}
    }
  };
  x.send();
}

function loadChatHistory() {
  try {
    var storedDate = localStorage.getItem(CHAT_DATE_KEY);
    var today = getTodayStr();
    if (storedDate && storedDate !== today) {
      var old = localStorage.getItem(CHAT_STORAGE_KEY);
      if (old) {
        try {
          var oldMsgs = JSON.parse(old);
          if (oldMsgs.length > 0) {
            var x = new XMLHttpRequest();
            x.open('POST', '/kiosk/flush', true);
            x.setRequestHeader('Content-Type', 'application/json');
            x.onload = function() {
              if (x.status === 200) {
                localStorage.removeItem(CHAT_STORAGE_KEY);
                localStorage.setItem(CHAT_DATE_KEY, today);
                loadFromServer();
              }
            };
            x.onerror = function() {};
            x.send(JSON.stringify({ messages: oldMsgs, date: storedDate }));
            return;
          }
        } catch(e2) {}
      }
      localStorage.removeItem(CHAT_STORAGE_KEY);
      localStorage.setItem(CHAT_DATE_KEY, today);
      return;
    }
    if (!storedDate) localStorage.setItem(CHAT_DATE_KEY, today);
    var raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (raw) {
      try {
        var messages = JSON.parse(raw);
        if (messages.length > 0) {
          for (var i = 0; i < messages.length; i++) {
            appendChat(messages[i].sender, messages[i].text, true, messages[i].ts);
          }
          return;
        }
      } catch(ep) {}
    }
    loadFromServer();
  } catch(e) {
    loadFromServer();
  }
}

function saveChatMessage(sender, text) {
  try {
    var today = getTodayStr();
    var storedDate = localStorage.getItem(CHAT_DATE_KEY);
    var messages = [];
    if (storedDate === today) {
      var raw = localStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) messages = JSON.parse(raw);
    } else {
      localStorage.setItem(CHAT_DATE_KEY, today);
    }
    var ts = Date.now();
    messages.push({ sender: sender, text: text, ts: ts });
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
    var x = new XMLHttpRequest();
    x.open('POST', '/kiosk/chat-messages', true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify({ sender: sender, text: text, ts: ts }));
  } catch(e) {}
}

// Midnight reset
var midnightFlushing = false;
setInterval(function() {
  if (midnightFlushing) return;
  var storedDate = localStorage.getItem(CHAT_DATE_KEY);
  var today = getTodayStr();
  if (storedDate && storedDate !== today) {
    var raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (raw) {
      try {
        var msgs = JSON.parse(raw);
        if (msgs.length > 0) {
          midnightFlushing = true;
          var x = new XMLHttpRequest();
          x.open('POST', '/kiosk/flush', true);
          x.setRequestHeader('Content-Type', 'application/json');
          x.onload = function() {
            midnightFlushing = false;
            if (x.status === 200) {
              localStorage.removeItem(CHAT_STORAGE_KEY);
              localStorage.setItem(CHAT_DATE_KEY, today);
              if (chatLog) chatLog.innerHTML = '';
              appendChat('system', 'Chat history saved and cleared (new day)', true);
            }
          };
          x.onerror = function() { midnightFlushing = false; };
          x.send(JSON.stringify({ messages: msgs, date: storedDate }));
          return;
        }
      } catch(e) {}
    }
    localStorage.removeItem(CHAT_STORAGE_KEY);
    localStorage.setItem(CHAT_DATE_KEY, today);
    if (chatLog) chatLog.innerHTML = '';
  }
}, window.__POLL_CONFIG.midnightFlushMs);

// Scroll-to-bottom button
if (chatScrollBtn) {
  chatScrollBtn.addEventListener('click', function(e) {
    e.preventDefault();
    if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
  });
}

if (chatLog) {
  chatLog.addEventListener('scroll', function() {
    if (!chatScrollBtn) return;
    var atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    chatScrollBtn.style.opacity = atBottom ? '0.5' : '1';
    chatScrollBtn.style.background = atBottom ? 'rgba(20,60,40,0.4)' : 'rgba(40,180,80,0.5)';
    chatScrollBtn.style.borderColor = atBottom ? 'rgba(60,200,120,0.3)' : 'rgba(60,200,120,0.7)';
  });
}

// Load saved chat
loadChatHistory();

// Send on button click
if (chatSend) {
  chatSend.addEventListener('click', function(e) {
    e.preventDefault();
    sendChatText();
  });
}

// Send on Enter key
if (chatInput) {
  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      sendChatText();
    }
    // Shift+Enter = newline (default textarea behavior, no block)
    if (e.code === 'Space') e.stopPropagation();
  });
  chatInput.addEventListener('keyup', function(e) {
    if (e.code === 'Space') e.stopPropagation();
  });
}

// Spacebar: hold-to-talk
document.addEventListener('keydown', function(e) {
  if (e.code === 'Space' && !e.repeat && document.activeElement !== chatInput) {
    e.preventDefault();
    ensureAudio();
    vadManualOverride = true;
    startRecording();
  }
});
document.addEventListener('keyup', function(e) {
  if (e.code === 'Space' && document.activeElement !== chatInput) {
    e.preventDefault();
    vadManualOverride = false;
    stopRecording();
  }
});

// Mic button
if (micBtn) {
  micBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var now = Date.now();
    if (now - lastMicToggle < 400) return;
    lastMicToggle = now;
    ensureAudio();
    if (isRecording) {
      micButtonActive = false;
      vadCooldownUntil = 0;
      stopRecording();
      return;
    }
    micButtonActive = true;
    recordPeakLevel = 0;
    vadSilenceStart = 0;
    vadRecordStart = Date.now();
    vadCooldownUntil = 0;
    if (vadStream) {
      startRecording();
    } else {
      initVAD(function() {
        startRecording();
        vadRecordStart = Date.now();
      });
    }
  });
  micBtn.addEventListener('touchend', function(e) {
    e.preventDefault();
    micBtn.click();
  }, { passive: false });
}

// ═══ MIC DEVICE PICKER ═══
var micDeviceSelect = document.getElementById('micDeviceSelect');
var linkMicSettings = document.getElementById('linkMicSettings');

function populateMicDevices() {
  navigator.mediaDevices.enumerateDevices().then(function(devices) {
    var inputs = devices.filter(function(d) { return d.kind === 'audioinput'; });
    micDeviceSelect.innerHTML = '';
    var defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '(system default)';
    micDeviceSelect.appendChild(defaultOpt);
    for (var i = 0; i < inputs.length; i++) {
      var opt = document.createElement('option');
      opt.value = inputs[i].deviceId;
      opt.textContent = inputs[i].label || ('Mic ' + (i + 1));
      if (inputs[i].deviceId === preferredMicId) opt.selected = true;
      micDeviceSelect.appendChild(opt);
    }
    appendChat('system', inputs.length + ' mic devices found:');
    for (var j = 0; j < inputs.length; j++) {
      var active = inputs[j].deviceId === preferredMicId ? ' [ACTIVE]' : '';
      appendChat('system', '  ' + (j+1) + '. ' + (inputs[j].label || 'Mic ' + (j+1)) + active);
    }
  });
}

if (linkMicSettings) {
  linkMicSettings.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    ensureAudio();
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function(tempStream) {
      tempStream.getAudioTracks().forEach(function(t) { t.stop(); });
      populateMicDevices();
      micDeviceSelect.style.display = micDeviceSelect.style.display === 'none' ? 'block' : 'none';
    }).catch(function(err) {
      appendChat('system', 'Mic permission denied: ' + err.message);
    });
  });
}

if (micDeviceSelect) {
  micDeviceSelect.addEventListener('change', function() {
    preferredMicId = micDeviceSelect.value;
    if (preferredMicId) {
      localStorage.setItem('bot_mic_device', preferredMicId);
    } else {
      localStorage.removeItem('bot_mic_device');
    }
    micDeviceSelect.style.display = 'none';
    appendChat('system', 'Switching mic... reinitializing stream.');
    reinitStream(function() {
      appendChat('system', 'Mic switched. Ready.');
    });
  });
}

// Click anywhere to resume AudioContext + start VAD
document.body.addEventListener('click', function() {
  ensureAudio();
  if (!vadListening) initVAD();
}, { once: true });

// Wake-from-sleep recovery
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (vadStream && !isStreamAlive(vadStream)) {
      reinitStream(null);
    }
  }
});

requestAnimationFrame(pollAmplitude);

// State timeout (recover from stuck thinking/speaking)
var stateStuckSince = 0;
setInterval(function() {
  if (state === 'thinking' || state === 'speaking') {
    if (stateStuckSince === 0) {
      stateStuckSince = Date.now();
    } else if (Date.now() - stateStuckSince > 90000) {
      state = 'active';
      stateChangedAt = performance.now();
      if (statusEl) statusEl.textContent = 'active (timeout)';
      if (stateLabel) stateLabel.textContent = 'active';
      updateStatusColor('active');
      stateStuckSince = 0;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'audio_ended' }));
      }
    }
  } else {
    stateStuckSince = 0;
  }
}, window.__POLL_CONFIG.stateCheckMs);

// Version poll
setInterval(function() {
  var x = new XMLHttpRequest();
  x.open('GET', '/status?_=' + Date.now(), true);
  x.onload = function() {
    if (x.status === 200) {
      var d = JSON.parse(x.responseText);
      if (d.version && d.version !== CLIENT_VERSION) {
        if (dbgEl) dbgEl.textContent = 'RELOADING TO ' + d.version;
        setTimeout(function() { location.href = '/?_=' + Date.now(); }, 500);
      }
    }
  };
  x.send();
}, window.__POLL_CONFIG.versionPollMs);

if (navigator.wakeLock) { navigator.wakeLock.request('screen').catch(function(){}); }

// ═══ EMOJI PICKER ═══
var emojiBtn = document.getElementById('emojiBtn');
var emojiPicker = document.getElementById('emojiPicker');
var emojiGrid = document.getElementById('emojiGrid');
var EMOJI_SET = [
  '😊','😂','🤣','😎','🤔','😏','👍','👎',
  '🔥','💯','❤️','🙌','🎯','⚡','✅','❌',
  '🚀','💰','🛡️','⚠️','📌','💡','🎉','👀',
  '🤝','💪','🧠','🗂️','📊','🏆','⏳','🔑',
  '😤','😈','🤖','👻','💀','🌊','🌙','☕'
];
if (emojiGrid) {
  EMOJI_SET.forEach(function(em) {
    var btn = document.createElement('span');
    btn.textContent = em;
    btn.style.cursor = 'pointer';
    btn.style.padding = '3px';
    btn.style.borderRadius = '4px';
    btn.style.textAlign = 'center';
    btn.style.transition = 'background 0.15s';
    btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(80,180,255,0.2)'; });
    btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; });
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (chatInput) {
        var start = chatInput.selectionStart || chatInput.value.length;
        var end = chatInput.selectionEnd || start;
        chatInput.value = chatInput.value.slice(0, start) + em + chatInput.value.slice(end);
        chatInput.selectionStart = chatInput.selectionEnd = start + em.length;
        chatInput.focus();
      }
    });
    emojiGrid.appendChild(btn);
  });
}
if (emojiBtn && emojiPicker) {
  emojiBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', function(e) {
    if (emojiPicker.style.display !== 'none' && !emojiPicker.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) {
      emojiPicker.style.display = 'none';
    }
  });
}

// ═══ SESSION STATS POLLING ═══
var statMemories = document.getElementById('statMemories');
var statContext = document.getElementById('statContext');
var statTurns = document.getElementById('statTurns');
var statCompactions = document.getElementById('statCompactions');
var contextBar = document.getElementById('contextBar');
var convoLife = document.getElementById('convoLife');

function pollSessionStats() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/stats?_=' + Date.now(), true);
  x.onload = function() {
    if (x.status === 200) {
      try {
        var d = JSON.parse(x.responseText);
        if (statMemories) statMemories.textContent = (d.totalMemories || 0).toLocaleString();
        if (d.contextPct !== undefined) {
          var pct = Math.round(d.contextPct);
          var used = d.contextTokens || 0;
          var limit = d.contextLimit || 200000;
          var usedK = Math.round(used / 1000);
          var limitK = Math.round(limit / 1000);
          if (statContext) statContext.textContent = pct + '% (' + usedK + 'k / ' + limitK + 'k)';
          if (contextBar) {
            contextBar.style.width = pct + '%';
            contextBar.style.background = pct > 80 ? 'rgba(220,60,60,0.8)' : pct > 60 ? 'rgba(220,180,60,0.8)' : 'rgba(80,180,255,0.6)';
          }
          // Top bar compact context display
          if (convoLife) {
            convoLife.textContent = pct + '% ctx';
            convoLife.style.color = pct > 80 ? 'rgba(220,60,60,0.7)' : pct > 60 ? 'rgba(220,180,60,0.6)' : 'rgba(80,180,255,0.4)';
          }
        }
        if (statTurns) statTurns.textContent = d.turns || '--';
        if (statCompactions) statCompactions.textContent = d.compactions || '0';
      } catch(e) {}
    }
  };
  x.send();
}
pollSessionStats();
setInterval(pollSessionStats, window.__POLL_CONFIG.sessionStatsMs);`;
}

// ═══════════════════════════════════════════════
//  MODEL SELECTOR DROPDOWNS
// ═══════════════════════════════════════════════
function generateModelJS(): string {
  return `
// ═══ MODEL SELECTOR DROPDOWNS ═══
var chatModelBtn = document.getElementById('chatModelBtn');
var chatModelLabel = document.getElementById('chatModelLabel');
var chatModelPanel = document.getElementById('chatModelPanel');
var coderModelBtn = document.getElementById('coderModelBtn');
var coderModelLabel = document.getElementById('coderModelLabel');
var coderModelPanel = document.getElementById('coderModelPanel');
var chatModels = [];
var coderModels = [];

var PROVIDER_COLORS = {
  claude: 'rgba(180,140,255,0.9)',
  venice: 'rgba(80,220,180,0.9)',
  ollama: 'rgba(255,180,80,0.9)',
  openrouter: 'rgba(255,120,120,0.9)'
};
var PROVIDER_NAMES = {
  claude: 'Claude',
  venice: 'Venice',
  ollama: 'Ollama',
  openrouter: 'OpenRouter'
};
var PROVIDER_ORDER = ['claude', 'venice', 'ollama', 'openrouter'];

function optStyle(isActive) {
  return 'padding:7px 14px;cursor:pointer;color:' + (isActive ? 'rgba(180,230,255,1)' : 'rgba(140,200,240,0.8)') +
    ';background:' + (isActive ? 'rgba(30,70,140,0.4)' : 'transparent') +
    ';border-left:2px solid ' + (isActive ? 'rgba(80,180,255,0.8)' : 'transparent') +
    ';transition:all 0.15s;white-space:nowrap;display:flex;align-items:center;gap:8px';
}

function addHover(el, isActive) {
  el.onmouseenter = function() { if (!isActive) el.style.background = 'rgba(20,60,120,0.3)'; };
  el.onmouseleave = function() { if (!isActive) el.style.background = 'transparent'; };
}

function buildProviderList(panel, models, activeAlias, type) {
  panel.innerHTML = '';
  var isAuto = !activeAlias;
  var autoDiv = document.createElement('div');
  autoDiv.style.cssText = optStyle(isAuto);
  autoDiv.textContent = 'Auto (default)';
  addHover(autoDiv, isAuto);
  autoDiv.onclick = function() { selectModel(type, 'auto', 'Auto'); };
  panel.appendChild(autoDiv);

  var sep = document.createElement('div');
  sep.style.cssText = 'height:1px;background:rgba(40,100,200,0.15);margin:3px 0';
  panel.appendChild(sep);

  var groups = {};
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push(m);
  }

  var activeProvider = '';
  if (activeAlias) {
    for (var j = 0; j < models.length; j++) {
      if (models[j].alias === activeAlias || models[j].id === activeAlias) {
        activeProvider = models[j].provider;
        break;
      }
    }
  }

  for (var pi = 0; pi < PROVIDER_ORDER.length; pi++) {
    var pName = PROVIDER_ORDER[pi];
    if (!groups[pName]) continue;
    var pModels = groups[pName];
    var isActiveP = pName === activeProvider;

    (function(providerName, providerModels, isProviderActive) {
      var row = document.createElement('div');
      row.style.cssText = optStyle(isProviderActive);

      var dot = document.createElement('span');
      dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:' + (PROVIDER_COLORS[providerName] || 'rgba(140,200,240,0.5)') + ';flex-shrink:0';
      row.appendChild(dot);

      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'flex:1';
      nameSpan.textContent = PROVIDER_NAMES[providerName] || providerName;
      row.appendChild(nameSpan);

      var right = document.createElement('span');
      right.style.cssText = 'font-size:9px;opacity:0.5';
      if (isProviderActive) {
        right.textContent = activeAlias;
        right.style.color = PROVIDER_COLORS[providerName] || 'rgba(140,200,240,0.7)';
        right.style.opacity = '0.8';
      } else {
        right.textContent = providerModels.length > 1 ? '\\u25B8' : providerModels[0].alias;
      }
      row.appendChild(right);

      addHover(row, isProviderActive);
      row.onclick = function(e) {
        e.stopPropagation();
        if (providerModels.length === 1) {
          selectModel(type, providerModels[0].alias, providerModels[0].alias);
        } else {
          buildModelSubMenu(panel, providerName, providerModels, activeAlias, type, models);
        }
      };
      panel.appendChild(row);
    })(pName, pModels, isActiveP);
  }
}

function buildModelSubMenu(panel, providerName, providerModels, activeAlias, type, allModels) {
  panel.innerHTML = '';

  var back = document.createElement('div');
  back.style.cssText = 'padding:6px 14px;cursor:pointer;color:rgba(80,180,255,0.7);display:flex;align-items:center;gap:6px;transition:all 0.15s';
  back.innerHTML = '<span style="font-size:12px">\\u25C2</span><span>Back</span>';
  back.onmouseenter = function() { back.style.background = 'rgba(20,60,120,0.3)'; };
  back.onmouseleave = function() { back.style.background = 'transparent'; };
  back.onclick = function(e) {
    e.stopPropagation();
    var stored = localStorage.getItem('bot_kiosk_' + type + '_model') || '';
    buildProviderList(panel, allModels, stored, type);
  };
  panel.appendChild(back);

  var hdr = document.createElement('div');
  hdr.style.cssText = 'padding:4px 14px 4px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:' + (PROVIDER_COLORS[providerName] || 'rgba(140,200,240,0.5)') + ';border-top:1px solid rgba(40,100,200,0.15);border-bottom:1px solid rgba(40,100,200,0.1);pointer-events:none';
  hdr.textContent = PROVIDER_NAMES[providerName] || providerName;
  panel.appendChild(hdr);

  for (var i = 0; i < providerModels.length; i++) {
    (function(model) {
      var isActive = activeAlias === model.alias || activeAlias === model.id;
      var opt = document.createElement('div');
      opt.style.cssText = optStyle(isActive);

      var nameSpan = document.createElement('span');
      nameSpan.textContent = model.alias;
      opt.appendChild(nameSpan);

      addHover(opt, isActive);
      opt.onclick = function(e) {
        e.stopPropagation();
        selectModel(type, model.alias, model.alias);
      };
      panel.appendChild(opt);
    })(providerModels[i]);
  }
}

function selectModel(type, alias, displayName) {
  var label = type === 'chat' ? chatModelLabel : coderModelLabel;
  var panel = type === 'chat' ? chatModelPanel : coderModelPanel;
  var btn = type === 'chat' ? chatModelBtn : coderModelBtn;
  if (label) label.textContent = alias === 'auto' ? 'Auto' : displayName.charAt(0).toUpperCase() + displayName.slice(1);
  if (panel) panel.style.display = 'none';
  localStorage.setItem('bot_kiosk_' + type + '_model', alias === 'auto' ? '' : alias);
  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/model', true);
  x.setRequestHeader('Content-Type', 'application/json');
  x.onload = function() {
    if (x.status === 200) {
      var d = JSON.parse(x.responseText);
      appendChat('system', type.toUpperCase() + ' model: ' + (d.model ? d.model + ' (' + (d.provider || '') + ')' : 'Auto'));
    }
  };
  x.send(JSON.stringify({ type: type, model: alias }));
  if (btn) {
    btn.style.borderColor = 'rgba(60,200,120,0.6)';
    setTimeout(function() { btn.style.borderColor = 'rgba(40,100,200,0.25)'; }, 800);
  }
}

function togglePanel(panel, btn, models, type) {
  var isOpen = panel.style.display !== 'none';
  if (chatModelPanel) chatModelPanel.style.display = 'none';
  if (coderModelPanel) coderModelPanel.style.display = 'none';
  if (typeof closeAllL3 === 'function') closeAllL3();
  if (isOpen) return;
  var stored = localStorage.getItem('bot_kiosk_' + type + '_model') || '';
  buildProviderList(panel, models, stored, type);
  panel.style.display = 'block';
}

function loadKioskModels() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/models?_=' + Date.now(), true);
  x.onload = function() {
    if (x.status === 200) {
      var d = JSON.parse(x.responseText);
      chatModels = d.chat || [];
      coderModels = d.coder || [];
    }
  };
  x.send();
  var y = new XMLHttpRequest();
  y.open('GET', '/kiosk/model?_=' + Date.now(), true);
  y.onload = function() {
    if (y.status === 200) {
      var d = JSON.parse(y.responseText);
      if (d.chat && chatModelLabel) {
        chatModelLabel.textContent = d.chat.alias.charAt(0).toUpperCase() + d.chat.alias.slice(1);
        localStorage.setItem('bot_kiosk_chat_model', d.chat.alias);
      }
      if (d.coder && coderModelLabel) {
        coderModelLabel.textContent = d.coder.alias.charAt(0).toUpperCase() + d.coder.alias.slice(1);
        localStorage.setItem('bot_kiosk_coder_model', d.coder.alias);
      }
    }
  };
  y.send();
  var savedChat = localStorage.getItem('bot_kiosk_chat_model');
  if (savedChat && chatModelLabel) chatModelLabel.textContent = savedChat.charAt(0).toUpperCase() + savedChat.slice(1);
  var savedCoder = localStorage.getItem('bot_kiosk_coder_model');
  if (savedCoder && coderModelLabel) coderModelLabel.textContent = savedCoder.charAt(0).toUpperCase() + savedCoder.slice(1);
}

if (chatModelBtn && chatModelPanel) {
  chatModelBtn.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation();
    togglePanel(chatModelPanel, chatModelBtn, chatModels, 'chat');
  });
}
if (coderModelBtn && coderModelPanel) {
  coderModelBtn.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation();
    togglePanel(coderModelPanel, coderModelBtn, coderModels, 'coder');
  });
}

document.addEventListener('click', function(e) {
  if (chatModelPanel && chatModelPanel.style.display !== 'none') {
    if (!chatModelPanel.contains(e.target) && e.target !== chatModelBtn && !chatModelBtn.contains(e.target)) {
      chatModelPanel.style.display = 'none';
    }
  }
  if (coderModelPanel && coderModelPanel.style.display !== 'none') {
    if (!coderModelPanel.contains(e.target) && e.target !== coderModelBtn && !coderModelBtn.contains(e.target)) {
      coderModelPanel.style.display = 'none';
    }
  }
});

function addBtnHover(btn) {
  if (!btn) return;
  btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(15,40,80,0.9)'; btn.style.borderColor = 'rgba(60,160,255,0.4)'; });
  btn.addEventListener('mouseleave', function() { btn.style.background = 'rgba(8,20,45,0.8)'; btn.style.borderColor = 'rgba(40,100,200,0.25)'; });
}
addBtnHover(chatModelBtn);
addBtnHover(coderModelBtn);

loadKioskModels();
setInterval(function() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/model?_=' + Date.now(), true);
  x.onload = function() {
    if (x.status !== 200) return;
    var d = JSON.parse(x.responseText);
    if (d.chat && chatModelLabel) {
      var a = d.chat.alias;
      chatModelLabel.textContent = a.charAt(0).toUpperCase() + a.slice(1);
      localStorage.setItem('bot_kiosk_chat_model', a);
    } else if (chatModelLabel && chatModelLabel.textContent !== 'Auto') {
      chatModelLabel.textContent = 'Auto';
      localStorage.removeItem('bot_kiosk_chat_model');
    }
    if (d.coder && coderModelLabel) {
      var b = d.coder.alias;
      coderModelLabel.textContent = b.charAt(0).toUpperCase() + b.slice(1);
      localStorage.setItem('bot_kiosk_coder_model', b);
    } else if (coderModelLabel && coderModelLabel.textContent !== 'Auto') {
      coderModelLabel.textContent = 'Auto';
      localStorage.removeItem('bot_kiosk_coder_model');
    }
  };
  x.send();
}, window.__POLL_CONFIG.modelPollMs);`;
}

// ═══════════════════════════════════════════════
//  LAYER 3: EMERGENCY PANEL JS
// ═══════════════════════════════════════════════
function generateLayer3JS(): string {
  return `
// ═══ LAYER 3: EMERGENCY PANEL CONTROLS ═══
var paladinBtn = document.getElementById('paladinBtn');
var paladinDot = document.getElementById('paladinDot');
var paladinLabel = document.getElementById('paladinLabel');
var paladinPanel = document.getElementById('paladinPanel');
var fleetBtn = document.getElementById('fleetBtn');
var fleetLabel = document.getElementById('fleetLabel');
var fleetPanel = document.getElementById('fleetPanel');
var sysCheckBtn = document.getElementById('sysCheckBtn');
var sysPanel = document.getElementById('sysPanel');
var tasksBtn = document.getElementById('tasksBtn');
var tasksLabel = document.getElementById('tasksLabel');
var tasksPanel = document.getElementById('tasksPanel');
var tradingBtn = document.getElementById('tradingBtn');
var tradingDot = document.getElementById('tradingDot');
var tradingLabel = document.getElementById('tradingLabel');
var tradingPanel = document.getElementById('tradingPanel');

var l3Panels = [paladinPanel, fleetPanel, sysPanel, tasksPanel, tradingPanel];

function closeAllL3() {
  for (var i = 0; i < l3Panels.length; i++) {
    if (l3Panels[i]) l3Panels[i].style.display = 'none';
  }
}

function toggleL3(panel) {
  var wasOpen = panel && panel.style.display !== 'none';
  closeAllL3();
  // Also close model panels
  if (chatModelPanel) chatModelPanel.style.display = 'none';
  if (coderModelPanel) coderModelPanel.style.display = 'none';
  if (!wasOpen && panel) panel.style.display = 'block';
  return !wasOpen;
}

function fmtUptime(ms) {
  if (ms < 60000) return Math.floor(ms / 1000) + 's';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
  return Math.floor(ms / 86400000) + 'd ' + Math.floor((ms % 86400000) / 3600000) + 'h';
}

function fmtBytes(b) {
  if (b < 1048576) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ── Paladin polling ──
function pollPaladin() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/paladin?_=' + Date.now(), true);
  x.timeout = 5000;
  x.onload = function() {
    if (x.status !== 200) { setPaladinOffline(); return; }
    try {
      var d = JSON.parse(x.responseText);
      if (d.online) {
        if (paladinDot) { paladinDot.classList.remove('offline'); paladinDot.classList.add('online'); }
        if (paladinLabel) paladinLabel.textContent = 'Online';
      } else {
        setPaladinOffline();
      }
    } catch(e) { setPaladinOffline(); }
  };
  x.onerror = function() { setPaladinOffline(); };
  x.ontimeout = function() { setPaladinOffline(); };
  x.send();
}

function setPaladinOffline() {
  if (paladinDot) { paladinDot.classList.remove('online'); paladinDot.classList.add('offline'); }
  if (paladinLabel) paladinLabel.textContent = 'Down';
}

// Paladin detail panel
function showPaladinPanel() {
  if (!toggleL3(paladinPanel)) return;
  paladinPanel.innerHTML = '<div class="l3-spinner">Loading Paladin status...</div>';
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/paladin?_=' + Date.now(), true);
  x.timeout = 5000;
  x.onload = function() {
    if (x.status !== 200) { paladinPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Paladin unreachable</div>'; return; }
    try {
      var d = JSON.parse(x.responseText);
      if (!d.online) { paladinPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Paladin offline</div>'; return; }
      var html = '<div class="l3-panel-header">PALADIN SECURITY ENGINE</div>';
      html += '<div style="padding:8px 12px;line-height:1.8;color:rgba(180,230,255,0.8);font-size:11px">';
      html += '<div>Status: <span style="color:rgba(60,220,120,0.9)">Online</span></div>';
      html += '<div>Uptime: ' + fmtUptime(d.uptime || 0) + '</div>';
      html += '<div>Directives: ' + (d.directives || '--') + '</div>';
      html += '<div>Policy rules: ' + (d.policyRules || '--') + '</div>';
      html += '<div>Checks: ' + (d.checksTotal || 0) + ' total</div>';
      html += '<div>Denied: <span style="color:rgba(255,100,100,0.8)">' + (d.denied || 0) + '</span></div>';
      html += '<div>Approved: <span style="color:rgba(60,220,120,0.8)">' + (d.approved || 0) + '</span></div>';
      html += '</div>';
      html += '<div style="padding:4px 12px 8px"><div class="fleet-restart-btn" onclick="reloadPaladinPolicy()" style="display:inline-block;padding:4px 12px">Reload Policy</div></div>';
      paladinPanel.innerHTML = html;
    } catch(e) { paladinPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Parse error</div>'; }
  };
  x.onerror = function() { paladinPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Connection failed</div>'; };
  x.send();
}

function reloadPaladinPolicy() {
  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/paladin/reload', true);
  x.onload = function() {
    try {
      var d = JSON.parse(x.responseText);
      if (d.ok) {
        appendChat('system', 'Paladin policy reloaded');
        closeAllL3();
      } else {
        appendChat('system', 'Paladin reload failed');
      }
    } catch(e) { appendChat('system', 'Paladin reload error'); }
  };
  x.send();
}

if (paladinBtn) paladinBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); showPaladinPanel(); });

// ── Fleet polling ──
function pollFleet() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/fleet?_=' + Date.now(), true);
  x.timeout = 8000;
  x.onload = function() {
    if (x.status !== 200) return;
    try {
      var d = JSON.parse(x.responseText);
      if (fleetLabel) fleetLabel.textContent = d.online + '/' + d.total;
    } catch(e) {}
  };
  x.send();
}

function showFleetPanel() {
  if (!toggleL3(fleetPanel)) return;
  fleetPanel.innerHTML = '<div class="l3-spinner">Loading fleet...</div>';
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/fleet?_=' + Date.now(), true);
  x.timeout = 8000;
  x.onload = function() {
    if (x.status !== 200) { fleetPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Fleet read failed</div>'; return; }
    try {
      var d = JSON.parse(x.responseText);
      var agents = d.agents || [];
      var html = '<div class="l3-panel-header">FLEET (' + d.online + '/' + d.total + ' online)</div>';
      for (var i = 0; i < agents.length; i++) {
        var a = agents[i];
        var dotClass = a.status === 'online' ? 'online' : (a.status === 'errored' ? 'warning' : 'offline');
        html += '<div class="fleet-row">';
        html += '<span class="status-dot ' + dotClass + '"></span>';
        html += '<span class="fleet-name">' + a.name + '</span>';
        html += '<span class="fleet-meta">' + fmtUptime(a.uptime) + ' / ' + fmtBytes(a.memory) + '</span>';
        html += '<span class="fleet-restart-btn" onclick="restartAgent(\\'' + a.name.replace(/'/g, '') + '\\')">restart</span>';
        html += '</div>';
      }
      fleetPanel.innerHTML = html;
    } catch(e) { fleetPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Parse error</div>'; }
  };
  x.onerror = function() { fleetPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Connection failed</div>'; };
  x.send();
}

function restartAgent(name) {
  if (!name) return;
  appendChat('system', 'Restarting ' + name + '...');
  closeAllL3();
  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/fleet/restart', true);
  x.setRequestHeader('Content-Type', 'application/json');
  x.onload = function() {
    try {
      var d = JSON.parse(x.responseText);
      if (d.ok) {
        appendChat('system', d.restarted + ' restarted');
        pollFleet();
      } else {
        appendChat('system', 'Restart failed: ' + (d.error || 'unknown'));
      }
    } catch(e) { appendChat('system', 'Restart error'); }
  };
  x.send(JSON.stringify({ name: name }));
}

if (fleetBtn) fleetBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); showFleetPanel(); });

// ── Systems Check ──
function runSystemsCheck() {
  if (!toggleL3(sysPanel)) return;
  sysPanel.innerHTML = '<div class="l3-panel-header">SYSTEMS CHECK</div><div class="l3-spinner">Running diagnostics...</div>';
  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/systems-check', true);
  x.timeout = 35000;
  x.onload = function() {
    try {
      var d = JSON.parse(x.responseText);
      var output = d.output || 'No output';
      // Strip ANSI codes
      output = output.replace(/\\x1b\\[[0-9;]*m/g, '').replace(/\\u001b\\[[0-9;]*m/g, '');
      sysPanel.innerHTML = '<div class="l3-panel-header">SYSTEMS CHECK ' + (d.ok ? '\\u2705' : '\\u26A0\\uFE0F') + '</div><div class="sys-output">' + escapeHtml(output) + '</div>';
    } catch(e) { sysPanel.innerHTML = '<div class="l3-panel-header">SYSTEMS CHECK</div><div style="padding:12px;color:rgba(255,80,80,0.8)">Parse error</div>'; }
  };
  x.onerror = function() { sysPanel.innerHTML = '<div class="l3-panel-header">SYSTEMS CHECK</div><div style="padding:12px;color:rgba(255,80,80,0.8)">Connection failed</div>'; };
  x.ontimeout = function() { sysPanel.innerHTML = '<div class="l3-panel-header">SYSTEMS CHECK</div><div style="padding:12px;color:rgba(255,200,60,0.8)">Timed out (>30s)</div>'; };
  x.send();
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

if (sysCheckBtn) sysCheckBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); runSystemsCheck(); });

// ── Tasks Quick-View ──
function showTasksPanel() {
  if (!toggleL3(tasksPanel)) return;
  tasksPanel.innerHTML = '<div class="l3-spinner">Loading tasks...</div>';
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/tasks?_=' + Date.now(), true);
  x.timeout = 5000;
  x.onload = function() {
    if (x.status !== 200) { tasksPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Tasks read failed</div>'; return; }
    try {
      var d = JSON.parse(x.responseText);
      var tasks = d.tasks || [];
      if (tasksLabel) tasksLabel.textContent = d.total || '0';
      if (tasks.length === 0) {
        tasksPanel.innerHTML = '<div class="l3-panel-header">TASKS</div><div style="padding:12px;color:rgba(80,180,255,0.5)">All clear. No open tasks.</div>';
        return;
      }
      var html = '<div class="l3-panel-header">TASKS (' + d.total + ' open)</div>';
      var lastSection = '';
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i];
        if (t.section !== lastSection) {
          html += '<div class="task-section">' + escapeHtml(t.section) + '</div>';
          lastSection = t.section;
        }
        html += '<div class="task-item">\\u2610 ' + escapeHtml(t.text) + '</div>';
      }
      tasksPanel.innerHTML = html;
    } catch(e) { tasksPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Parse error</div>'; }
  };
  x.onerror = function() { tasksPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Connection failed</div>'; };
  x.send();
}

function pollTasks() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/tasks?_=' + Date.now(), true);
  x.timeout = 5000;
  x.onload = function() {
    if (x.status !== 200) return;
    try {
      var d = JSON.parse(x.responseText);
      if (tasksLabel) tasksLabel.textContent = d.total || '0';
    } catch(e) {}
  };
  x.send();
}

if (tasksBtn) tasksBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); showTasksPanel(); });

// ── Trading Plugin ──
function pollTrading() {
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/trading-status?_=' + Date.now(), true);
  x.timeout = 8000;
  x.onload = function() {
    if (x.status !== 200) { setTradingOffline(); return; }
    try {
      var d = JSON.parse(x.responseText);
      if (d.online > 0) {
        if (tradingDot) { tradingDot.classList.remove('offline'); tradingDot.classList.add('online'); }
        if (tradingLabel) tradingLabel.textContent = d.online + '/' + d.total;
      } else {
        setTradingOffline();
      }
    } catch(e) { setTradingOffline(); }
  };
  x.onerror = function() { setTradingOffline(); };
  x.ontimeout = function() { setTradingOffline(); };
  x.send();
}

function setTradingOffline() {
  if (tradingDot) { tradingDot.classList.remove('online'); tradingDot.classList.add('offline'); }
  if (tradingLabel) tradingLabel.textContent = 'Down';
}

function fmtPnl(val) {
  var sign = val >= 0 ? '+' : '';
  return sign + val.toFixed(2);
}

function showTradingPanel() {
  if (!toggleL3(tradingPanel)) return;
  tradingPanel.innerHTML = '<div class="l3-spinner">Loading trading status...</div>';
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/trading-status?_=' + Date.now(), true);
  x.timeout = 8000;
  x.onload = function() {
    if (x.status !== 200) { tradingPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Trading status failed</div>'; return; }
    try {
      var d = JSON.parse(x.responseText);
      var bots = d.bots || [];
      var positions = d.positions || [];

      var html = '<div class="l3-panel-header">TRADING PLUGIN (' + d.online + '/' + d.total + ' online)</div>';

      // Today's P/L summary
      var pnlClass = d.todayPnl >= 0 ? 'trade-pnl-plus' : 'trade-pnl-minus';
      html += '<div class="trade-stat"><span>Today P/L</span><span class="' + pnlClass + '">' + fmtPnl(d.todayPnl || 0) + ' USD</span></div>';
      html += '<div class="trade-stat"><span>Trades today</span><span>' + (d.todayTrades || 0) + '</span></div>';

      // Bot status rows
      html += '<div class="trade-section">BOTS</div>';
      for (var i = 0; i < bots.length; i++) {
        var b = bots[i];
        var dotClass = b.status === 'online' ? 'online' : (b.status === 'errored' ? 'warning' : 'offline');
        var role = '';
        if (b.name === 'strategy-1') role = ' (intake)';
        else if (b.name === 'optimizer-1') role = ' (optimizer)';
        else role = ' (trader)';
        html += '<div class="trade-bot-row">';
        html += '<span class="status-dot ' + dotClass + '"></span>';
        html += '<span class="fleet-name">' + b.name + role + '</span>';
        html += '<span class="fleet-meta">' + fmtUptime(b.uptime) + '</span>';
        html += '</div>';
      }

      // Scout intake
      if (d.scoutIntake !== undefined) {
        html += '<div class="trade-stat"><span>Scout intake queue</span><span>' + d.scoutIntake + ' briefs</span></div>';
      }

      // Alpha last report
      if (d.alphaLastReport) {
        html += '<div class="trade-stat"><span>Alpha last run</span><span style="font-size:9px">' + d.alphaLastReport + '</span></div>';
      }

      // Open positions
      if (positions.length > 0) {
        html += '<div class="trade-section">OPEN POSITIONS</div>';
        for (var j = 0; j < positions.length; j++) {
          var p = positions[j];
          var pClass = p.pnl >= 0 ? 'trade-pnl-plus' : 'trade-pnl-minus';
          html += '<div class="trade-pos-row">';
          html += '<span>' + p.bot + '</span>';
          html += '<span style="flex:1">' + p.pair + ' ' + p.side.toUpperCase() + '</span>';
          html += '<span class="' + pClass + '">' + fmtPnl(p.pnl) + '</span>';
          html += '</div>';
        }
      } else {
        html += '<div class="trade-section">POSITIONS</div>';
        html += '<div style="padding:4px 12px;font-size:10px;color:rgba(80,180,255,0.4)">No open positions</div>';
      }

      tradingPanel.innerHTML = html;
    } catch(e) { tradingPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Parse error</div>'; }
  };
  x.onerror = function() { tradingPanel.innerHTML = '<div style="padding:12px;color:rgba(255,80,80,0.8)">Connection failed</div>'; };
  x.send();
}

if (tradingBtn) tradingBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); showTradingPanel(); });

// ── Calendar pop-up button ──
var calendarBtn = document.getElementById('calendarBtn');
if (calendarBtn) {
  calendarBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    window.open('/kiosk/calendar-page', 'apex-calendar', 'width=' + Math.round(screen.width * 0.78) + ',height=' + Math.round(screen.height * 0.85) + ',menubar=no,toolbar=no');
  });
  addBtnHover(calendarBtn);
}

// ── Vault browser pop-up button ──
var vaultBtn = document.getElementById('vaultBtn');
if (vaultBtn) {
  vaultBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    window.open('/kiosk/vault-page', 'apex-vault', 'width=' + Math.round(screen.width * 0.82) + ',height=' + Math.round(screen.height * 0.88) + ',menubar=no,toolbar=no');
  });
  addBtnHover(vaultBtn);
}

// ── Content Board launch button ──
var contentBoardBtn = document.getElementById('contentBoardBtn');
if (contentBoardBtn) {
  contentBoardBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var cbPort = window.__BOT_CONTENT_BOARD_PORT || 3210;
    var url = location.protocol + '//' + location.hostname + ':' + cbPort + '/';
    window.open(url, '_blank');
  });
  addBtnHover(contentBoardBtn);
}

// ── Close L3 panels on outside click ──
document.addEventListener('click', function(e) {
  for (var i = 0; i < l3Panels.length; i++) {
    var p = l3Panels[i];
    if (p && p.style.display !== 'none') {
      var btns = [paladinBtn, fleetBtn, sysCheckBtn, tasksBtn, tradingBtn];
      var clickedInside = p.contains(e.target);
      for (var j = 0; j < btns.length; j++) {
        if (btns[j] && (btns[j] === e.target || btns[j].contains(e.target))) clickedInside = true;
      }
      if (!clickedInside) p.style.display = 'none';
    }
  }
});

// ── L3 hover effects ──
addBtnHover(paladinBtn);
addBtnHover(fleetBtn);
addBtnHover(tasksBtn);
addBtnHover(tradingBtn);

// ── L3 auto-polling ──
pollPaladin();
pollFleet();
pollTasks();
pollTrading();
setInterval(pollPaladin, window.__POLL_CONFIG.paladinPollMs);
setInterval(pollFleet, window.__POLL_CONFIG.fleetPollMs);
setInterval(pollTasks, window.__POLL_CONFIG.tasksPollMs);
setInterval(pollTrading, window.__POLL_CONFIG.tradingPollMs);
`;
}

// ═══════════════════════════════════════════════
//  MAIN EXPORT - Assembles all sections
// ═══════════════════════════════════════════════
export function getAvatarDisplayHtml(opts?: {
  dashboardPort?: number;
  contentBoardPort?: number;
  /** Client-side polling intervals (ms). All have sensible defaults. */
  pollIntervals?: {
    midnightFlushMs?: number;
    sessionStatsMs?: number;
    stateCheckMs?: number;
    versionPollMs?: number;
    modelPollMs?: number;
    paladinPollMs?: number;
    fleetPollMs?: number;
    tasksPollMs?: number;
    tradingPollMs?: number;
  };
}): string {
  const dashPort = opts?.dashboardPort ?? 3141;
  const cbPort = opts?.contentBoardPort ?? 3210;
  const pi = opts?.pollIntervals ?? {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no,maximum-scale=1">
<title>Apex v21.0</title>
${generateStyles()}
</head>
<body>
${generateHTML()}
<script>
window.__BOT_DASHBOARD_PORT = ${dashPort};
window.__BOT_CONTENT_BOARD_PORT = ${cbPort};
window.__POLL_CONFIG = {
  midnightFlushMs: ${pi.midnightFlushMs ?? 60000},
  sessionStatsMs: ${pi.sessionStatsMs ?? 15000},
  stateCheckMs: ${pi.stateCheckMs ?? 15000},
  versionPollMs: ${pi.versionPollMs ?? 10000},
  modelPollMs: ${pi.modelPollMs ?? 30000},
  paladinPollMs: ${pi.paladinPollMs ?? 15000},
  fleetPollMs: ${pi.fleetPollMs ?? 30000},
  tasksPollMs: ${pi.tasksPollMs ?? 60000},
  tradingPollMs: ${pi.tradingPollMs ?? 30000}
};
${generateCoreJS()}
${generateWebSocketJS()}
${generateStatusJS()}
${generateDataJS()}
${generateVisibilityJS()}
${generateRainJS()}
${generateAudioJS()}
${generateChatJS()}
${generateVoiceJS()}
${generateRenderJS()}
${generateInitJS()}
${generateIOSetupJS()}
${generateModelJS()}
${generateLayer3JS()}
</script>
</body>
</html>`;
}
