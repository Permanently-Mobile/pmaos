/**
 * Calendar Page -- Standalone HTML page served as a kiosk pop-up.
 * Self-contained (inline CSS + JS), no external dependencies.
 * Fetches data from /kiosk/calendar?month=YYYY-MM and renders
 * a month view with category-colored dots and a drillable day view.
 */

export function getCalendarPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apex Calendar</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050a19;color:rgba(180,230,255,0.85);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow-x:hidden}
#app{padding:12px;width:75vw;max-width:1200px;margin:0 auto}

.cal-header{display:flex;align-items:center;justify-content:space-between;padding:8px 0;margin-bottom:6px}
.cal-header .nav-btn{background:none;border:1px solid rgba(80,180,255,0.25);color:rgba(80,180,255,0.7);width:32px;height:32px;border-radius:6px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
.cal-header .nav-btn:hover{background:rgba(80,180,255,0.1);border-color:rgba(80,180,255,0.5)}
.cal-header .month-title{font-size:18px;font-weight:600;color:rgba(180,230,255,0.95);letter-spacing:0.5px}

.filter-bar{display:flex;gap:6px;margin-bottom:10px}
.filter-btn{background:rgba(20,40,80,0.4);border:1px solid rgba(80,180,255,0.15);color:rgba(180,230,255,0.5);padding:4px 12px;border-radius:12px;cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;transition:all 0.15s;user-select:none}
.filter-btn:hover{border-color:rgba(80,180,255,0.4);color:rgba(180,230,255,0.7)}
.filter-btn.active{background:rgba(80,180,255,0.15);border-color:rgba(80,180,255,0.5);color:rgba(180,230,255,0.9)}
.filter-btn.active[data-cat="system"]{border-color:rgba(255,80,80,0.5);background:rgba(255,80,80,0.1);color:#ff5050}
.filter-btn.active[data-cat="operational"]{border-color:rgba(80,160,255,0.5);background:rgba(80,160,255,0.1);color:#50a0ff}
.filter-btn.active[data-cat="auto"]{border-color:rgba(255,200,61,0.5);background:rgba(255,200,61,0.1);color:#ffc83d}

.dow-row{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px}
.dow-cell{text-align:center;font-size:11px;color:rgba(80,180,255,0.45);padding:4px 0;text-transform:uppercase;letter-spacing:1px}

.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.day-cell{background:rgba(10,20,50,0.5);border:1px solid rgba(80,180,255,0.08);border-radius:6px;min-height:80px;padding:8px;position:relative;transition:border-color 0.15s,background 0.15s}
.day-cell.dim{opacity:0.3}
.day-cell.today{border-color:rgba(0,220,255,0.5);box-shadow:0 0 8px rgba(0,220,255,0.15)}
.day-cell.has-events{cursor:pointer}
.day-cell.has-events:hover{border-color:rgba(80,180,255,0.35);background:rgba(20,40,80,0.5)}
.day-num{font-size:12px;font-weight:500;color:rgba(180,230,255,0.7);display:block;margin-bottom:2px}
.dots{display:flex;gap:3px;flex-wrap:wrap;align-items:center}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot-system{background:#ff5050}
.dot-operational{background:#50a0ff}
.dot-auto{background:#ffc83d}
.dot-plus{font-size:9px;color:rgba(180,230,255,0.45);margin-left:1px}

.day-header{margin-bottom:12px}
.back-link{color:rgba(80,180,255,0.7);cursor:pointer;font-size:13px;display:inline-flex;align-items:center;gap:4px;margin-bottom:6px;user-select:none}
.back-link:hover{color:rgba(80,180,255,0.95)}
.day-title{font-size:18px;font-weight:600;color:rgba(180,230,255,0.95)}

.timeline{display:flex;flex-direction:column;gap:2px;max-height:460px;overflow-y:auto}
.timeline::-webkit-scrollbar{width:4px}
.timeline::-webkit-scrollbar-track{background:transparent}
.timeline::-webkit-scrollbar-thumb{background:rgba(80,180,255,0.2);border-radius:2px}
.hour-row{display:flex;gap:10px;align-items:flex-start;padding:6px 0}
.hour-label{width:44px;flex-shrink:0;font-size:12px;color:rgba(80,180,255,0.5);text-align:right;padding-top:4px;font-variant-numeric:tabular-nums}
.hour-events{flex:1;display:flex;flex-direction:column;gap:4px}
.event-chip{background:rgba(10,25,60,0.6);border-left:3px solid;border-radius:4px;padding:6px 10px;font-size:12px}
.event-chip.cat-system{border-left-color:#ff5050}
.event-chip.cat-operational{border-left-color:#50a0ff}
.event-chip.cat-auto{border-left-color:#ffc83d}
.event-name{color:rgba(180,230,255,0.85);margin-bottom:3px;word-break:break-word}
.event-meta{font-size:10px;color:rgba(80,180,255,0.4);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.event-agent{background:rgba(80,180,255,0.1);border:1px solid rgba(80,180,255,0.2);border-radius:3px;padding:0 4px;font-size:9px;color:rgba(80,180,255,0.6)}
.event-schedule{font-family:monospace;font-size:9px;color:rgba(180,230,255,0.3)}
.gap-indicator{text-align:center;color:rgba(80,180,255,0.2);font-size:14px;padding:2px 0;letter-spacing:4px}
.empty-msg{text-align:center;padding:40px;color:rgba(80,180,255,0.35);font-size:13px}
</style>
</head>
<body>
<div id="app">
  <div class="cal-header">
    <button class="nav-btn" id="prevBtn">&#9664;</button>
    <span class="month-title" id="monthTitle">Loading...</span>
    <button class="nav-btn" id="nextBtn">&#9654;</button>
  </div>
  <div class="filter-bar">
    <div class="filter-btn active" data-cat="all">All</div>
    <div class="filter-btn" data-cat="system">System</div>
    <div class="filter-btn" data-cat="operational">Operational</div>
    <div class="filter-btn" data-cat="auto">Auto</div>
  </div>
  <div id="monthView">
    <div class="dow-row">
      <div class="dow-cell">S</div><div class="dow-cell">M</div><div class="dow-cell">T</div>
      <div class="dow-cell">W</div><div class="dow-cell">T</div><div class="dow-cell">F</div>
      <div class="dow-cell">S</div>
    </div>
    <div class="cal-grid" id="calGrid"></div>
  </div>
  <div id="dayView" style="display:none">
    <div class="day-header">
      <div class="back-link" id="backBtn">&#9664; Back to <span id="backMonth"></span></div>
      <div class="day-title" id="dayTitle"></div>
    </div>
    <div class="timeline" id="timeline"></div>
  </div>
</div>
<script>
var state = {
  year: 0,
  month: 0,
  data: null,
  filter: 'all',
  view: 'month',
  selectedDay: 0
};

var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function init() {
  var now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth();

  document.getElementById('prevBtn').addEventListener('click', function() {
    state.month--;
    if (state.month < 0) { state.month = 11; state.year--; }
    state.view = 'month';
    fetchMonth();
  });

  document.getElementById('nextBtn').addEventListener('click', function() {
    state.month++;
    if (state.month > 11) { state.month = 0; state.year++; }
    state.view = 'month';
    fetchMonth();
  });

  document.getElementById('backBtn').addEventListener('click', function() {
    state.view = 'month';
    render();
  });

  var filterBtns = document.querySelectorAll('.filter-btn');
  for (var i = 0; i < filterBtns.length; i++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        for (var j = 0; j < filterBtns.length; j++) filterBtns[j].classList.remove('active');
        btn.classList.add('active');
        state.filter = btn.getAttribute('data-cat');
        render();
      });
    })(filterBtns[i]);
  }

  fetchMonth();
  setInterval(fetchMonth, 60000);
}

function fetchMonth() {
  var monthStr = state.year + '-' + pad(state.month + 1);
  var x = new XMLHttpRequest();
  x.open('GET', '/kiosk/calendar?month=' + monthStr);
  x.onload = function() {
    if (x.status === 200) {
      state.data = JSON.parse(x.responseText);
      render();
    }
  };
  x.onerror = function() {
    document.getElementById('calGrid').innerHTML = '<div class="empty-msg" style="grid-column:1/-1">Connection failed</div>';
  };
  x.send();
}

function getDayEvents(dayStr) {
  if (!state.data || !state.data.days || !state.data.days[dayStr]) return [];
  var all = state.data.days[dayStr];
  if (state.filter === 'all') return all;
  var out = [];
  for (var i = 0; i < all.length; i++) {
    if (all[i].cat === state.filter) out.push(all[i]);
  }
  return out;
}

function render() {
  if (state.view === 'month') renderMonth();
  else renderDay();
}

function renderMonth() {
  document.getElementById('monthView').style.display = 'block';
  document.getElementById('dayView').style.display = 'none';
  document.getElementById('monthTitle').textContent = monthNames[state.month] + ' ' + state.year;

  var firstDay = new Date(state.year, state.month, 1).getDay();
  var daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
  var prevDays = new Date(state.year, state.month, 0).getDate();
  var now = new Date();
  var isCurrentMonth = now.getFullYear() === state.year && now.getMonth() === state.month;
  var todayDate = now.getDate();

  var grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  // Previous month padding
  for (var i = firstDay - 1; i >= 0; i--) {
    var cell = document.createElement('div');
    cell.className = 'day-cell dim';
    cell.innerHTML = '<span class="day-num">' + (prevDays - i) + '</span>';
    grid.appendChild(cell);
  }

  // Current month days
  for (var d = 1; d <= daysInMonth; d++) {
    var cell = document.createElement('div');
    cell.className = 'day-cell';
    if (isCurrentMonth && d === todayDate) cell.className += ' today';

    var evts = getDayEvents(d.toString());
    var inner = '<span class="day-num">' + d + '</span>';

    if (evts.length > 0) {
      cell.className += ' has-events';
      inner += '<div class="dots">';
      var max = Math.min(evts.length, 4);
      for (var e = 0; e < max; e++) {
        inner += '<span class="dot dot-' + evts[e].cat + '"></span>';
      }
      if (evts.length > 4) {
        inner += '<span class="dot-plus">+' + (evts.length - 4) + '</span>';
      }
      inner += '</div>';

      (function(day) {
        cell.addEventListener('click', function() {
          state.selectedDay = day;
          state.view = 'day';
          render();
        });
      })(d);
    }

    cell.innerHTML = inner;
    grid.appendChild(cell);
  }

  // Next month padding (fill remaining cells in last row)
  var totalCells = firstDay + daysInMonth;
  var remaining = (7 - (totalCells % 7)) % 7;
  for (var i = 1; i <= remaining; i++) {
    var cell = document.createElement('div');
    cell.className = 'day-cell dim';
    cell.innerHTML = '<span class="day-num">' + i + '</span>';
    grid.appendChild(cell);
  }
}

function renderDay() {
  document.getElementById('monthView').style.display = 'none';
  document.getElementById('dayView').style.display = 'block';
  document.getElementById('backMonth').textContent = monthNames[state.month] + ' ' + state.year;

  var dateObj = new Date(state.year, state.month, state.selectedDay);
  var dayName = dayNames[dateObj.getDay()];
  document.getElementById('dayTitle').textContent = dayName + ', ' + monthNames[state.month] + ' ' + state.selectedDay;

  var evts = getDayEvents(state.selectedDay.toString());
  var timeline = document.getElementById('timeline');
  timeline.innerHTML = '';

  if (evts.length === 0) {
    timeline.innerHTML = '<div class="empty-msg">No events this day</div>';
    return;
  }

  // Group by hour
  var hours = {};
  for (var i = 0; i < evts.length; i++) {
    var h = evts[i].time.split(':')[0];
    if (!hours[h]) hours[h] = [];
    hours[h].push(evts[i]);
  }

  var hourKeys = Object.keys(hours).sort();

  for (var hi = 0; hi < hourKeys.length; hi++) {
    // Gap indicator between non-consecutive hours
    if (hi > 0) {
      var prevHour = parseInt(hourKeys[hi - 1], 10);
      var thisHour = parseInt(hourKeys[hi], 10);
      if (thisHour - prevHour > 1) {
        var gap = document.createElement('div');
        gap.className = 'gap-indicator';
        gap.textContent = '...';
        timeline.appendChild(gap);
      }
    }

    var row = document.createElement('div');
    row.className = 'hour-row';

    var label = document.createElement('div');
    label.className = 'hour-label';
    label.textContent = hourKeys[hi] + ':00';
    row.appendChild(label);

    var evtsDiv = document.createElement('div');
    evtsDiv.className = 'hour-events';

    var hourEvts = hours[hourKeys[hi]];
    for (var ei = 0; ei < hourEvts.length; ei++) {
      var evt = hourEvts[ei];
      var chip = document.createElement('div');
      chip.className = 'event-chip cat-' + evt.cat;

      var nameDiv = document.createElement('div');
      nameDiv.className = 'event-name';
      nameDiv.textContent = evt.name;
      chip.appendChild(nameDiv);

      var meta = document.createElement('div');
      meta.className = 'event-meta';

      var timeSpan = document.createElement('span');
      timeSpan.textContent = evt.time;
      meta.appendChild(timeSpan);

      if (evt.agent) {
        var agentSpan = document.createElement('span');
        agentSpan.className = 'event-agent';
        agentSpan.textContent = evt.agent;
        meta.appendChild(agentSpan);
      }

      if (evt.schedule) {
        var schedSpan = document.createElement('span');
        schedSpan.className = 'event-schedule';
        schedSpan.textContent = evt.schedule;
        meta.appendChild(schedSpan);
      }

      chip.appendChild(meta);
      evtsDiv.appendChild(chip);
    }

    row.appendChild(evtsDiv);
    timeline.appendChild(row);
  }
}

init();
</script>
</body>
</html>`;
}
