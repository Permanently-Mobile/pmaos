/**
 * Vault Browser Page -- Standalone HTML page served as a kiosk pop-up.
 * Self-contained (inline CSS + JS), no external dependencies.
 * Fetches directory listings from /kiosk/vault-browse?path=...
 * and renders a file explorer with markdown preview.
 */

export function getVaultBrowserPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault Browser</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050a19;color:rgba(180,230,255,0.85);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;overflow:hidden;height:100vh}
#app{display:flex;flex-direction:column;height:100vh;padding:0}

/* ── Header ── */
.vb-header{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid rgba(80,180,255,0.1);flex-shrink:0;background:rgba(5,10,25,0.95)}
.vb-home-btn{background:none;border:1px solid rgba(80,180,255,0.25);color:rgba(80,180,255,0.7);width:30px;height:30px;border-radius:6px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;flex-shrink:0}
.vb-home-btn:hover{background:rgba(80,180,255,0.1);border-color:rgba(80,180,255,0.5)}
.vb-title{font-size:15px;font-weight:600;color:rgba(180,230,255,0.95);letter-spacing:0.3px;white-space:nowrap}
.vb-breadcrumb{display:flex;align-items:center;gap:4px;flex:1;overflow-x:auto;white-space:nowrap;font-size:12px;color:rgba(80,180,255,0.5);scrollbar-width:none}
.vb-breadcrumb::-webkit-scrollbar{display:none}
.vb-crumb{color:rgba(80,180,255,0.6);cursor:pointer;padding:2px 6px;border-radius:4px;transition:all 0.15s;flex-shrink:0}
.vb-crumb:hover{color:rgba(80,180,255,0.9);background:rgba(80,180,255,0.08)}
.vb-crumb.current{color:rgba(180,230,255,0.8);cursor:default}
.vb-crumb.current:hover{background:none}
.vb-sep{color:rgba(80,180,255,0.25);flex-shrink:0}
.vb-search{background:rgba(10,20,50,0.6);border:1px solid rgba(80,180,255,0.15);color:rgba(180,230,255,0.85);padding:5px 10px;border-radius:6px;font-size:12px;width:200px;outline:none;transition:border-color 0.15s;flex-shrink:0}
.vb-search:focus{border-color:rgba(80,180,255,0.4)}
.vb-search::placeholder{color:rgba(80,180,255,0.3)}

/* ── Main content area ── */
.vb-body{display:flex;flex:1;overflow:hidden}

/* ── File list (left side) ── */
.vb-filelist{width:340px;min-width:280px;max-width:500px;border-right:1px solid rgba(80,180,255,0.08);overflow-y:auto;flex-shrink:0;background:rgba(5,10,25,0.3)}
.vb-filelist::-webkit-scrollbar{width:5px}
.vb-filelist::-webkit-scrollbar-track{background:transparent}
.vb-filelist::-webkit-scrollbar-thumb{background:rgba(80,180,255,0.15);border-radius:3px}
.vb-item{display:flex;align-items:center;gap:8px;padding:8px 14px;cursor:pointer;border-bottom:1px solid rgba(80,180,255,0.04);transition:background 0.1s}
.vb-item:hover{background:rgba(80,180,255,0.06)}
.vb-item.active{background:rgba(80,180,255,0.1);border-left:2px solid rgba(80,180,255,0.5)}
.vb-item.active:hover{background:rgba(80,180,255,0.12)}
.vb-icon{width:18px;height:18px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:14px}
.vb-icon.dir{color:rgba(255,200,60,0.7)}
.vb-icon.file{color:rgba(80,180,255,0.5)}
.vb-icon.md{color:rgba(100,220,180,0.7)}
.vb-item-info{flex:1;min-width:0}
.vb-item-name{font-size:13px;color:rgba(180,230,255,0.85);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vb-item-meta{font-size:10px;color:rgba(80,180,255,0.35);margin-top:1px}
.vb-back-item{color:rgba(80,180,255,0.5)}
.vb-back-item .vb-item-name{color:rgba(80,180,255,0.6)}
.vb-empty{text-align:center;padding:40px 20px;color:rgba(80,180,255,0.3);font-size:13px}

/* ── Preview pane (right side) ── */
.vb-preview{flex:1;overflow-y:auto;padding:20px 28px;background:rgba(8,15,30,0.4)}
.vb-preview::-webkit-scrollbar{width:5px}
.vb-preview::-webkit-scrollbar-track{background:transparent}
.vb-preview::-webkit-scrollbar-thumb{background:rgba(80,180,255,0.15);border-radius:3px}

.vb-preview-empty{display:flex;align-items:center;justify-content:center;height:100%;color:rgba(80,180,255,0.25);font-size:14px}

/* ── Markdown rendering ── */
.vb-md h1{font-size:22px;font-weight:700;color:rgba(180,230,255,0.95);margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(80,180,255,0.1)}
.vb-md h2{font-size:18px;font-weight:600;color:rgba(180,230,255,0.9);margin:20px 0 8px;padding-bottom:4px;border-bottom:1px solid rgba(80,180,255,0.06)}
.vb-md h3{font-size:15px;font-weight:600;color:rgba(180,230,255,0.85);margin:16px 0 6px}
.vb-md h4{font-size:13px;font-weight:600;color:rgba(180,230,255,0.8);margin:14px 0 4px}
.vb-md p{font-size:13px;line-height:1.7;margin:0 0 10px;color:rgba(180,230,255,0.75)}
.vb-md ul,.vb-md ol{font-size:13px;line-height:1.7;margin:0 0 10px;padding-left:24px;color:rgba(180,230,255,0.75)}
.vb-md li{margin-bottom:3px}
.vb-md li input[type="checkbox"]{margin-right:6px;accent-color:rgba(80,180,255,0.6)}
.vb-md code{background:rgba(80,180,255,0.08);color:rgba(100,220,200,0.8);padding:1px 5px;border-radius:3px;font-size:12px;font-family:'SF Mono',Menlo,Monaco,monospace}
.vb-md pre{background:rgba(10,20,45,0.6);border:1px solid rgba(80,180,255,0.1);border-radius:6px;padding:14px;margin:0 0 12px;overflow-x:auto;font-size:12px;line-height:1.5}
.vb-md pre code{background:none;padding:0;color:rgba(180,230,255,0.75)}
.vb-md blockquote{border-left:3px solid rgba(80,180,255,0.3);padding:4px 14px;margin:0 0 10px;color:rgba(180,230,255,0.6);font-style:italic}
.vb-md table{border-collapse:collapse;margin:0 0 12px;width:100%;font-size:12px}
.vb-md th{background:rgba(80,180,255,0.08);color:rgba(180,230,255,0.85);padding:6px 10px;text-align:left;border:1px solid rgba(80,180,255,0.12);font-weight:600}
.vb-md td{padding:5px 10px;border:1px solid rgba(80,180,255,0.08);color:rgba(180,230,255,0.7)}
.vb-md tr:hover td{background:rgba(80,180,255,0.03)}
.vb-md a{color:rgba(80,180,255,0.8);text-decoration:none}
.vb-md a:hover{text-decoration:underline}
.vb-md hr{border:none;border-top:1px solid rgba(80,180,255,0.1);margin:16px 0}
.vb-md img{max-width:100%;border-radius:4px;margin:8px 0}
.vb-md strong{color:rgba(180,230,255,0.95)}
.vb-md em{color:rgba(180,230,255,0.7)}
.vb-md del{color:rgba(180,230,255,0.4);text-decoration:line-through}
.vb-md .frontmatter{background:rgba(80,180,255,0.05);border:1px solid rgba(80,180,255,0.1);border-radius:6px;padding:10px 14px;margin:0 0 16px;font-size:11px;color:rgba(80,180,255,0.5);font-family:'SF Mono',Menlo,Monaco,monospace;white-space:pre-wrap}

/* ── Resize handle ── */
.vb-resizer{width:4px;cursor:col-resize;background:transparent;flex-shrink:0;transition:background 0.15s}
.vb-resizer:hover,.vb-resizer.active{background:rgba(80,180,255,0.2)}

/* ── Loading ── */
.vb-loading{text-align:center;padding:40px;color:rgba(80,180,255,0.3);font-size:13px}

/* ── Edit mode ── */
.vb-edit-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(80,180,255,0.1);flex-shrink:0;background:rgba(8,15,30,0.6)}
.vb-edit-bar .vb-filename{flex:1;font-size:13px;color:rgba(180,230,255,0.8);font-weight:500}
.vb-edit-btn{background:none;border:1px solid rgba(80,180,255,0.25);color:rgba(80,180,255,0.7);padding:4px 12px;border-radius:5px;cursor:pointer;font-size:12px;transition:all 0.15s}
.vb-edit-btn:hover{background:rgba(80,180,255,0.1);border-color:rgba(80,180,255,0.5)}
.vb-edit-btn.save{border-color:rgba(80,220,120,0.4);color:rgba(80,220,120,0.8)}
.vb-edit-btn.save:hover{background:rgba(80,220,120,0.1);border-color:rgba(80,220,120,0.6)}
.vb-edit-btn.cancel{border-color:rgba(255,100,80,0.3);color:rgba(255,100,80,0.7)}
.vb-edit-btn.cancel:hover{background:rgba(255,100,80,0.08);border-color:rgba(255,100,80,0.5)}
.vb-editor{width:100%;flex:1;background:rgba(10,20,45,0.6);color:rgba(180,230,255,0.85);border:none;padding:16px 20px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:13px;line-height:1.6;resize:none;outline:none;tab-size:2}
.vb-editor::placeholder{color:rgba(80,180,255,0.25)}
.vb-save-status{font-size:11px;color:rgba(80,220,120,0.7);padding:0 4px}
.vb-save-error{font-size:11px;color:rgba(255,100,80,0.8);padding:0 4px}
</style>
</head>
<body>
<div id="app">
  <div class="vb-header">
    <button class="vb-home-btn" id="homeBtn" title="Vault root">&#8962;</button>
    <div class="vb-title">VAULT</div>
    <div class="vb-breadcrumb" id="breadcrumb"></div>
    <input type="text" class="vb-search" id="searchBox" placeholder="Search files...">
  </div>
  <div class="vb-body">
    <div class="vb-filelist" id="fileList"></div>
    <div class="vb-resizer" id="resizer"></div>
    <div class="vb-preview" id="preview">
      <div class="vb-preview-empty">Select a file to preview</div>
    </div>
  </div>
</div>
<script>
var state = {
  currentPath: '',
  entries: [],
  activeFile: null,
  searchTerm: '',
  searchTimeout: null,
  rawContent: '',
  editingFile: null,
  isEditing: false
};

function fetchDir(dirPath) {
  state.currentPath = dirPath || '';
  state.activeFile = null;
  document.getElementById('fileList').innerHTML = '<div class="vb-loading">Loading...</div>';
  var url = '/kiosk/vault-browse?path=' + encodeURIComponent(state.currentPath);
  var x = new XMLHttpRequest();
  x.open('GET', url);
  x.timeout = 8000;
  x.onload = function() {
    try {
      var data = JSON.parse(x.responseText);
      if (data.error) {
        document.getElementById('fileList').innerHTML = '<div class="vb-empty">' + escHtml(data.error) + '</div>';
        return;
      }
      state.entries = data.entries || [];
      renderFileList();
      renderBreadcrumb();
      document.getElementById('preview').innerHTML = '<div class="vb-preview-empty">Select a file to preview</div>';
    } catch(e) {
      document.getElementById('fileList').innerHTML = '<div class="vb-empty">Failed to parse response</div>';
    }
  };
  x.onerror = function() {
    document.getElementById('fileList').innerHTML = '<div class="vb-empty">Connection failed -- server may be restarting</div>';
  };
  x.ontimeout = function() {
    document.getElementById('fileList').innerHTML = '<div class="vb-empty">Request timed out</div>';
  };
  x.send();
}

function fetchFile(filePath) {
  state.activeFile = filePath;
  var url = '/kiosk/vault-browse?path=' + encodeURIComponent(filePath) + '&content=1';
  var preview = document.getElementById('preview');
  preview.innerHTML = '<div class="vb-loading">Loading...</div>';

  var x = new XMLHttpRequest();
  x.open('GET', url);
  x.onload = function() {
    if (x.status === 200) {
      var data = JSON.parse(x.responseText);
      if (data.error) {
        preview.innerHTML = '<div class="vb-empty">' + escHtml(data.error) + '</div>';
        return;
      }
      renderPreview(data.content || '', data.name || '');
      // highlight active item
      var items = document.querySelectorAll('.vb-item');
      for (var i = 0; i < items.length; i++) {
        items[i].classList.remove('active');
        if (items[i].getAttribute('data-path') === filePath) {
          items[i].classList.add('active');
        }
      }
    }
  };
  x.send();
}

function searchFiles(term) {
  if (!term || term.length < 2) {
    fetchDir(state.currentPath);
    return;
  }
  var url = '/kiosk/vault-browse?search=' + encodeURIComponent(term);
  var x = new XMLHttpRequest();
  x.open('GET', url);
  x.onload = function() {
    if (x.status === 200) {
      var data = JSON.parse(x.responseText);
      state.entries = data.entries || [];
      renderFileList(true);
    }
  };
  x.send();
}

function renderFileList(isSearch) {
  var list = document.getElementById('fileList');
  var html = '';

  // Back button (if not at root and not searching)
  if (state.currentPath && !isSearch) {
    var parentPath = state.currentPath.split('/').slice(0, -1).join('/');
    html += '<div class="vb-item vb-back-item" data-dir="' + escAttr(parentPath) + '">';
    html += '<div class="vb-icon dir">&#8617;</div>';
    html += '<div class="vb-item-info"><div class="vb-item-name">..</div></div>';
    html += '</div>';
  }

  // Sort: directories first, then files, alphabetical
  var dirs = [];
  var files = [];
  for (var i = 0; i < state.entries.length; i++) {
    if (state.entries[i].type === 'dir') dirs.push(state.entries[i]);
    else files.push(state.entries[i]);
  }
  dirs.sort(function(a, b) { return a.name.localeCompare(b.name); });
  files.sort(function(a, b) { return a.name.localeCompare(b.name); });
  var sorted = dirs.concat(files);

  if (sorted.length === 0 && !state.currentPath) {
    html += '<div class="vb-empty">Vault is empty</div>';
  } else if (sorted.length === 0 && isSearch) {
    html += '<div class="vb-empty">No results</div>';
  }

  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i];
    var icon = '';
    var iconClass = '';

    if (entry.type === 'dir') {
      icon = '&#128193;';
      iconClass = 'dir';
    } else if (entry.name.endsWith('.md')) {
      icon = '&#128196;';
      iconClass = 'md';
    } else {
      icon = '&#128196;';
      iconClass = 'file';
    }

    var fullPath = entry.path || (state.currentPath ? state.currentPath + '/' + entry.name : entry.name);
    var activeClass = (state.activeFile === fullPath) ? ' active' : '';

    html += '<div class="vb-item' + activeClass + '" data-' + entry.type + '="' + escAttr(fullPath) + '" data-path="' + escAttr(fullPath) + '">';
    html += '<div class="vb-icon ' + iconClass + '">' + icon + '</div>';
    html += '<div class="vb-item-info">';
    html += '<div class="vb-item-name">' + escHtml(entry.name) + '</div>';
    var meta = '';
    if (entry.size) meta += formatSize(entry.size);
    if (entry.modified) {
      if (meta) meta += ' &middot; ';
      meta += formatDate(entry.modified);
    }
    if (isSearch && entry.path) {
      meta = escHtml(entry.path.replace(/\\/[^\\/]*$/, ''));
    }
    if (meta) html += '<div class="vb-item-meta">' + meta + '</div>';
    html += '</div></div>';
  }

  list.innerHTML = html;

  // Attach click handlers
  var items = list.querySelectorAll('.vb-item');
  for (var j = 0; j < items.length; j++) {
    (function(item) {
      item.addEventListener('click', function() {
        var dir = item.getAttribute('data-dir');
        var file = item.getAttribute('data-file');
        if (dir !== null) {
          document.getElementById('searchBox').value = '';
          state.searchTerm = '';
          fetchDir(dir);
        } else if (file !== null) {
          fetchFile(file);
        }
      });
    })(items[j]);
  }
}

function renderBreadcrumb() {
  var bc = document.getElementById('breadcrumb');
  var parts = state.currentPath ? state.currentPath.split('/') : [];
  var html = '<span class="vb-crumb' + (parts.length === 0 ? ' current' : '') + '" data-path="">Vault</span>';

  var accumulated = '';
  for (var i = 0; i < parts.length; i++) {
    accumulated += (i === 0 ? '' : '/') + parts[i];
    html += '<span class="vb-sep">/</span>';
    var isCurrent = (i === parts.length - 1);
    html += '<span class="vb-crumb' + (isCurrent ? ' current' : '') + '" data-path="' + escAttr(accumulated) + '">' + escHtml(parts[i]) + '</span>';
  }

  bc.innerHTML = html;

  var crumbs = bc.querySelectorAll('.vb-crumb:not(.current)');
  for (var j = 0; j < crumbs.length; j++) {
    (function(crumb) {
      crumb.addEventListener('click', function() {
        document.getElementById('searchBox').value = '';
        state.searchTerm = '';
        fetchDir(crumb.getAttribute('data-path'));
      });
    })(crumbs[j]);
  }
}

function renderPreview(content, filename) {
  var preview = document.getElementById('preview');
  state.rawContent = content;
  state.editingFile = state.activeFile;
  state.isEditing = false;

  // Edit bar with filename and edit button
  var barHtml = '<div class="vb-edit-bar">';
  barHtml += '<span class="vb-filename">' + escHtml(filename) + '</span>';
  barHtml += '<span id="saveStatus"></span>';
  var isTemplate = (state.activeFile || '').indexOf('Templates') === 0;
  if (!isTemplate) {
    barHtml += '<button class="vb-edit-btn" id="editToggleBtn">Edit</button>';
  }
  barHtml += '</div>';

  var contentHtml = '';
  if (!filename.endsWith('.md')) {
    contentHtml = '<div class="vb-md" id="previewContent" style="padding:20px 28px;flex:1;overflow-y:auto"><pre><code>' + escHtml(content) + '</code></pre></div>';
  } else {
    var body = content;
    var frontmatter = '';
    if (content.startsWith('---')) {
      var endIdx = content.indexOf('---', 3);
      if (endIdx !== -1) {
        frontmatter = content.substring(3, endIdx).trim();
        body = content.substring(endIdx + 3).trim();
      }
    }
    contentHtml = '<div class="vb-md" id="previewContent" style="padding:20px 28px;flex:1;overflow-y:auto">';
    if (frontmatter) {
      contentHtml += '<div class="frontmatter">' + escHtml(frontmatter) + '</div>';
    }
    contentHtml += renderMarkdown(body);
    contentHtml += '</div>';
  }

  preview.style.display = 'flex';
  preview.style.flexDirection = 'column';
  preview.innerHTML = barHtml + contentHtml;
  preview.scrollTop = 0;

  // Wire edit toggle
  var editBtn = document.getElementById('editToggleBtn');
  if (editBtn) {
    editBtn.addEventListener('click', function() {
      if (state.isEditing) {
        exitEditMode();
      } else {
        enterEditMode();
      }
    });
  }
}

function enterEditMode() {
  state.isEditing = true;
  var preview = document.getElementById('preview');
  var previewContent = document.getElementById('previewContent');
  var editBtn = document.getElementById('editToggleBtn');
  var statusEl = document.getElementById('saveStatus');

  if (editBtn) {
    editBtn.textContent = 'Preview';
  }

  // Replace preview with editor + save/cancel bar
  var editorHtml = '<div style="display:flex;gap:6px;padding:6px 12px;border-bottom:1px solid rgba(80,180,255,0.06)">';
  editorHtml += '<button class="vb-edit-btn save" id="saveBtn">Save</button>';
  editorHtml += '<button class="vb-edit-btn cancel" id="cancelBtn">Cancel</button>';
  editorHtml += '</div>';
  editorHtml += '<textarea class="vb-editor" id="editorArea">' + escHtml(state.rawContent) + '</textarea>';

  if (previewContent) {
    previewContent.outerHTML = editorHtml;
  }

  // Focus editor
  var editor = document.getElementById('editorArea');
  if (editor) editor.focus();

  // Tab key inserts tab instead of changing focus
  if (editor) {
    editor.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = editor.selectionStart;
        var end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
      // Ctrl+S / Cmd+S to save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveFile();
      }
    });
  }

  // Wire save button
  var saveBtn = document.getElementById('saveBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveFile);

  // Wire cancel button
  var cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', function() {
    exitEditMode();
  });
}

function exitEditMode() {
  state.isEditing = false;
  // Re-render preview with current raw content
  renderPreview(state.rawContent, state.editingFile ? state.editingFile.split('/').pop() : '');
}

function saveFile() {
  var editor = document.getElementById('editorArea');
  var statusEl = document.getElementById('saveStatus');
  if (!editor || !state.editingFile) return;

  var newContent = editor.value;
  if (statusEl) { statusEl.className = 'vb-save-status'; statusEl.textContent = 'Saving...'; }

  var x = new XMLHttpRequest();
  x.open('POST', '/kiosk/vault-save');
  x.setRequestHeader('Content-Type', 'application/json');
  x.timeout = 10000;
  x.onload = function() {
    try {
      var data = JSON.parse(x.responseText);
      if (data.ok) {
        state.rawContent = newContent;
        if (statusEl) { statusEl.className = 'vb-save-status'; statusEl.textContent = 'Saved'; }
        setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2000);
      } else {
        if (statusEl) { statusEl.className = 'vb-save-error'; statusEl.textContent = data.error || 'Save failed'; }
      }
    } catch(e) {
      if (statusEl) { statusEl.className = 'vb-save-error'; statusEl.textContent = 'Save failed'; }
    }
  };
  x.onerror = function() {
    if (statusEl) { statusEl.className = 'vb-save-error'; statusEl.textContent = 'Connection failed'; }
  };
  x.send(JSON.stringify({ path: state.editingFile, content: newContent }));
}

function renderMarkdown(text) {
  var lines = text.split('\\n');
  var html = '';
  var inCode = false;
  var inTable = false;
  var inList = false;
  var listType = '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Code blocks
    if (line.match(/^\`\`\`/)) {
      if (inCode) {
        html += '</code></pre>';
        inCode = false;
      } else {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        if (inTable) { html += '</table>'; inTable = false; }
        html += '<pre><code>';
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      html += escHtml(line) + '\\n';
      continue;
    }

    // Table rows
    if (line.match(/^\\|/)) {
      // Skip separator rows
      if (line.match(/^\\|[\\s-:|]+\\|$/)) continue;
      if (!inTable) {
        if (inList) { html += '</' + listType + '>'; inList = false; }
        html += '<table>';
        inTable = true;
        // First table row is header
        var cells = line.split('|').filter(function(c) { return c.trim(); });
        html += '<tr>';
        for (var c = 0; c < cells.length; c++) {
          html += '<th>' + inlineMarkdown(cells[c].trim()) + '</th>';
        }
        html += '</tr>';
        // Skip next line if separator
        if (i + 1 < lines.length && lines[i + 1].match(/^\\|[\\s-:|]+\\|$/)) i++;
        continue;
      }
      var cells = line.split('|').filter(function(c) { return c.trim(); });
      html += '<tr>';
      for (var c = 0; c < cells.length; c++) {
        html += '<td>' + inlineMarkdown(cells[c].trim()) + '</td>';
      }
      html += '</tr>';
      continue;
    }
    if (inTable && !line.match(/^\\|/)) {
      html += '</table>';
      inTable = false;
    }

    // Headings
    var hMatch = line.match(/^(#{1,6})\\s+(.+)/);
    if (hMatch) {
      if (inList) { html += '</' + listType + '>'; inList = false; }
      var level = hMatch[1].length;
      html += '<h' + level + '>' + inlineMarkdown(hMatch[2]) + '</h' + level + '>';
      continue;
    }

    // Horizontal rules
    if (line.match(/^(---|\\*\\*\\*|___)\\s*$/)) {
      if (inList) { html += '</' + listType + '>'; inList = false; }
      html += '<hr>';
      continue;
    }

    // Blockquotes
    if (line.match(/^>\\s?/)) {
      if (inList) { html += '</' + listType + '>'; inList = false; }
      html += '<blockquote>' + inlineMarkdown(line.replace(/^>\\s?/, '')) + '</blockquote>';
      continue;
    }

    // Unordered list
    var ulMatch = line.match(/^(\\s*)[-*+]\\s+(.*)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) html += '</' + listType + '>';
        html += '<ul>';
        inList = true;
        listType = 'ul';
      }
      // Checkbox
      var liContent = ulMatch[2];
      if (liContent.match(/^\\[x\\]/i)) {
        html += '<li><input type="checkbox" checked disabled>' + inlineMarkdown(liContent.replace(/^\\[x\\]\\s*/i, '')) + '</li>';
      } else if (liContent.match(/^\\[ \\]/)) {
        html += '<li><input type="checkbox" disabled>' + inlineMarkdown(liContent.replace(/^\\[ \\]\\s*/, '')) + '</li>';
      } else {
        html += '<li>' + inlineMarkdown(liContent) + '</li>';
      }
      continue;
    }

    // Ordered list
    var olMatch = line.match(/^(\\s*)\\d+\\.\\s+(.*)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) html += '</' + listType + '>';
        html += '<ol>';
        inList = true;
        listType = 'ol';
      }
      html += '<li>' + inlineMarkdown(olMatch[2]) + '</li>';
      continue;
    }

    // Close list if line is not a list item
    if (inList && line.trim() === '') {
      html += '</' + listType + '>';
      inList = false;
    }

    // Empty lines
    if (line.trim() === '') continue;

    // Paragraph
    html += '<p>' + inlineMarkdown(line) + '</p>';
  }

  if (inList) html += '</' + listType + '>';
  if (inTable) html += '</table>';
  if (inCode) html += '</code></pre>';

  return html;
}

function inlineMarkdown(text) {
  // Bold
  text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  text = text.replace(/_(.+?)_/g, '<em>$1</em>');
  // Strikethrough
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Inline code
  text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Links
  text = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
  // Obsidian wikilinks
  text = text.replace(/\\[\\[([^\\]|]+?)\\|([^\\]]+?)\\]\\]/g, '<strong>$2</strong>');
  text = text.replace(/\\[\\[([^\\]]+?)\\]\\]/g, '<strong>$1</strong>');
  return text;
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(isoStr) {
  try {
    var d = new Date(isoStr);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  } catch(e) { return ''; }
}

// ── Resize handle ──
var resizer = document.getElementById('resizer');
var fileList = document.getElementById('fileList');
var isResizing = false;

resizer.addEventListener('mousedown', function(e) {
  isResizing = true;
  resizer.classList.add('active');
  e.preventDefault();
});

document.addEventListener('mousemove', function(e) {
  if (!isResizing) return;
  var newWidth = e.clientX;
  if (newWidth < 200) newWidth = 200;
  if (newWidth > 600) newWidth = 600;
  fileList.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', function() {
  if (isResizing) {
    isResizing = false;
    resizer.classList.remove('active');
  }
});

// ── Search ──
var searchBox = document.getElementById('searchBox');
searchBox.addEventListener('input', function() {
  state.searchTerm = searchBox.value.trim();
  clearTimeout(state.searchTimeout);
  state.searchTimeout = setTimeout(function() {
    if (state.searchTerm.length >= 2) {
      searchFiles(state.searchTerm);
    } else if (state.searchTerm.length === 0) {
      fetchDir(state.currentPath);
    }
  }, 300);
});

// ── Home button ──
document.getElementById('homeBtn').addEventListener('click', function() {
  searchBox.value = '';
  state.searchTerm = '';
  fetchDir('');
});

// ── Keyboard nav ──
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    searchBox.value = '';
    state.searchTerm = '';
    fetchDir(state.currentPath);
  }
  if (e.key === 'Backspace' && document.activeElement !== searchBox && state.currentPath) {
    var parentPath = state.currentPath.split('/').slice(0, -1).join('/');
    fetchDir(parentPath);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    searchBox.focus();
    searchBox.select();
  }
});

// ── Init ──
fetchDir('');
</script>
</body>
</html>`;
}
