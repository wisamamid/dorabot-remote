/**
 * The local control page, served on 127.0.0.1 only.
 *
 * This is where you generate a pairing QR, see which devices are paired, and
 * approve a device's request for a stronger permission such as the terminal.
 * It is deliberately a single self-contained string: the bridge should install
 * and run with no build step and no static asset directory.
 */
export const CONTROL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>dorabot remote</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0c0e;
    --panel: #141619;
    --panel-2: #1b1e23;
    --line: #272b31;
    --text: #e7e9ec;
    --muted: #8b929c;
    --accent: #6ee7a8;
    --warn: #f0b429;
    --danger: #f2706b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
    padding: 40px 24px 80px;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
       color: var(--muted); margin: 36px 0 12px; }
  .sub { color: var(--muted); margin: 0 0 28px; font-size: 13px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
  .row { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
  .stack { display: flex; flex-direction: column; gap: 10px; }
  button {
    font: inherit; font-weight: 500; cursor: pointer; border-radius: 8px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--text);
    padding: 8px 14px; transition: border-color .12s, background .12s;
  }
  button:hover { border-color: #3b424b; }
  button.primary { background: var(--accent); color: #06281a; border-color: transparent; font-weight: 600; }
  button.danger { color: var(--danger); }
  button.small { padding: 5px 10px; font-size: 13px; }
  code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .pill { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
          color: var(--muted); }
  .pill.on { color: var(--accent); border-color: #1f4b36; background: #0e2119; }
  .pill.off { color: var(--danger); border-color: #4a2220; background: #210f0f; }
  .qr { display: flex; gap: 22px; align-items: flex-start; }
  .qr img { width: 208px; height: 208px; border-radius: 10px; background: #fff; padding: 10px; }
  .code { font-size: 22px; letter-spacing: 0.14em; font-weight: 600; }
  .muted { color: var(--muted); }
  .small { font-size: 12.5px; }
  ul.addr { margin: 8px 0 0; padding: 0; list-style: none; }
  ul.addr li { color: var(--muted); font-size: 12.5px; font-family: ui-monospace, Menlo, monospace; }
  .device { border: 1px solid var(--line); border-radius: 10px; padding: 14px; background: var(--panel); }
  .device + .device { margin-top: 10px; }
  .scopes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .scope { font-size: 12px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--line);
           color: var(--muted); cursor: pointer; user-select: none; }
  .scope.active { color: var(--text); border-color: #3a7f60; background: #11241b; }
  .scope.danger.active { border-color: #7a3b38; background: #2a1413; color: #f6b3b0; }
  .request { border: 1px solid #574212; background: #211a08; border-radius: 10px; padding: 14px; }
  .request + .request { margin-top: 10px; }
  pre.log { background: #0e1013; border: 1px solid var(--line); border-radius: 10px; padding: 14px;
            max-height: 240px; overflow: auto; font-size: 12px; color: var(--muted); margin: 0; }
  select.dur { padding: 5px 8px; font-size: 13px; }
  input[type=text], select { font: inherit; background: var(--panel-2); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; }
  table.audit { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.audit td, table.audit th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.audit th { color: var(--muted); font-weight: 500; }
  .empty { color: var(--muted); font-size: 13px; padding: 10px 0; }
</style>
</head>
<body>
<main>
  <h1>dorabot remote</h1>
  <p class="sub">Pair a phone with this Mac. Everything stays on your own network or your own Tailnet, end to end encrypted.</p>

  <div class="card">
    <div class="row">
      <div>
        <div style="font-weight:600">Host <span id="host-name" class="mono"></span></div>
        <div class="small muted">Key fingerprint <span id="host-fp" class="mono"></span></div>
      </div>
      <span id="gw" class="pill">checking…</span>
      <span id="relay" class="pill" style="display:none"></span>
    </div>
  </div>

  <div id="pending"></div>

  <h2>Pair a device</h2>
  <div class="card" id="pair-card">
    <div class="row">
      <div class="small muted">Codes are single use and expire after five minutes.</div>
      <button class="primary" onclick="newPairing()">Show pairing code</button>
    </div>
    <div id="pair-out" style="margin-top:18px"></div>
  </div>

  <h2>Permission requests</h2>
  <div id="requests"></div>

  <div class="row" style="margin:36px 0 12px">
    <h2 style="margin:0">Paired devices</h2>
    <span style="display:flex;gap:8px">
      <button class="small" id="rotate-all" onclick="rotateAll()" style="display:none" title="Give every phone a new relay token (old ones work until the phone confirms, at most 7 days)">Rotate relay tokens</button>
      <button class="small danger" onclick="lockdown()" title="Lost phone? Revoke every device at once">Lockdown: revoke all</button>
    </span>
  </div>
  <div id="devices"></div>

  <h2>Shared folders</h2>
  <div class="card">
    <div class="small muted" style="margin-bottom:10px">Folders your phone may browse (with the files permission). Nothing outside these is shared.</div>
    <div id="roots"></div>
    <div class="row" style="margin-top:12px;gap:8px">
      <input id="root-path" type="text" placeholder="/Users/you/Projects" style="flex:1" />
      <span class="small muted">For:</span><span id="root-dur"></span>
      <button class="small primary" onclick="addRoot()">Add</button>
    </div>
    <div id="root-msg" class="small" style="margin-top:8px;color:var(--danger)"></div>
  </div>

  <h2>Always-allow rules</h2>
  <div class="card">
    <div class="small muted" style="margin-bottom:10px">Tool calls your phone chose to always approve. They are approved here, on the bridge, and recorded in the audit log. Risky actions are never covered. Rules can only be added from the phone (with Face ID).</div>
    <div id="rules"></div>
  </div>

  <h2>Audit log</h2>
  <div class="card">
    <div class="row" style="margin-bottom:10px">
      <div class="small muted">Last 200 security-relevant actions. Prompts and file contents are never logged.</div>
      <select id="audit-filter" onchange="loadAudit()"><option value="">All devices</option></select>
    </div>
    <div id="audit" style="overflow:auto;max-height:340px"></div>
  </div>

  <h2>Activity</h2>
  <pre class="log" id="log"></pre>
</main>

<script>
const SCOPES = ['sessions','chat','approvals','work','files','git','git_write','terminal','admin'];
const RISKY = new Set(['terminal','admin','git_write']);
let state = null;

async function api(path, body) {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 401) {
    document.body.innerHTML = '<main><h1>dorabot remote</h1><p class="sub">Your session ended. Run <code>dorabot-remote open</code> in a terminal on this Mac.</p></main>';
    throw new Error('logged out');
  }
  return r;
}

async function load() {
  const r = await api('/api/state');
  state = await r.json();
  render();
  loadAudit();
}

async function loadAudit() {
  const sel = document.getElementById('audit-filter');
  const dev = sel.value;
  const r = await api('/api/audit?limit=200' + (dev ? '&device=' + encodeURIComponent(dev) : ''));
  const { entries } = await r.json();
  const known = new Map(state.devices.map(d => [d.id, d.name]));
  const opts = ['<option value="">All devices</option>'].concat(
    [...known].map(([id, n]) => '<option value="' + esc(id) + '"' + (id === dev ? ' selected' : '') + '>' + esc(n) + '</option>'));
  if (sel.dataset.sig !== opts.join('')) { sel.innerHTML = opts.join(''); sel.dataset.sig = opts.join(''); sel.value = dev; }
  document.getElementById('audit').innerHTML = entries.length
    ? '<table class="audit"><tr><th>Time</th><th>Device</th><th>Action</th><th>Detail</th><th>Via</th></tr>' +
      entries.map(e => '<tr><td>' + esc(new Date(e.at).toLocaleString()) + '</td><td>' + esc(e.deviceName || (e.deviceId ? e.deviceId.slice(0, 8) : 'this Mac')) +
        '</td><td class="mono">' + esc(e.action === 'rpc' ? e.method : e.action) + '</td><td>' + esc([e.summary, e.requestId ? 'req ' + e.requestId : ''].filter(Boolean).join(' · ')) +
        '</td><td>' + esc(e.transport || '') + '</td></tr>').join('') + '</table>'
    : '<div class="empty">Nothing recorded yet.</div>';
}

function render() {
  // Re-rendering replaces the time-limit pickers; keep what the user chose.
  const picked = {};
  document.querySelectorAll('select.dur').forEach(el => { picked[el.id] = el.value; });
  renderAll();
  document.querySelectorAll('select.dur').forEach(el => { if (picked[el.id] !== undefined) el.value = picked[el.id]; });
}

function renderAll() {
  document.getElementById('host-name').textContent = state.host.name;
  document.getElementById('host-fp').textContent = state.host.fingerprint;
  const gw = document.getElementById('gw');
  gw.textContent = state.gatewayConnected ? 'dorabot connected' : 'dorabot not reachable';
  gw.className = 'pill ' + (state.gatewayConnected ? 'on' : 'off');

  document.getElementById('rotate-all').style.display = state.relay ? '' : 'none';
  const rl = document.getElementById('relay');
  if (state.relay) {
    rl.style.display = '';
    rl.textContent = 'relay ' + state.relay.state;
    rl.className = 'pill ' + (state.relay.state === 'online' ? 'on' : 'off');
  } else {
    rl.style.display = 'none';
  }

  const pend = state.pendingDevices || [];
  document.getElementById('pending').innerHTML = pend.map(d => \`
    <div class="request" style="margin-top:28px">
      <div class="row">
        <div>
          <div><strong>Allow "\${esc(d.name)}" (fingerprint \${esc(d.fingerprint)}) to control dorabot?</strong></div>
          <div class="small muted">\${esc(d.platform)} · will get: \${esc(d.scopes.join(', '))} · expires \${new Date(d.expiresAt).toLocaleTimeString()}.
            Only allow this if you just paired your own phone.</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="small danger" onclick="device('\${d.id}','reject')">Reject</button>
          <button class="small primary" onclick="device('\${d.id}','approve')">Allow</button>
        </div>
      </div>
    </div>\`).join('');

  const roots = document.getElementById('roots');
  roots.innerHTML = state.roots && state.roots.length
    ? state.roots.map(r => '<div class="row" style="padding:4px 0"><span><code>' + esc(r) + '</code>' + (state.rootsExpiry && state.rootsExpiry[r] ? ' <span class="muted small">· ' + left(state.rootsExpiry[r] - Date.now()) + ' left</span>' : '') + '</span><button class="small danger" data-root="' + esc(r) + '" onclick="removeRoot(this.dataset.root)">Remove</button></div>').join('')
    : '<div class="empty">No folders shared.</div>';

  const rules = document.getElementById('rules');
  rules.innerHTML = state.rules && state.rules.length
    ? state.rules.map(r => '<div class="row" style="padding:4px 0"><span><code>' + esc(r.label) + '</code> <span class="muted small">' + esc(r.createdBy || '') + ' · ' + new Date(r.createdAt).toLocaleDateString() + '</span></span><button class="small danger" data-rule="' + esc(r.id) + '" onclick="removeRule(this.dataset.rule)">Remove</button></div>').join('')
    : '<div class="empty">No rules. Every approval is asked.</div>';

  const reqs = document.getElementById('requests');
  if (!state.scopeRequests.length) {
    reqs.innerHTML = '<div class="empty">Nothing waiting.</div>';
  } else {
    reqs.innerHTML = state.scopeRequests.map(r => \`
      <div class="request">
        <div class="row">
          <div>
            <div><strong>\${esc(r.deviceName)}</strong> is asking for <code>\${esc(r.scope)}</code></div>
            <div class="small muted">\${r.reason ? esc(r.reason) : 'No reason given.'}</div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="small" onclick="scope('\${r.id}', false)">Deny</button>
            \${durSelect('dur-req-' + r.id)}
            <button class="small primary" onclick="scope('\${r.id}', true)">Allow</button>
          </div>
        </div>
      </div>\`).join('');
  }

  const dv = document.getElementById('devices');
  if (!state.devices.length) {
    dv.innerHTML = '<div class="empty">No devices paired yet.</div>';
  } else {
    dv.innerHTML = state.devices.map(d => {
      const online = state.connections.some(c => c.device === d.name);
      return \`<div class="device">
        <div class="row">
          <div>
            <div><strong>\${esc(d.name)}</strong>
              <span class="pill \${d.revoked ? 'off' : (online ? 'on' : '')}">\${d.pending ? 'waiting for approval' : d.revoked ? (d.revokedReason === 'expired' ? 'revoked: unseen for 90 days' : d.revokedReason === 'lost' ? 'revoked: marked lost' : d.revokedReason === 'lockdown' ? 'revoked: lockdown' : 'revoked') : (online ? 'connected' : 'offline')}</span>
            </div>
            <div class="small muted mono">\${esc(d.platform)} · \${esc(d.fingerprint)} · \${d.lastSeenAt ? 'last seen ' + new Date(d.lastSeenAt).toLocaleString() : 'never connected'}</div>
          </div>
          <div style="display:flex;gap:8px">
            \${d.revoked
              ? \`<button class="small" onclick="device('\${d.id}','restore')">Restore</button>\`
              : \`\${state.relay && !d.pending ? \`<button class="small" onclick="device('\${d.id}','rotate')" title="New relay token, delivered over the encrypted channel">Rotate token</button>\` : ''}<button class="small danger" onclick="device('\${d.id}','lost')">Lost</button><button class="small danger" onclick="device('\${d.id}','revoke')">Revoke</button>\`}
            <button class="small danger" onclick="device('\${d.id}','delete')">Remove</button>
          </div>
        </div>
        <div class="scopes">
          \${SCOPES.map(s => \`<span class="scope \${d.scopes.includes(s) ? 'active' : ''} \${RISKY.has(s) ? 'danger' : ''}"
             onclick="toggleScope('\${d.id}','\${s}')">\${s}\${d.scopeExpiry && d.scopeExpiry[s] ? ' · ' + left(d.scopeExpiry[s] - Date.now()) + ' left' : ''}</span>\`).join('')}
          <span class="small muted" style="margin-left:6px">Turn on for:</span>\${durSelect('dur-' + d.id)}
        </div>
      </div>\`;
    }).join('');
  }

  document.getElementById('log').textContent = state.log.join('\\n');
}

// Time limits for grants: '' = permanent. 'custom' asks for hours.
function durSelect(id) {
  return '<select id="' + id + '" class="dur" title="How long the permission lasts"><option value="">Permanent</option><option value="3600000">1 hour</option><option value="28800000">8 hours</option><option value="86400000">24 hours</option><option value="custom">Custom…</option></select>';
}
// Returns ms, null (permanent) or undefined (cancelled / invalid).
function readDur(id) {
  const el = document.getElementById(id);
  const v = el ? el.value : '';
  if (v === '') return null;
  if (v !== 'custom') return Number(v);
  const h = Number(prompt('For how many hours? (for example 2 or 0.5; 1 minute to 30 days)') || '');
  if (!Number.isFinite(h) || h <= 0) return undefined;
  return Math.round(h * 3600000);
}
function left(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? h + 'h ' + (m % 60) + 'm' : h + 'h';
  return Math.floor(h / 24) + 'd';
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function newPairing() {
  const r = await api('/api/pair', {});
  const p = await r.json();
  document.getElementById('pair-out').innerHTML = \`
    <div class="qr">
      <img src="\${p.qr}" alt="pairing QR code" />
      <div class="stack">
        <div>
          <div class="small muted">Or type this code into the app</div>
          <div class="code mono">\${esc(p.code)}</div>
        </div>
        <div>
          <div class="small muted">Expires \${new Date(p.expiresAt).toLocaleTimeString()}</div>
          <ul class="addr">\${p.addresses.map(a => '<li>' + esc(a) + '</li>').join('')}</ul>
        </div>
      </div>
    </div>\`;
}

async function scope(requestId, approve) {
  let forMs = null;
  if (approve) {
    forMs = readDur('dur-req-' + requestId);
    if (forMs === undefined) return;
  }
  await api('/api/scope', { requestId, approve, forMs });
  load();
}

async function addRoot() {
  const input = document.getElementById('root-path');
  const forMs = readDur('dur-root');
  if (forMs === undefined) return;
  const r = await api('/api/roots', { action: 'add', path: input.value.trim(), forMs });
  const j = await r.json();
  document.getElementById('root-msg').textContent = j.ok ? '' : (j.error || 'Could not add that folder');
  if (j.ok) input.value = '';
  load();
}

async function removeRoot(path) {
  await api('/api/roots', { action: 'remove', path });
  load();
}

async function removeRule(id) {
  await api('/api/rules', { action: 'remove', id });
  load();
}

async function rotateAll() {
  if (!confirm('Rotate the relay token of every device?\\n\\nPhones receive the new one over the encrypted channel and confirm it. The old token keeps working until they do, at most 7 days.')) return;
  await api('/api/rotate-tokens', {});
  load();
}

async function lockdown() {
  const n = state.devices.filter(d => !d.revoked).length;
  if (!confirm('Revoke ALL ' + n + ' device(s) now?\\n\\nEvery phone is cut off at once (direct and relay) and its push notifications stop. Phones must be paired again afterwards.')) return;
  await api('/api/lockdown', { confirm: true });
  load();
}

async function device(deviceId, action) {
  if (action === 'lost' && !confirm('Mark this device as lost?\\n\\nIt is revoked at once and stops receiving notifications.')) return;
  if (action === 'delete' && !confirm('Remove this device? It will need to pair again.')) return;
  await api('/api/device', { deviceId, action });
  load();
}

async function toggleScope(deviceId, scope) {
  const d = state.devices.find(x => x.id === deviceId);
  if (!d) return;
  const next = d.scopes.includes(scope) ? d.scopes.filter(s => s !== scope) : [...d.scopes, scope];
  if (!d.scopes.includes(scope) && RISKY.has(scope)
      && !confirm('Grant "' + scope + '" to ' + d.name + '?\\n\\n' +
                  (scope === 'terminal' ? 'This gives the device a real shell on this Mac.' : 'This is a powerful permission.'))) return;
  const turningOn = !d.scopes.includes(scope);
  const forMs = turningOn ? readDur('dur-' + deviceId) : null;
  if (forMs === undefined) return;
  await api('/api/device', { deviceId, action: 'scopes', scopes: next, scope: turningOn ? scope : undefined, forMs });
  load();
}

document.getElementById('root-dur').innerHTML = durSelect('dur-root');
load();
setInterval(load, 4000);
</script>
</body>
</html>`
