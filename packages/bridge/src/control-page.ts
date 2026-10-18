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

  <h2>Paired devices</h2>
  <div id="devices"></div>

  <h2>Activity</h2>
  <pre class="log" id="log"></pre>
</main>

<script>
const SCOPES = ['sessions','chat','approvals','work','files','git','git_write','terminal','admin'];
const RISKY = new Set(['terminal','admin','git_write']);
let state = null;

async function load() {
  const r = await fetch('/api/state');
  state = await r.json();
  render();
}

function render() {
  document.getElementById('host-name').textContent = state.host.name;
  document.getElementById('host-fp').textContent = state.host.fingerprint;
  const gw = document.getElementById('gw');
  gw.textContent = state.gatewayConnected ? 'dorabot connected' : 'dorabot not reachable';
  gw.className = 'pill ' + (state.gatewayConnected ? 'on' : 'off');

  const rl = document.getElementById('relay');
  if (state.relay) {
    rl.style.display = '';
    rl.textContent = 'relay ' + state.relay.state;
    rl.className = 'pill ' + (state.relay.state === 'online' ? 'on' : 'off');
  } else {
    rl.style.display = 'none';
  }

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
              <span class="pill \${d.revoked ? 'off' : (online ? 'on' : '')}">\${d.revoked ? 'revoked' : (online ? 'connected' : 'offline')}</span>
            </div>
            <div class="small muted mono">\${esc(d.platform)} · \${esc(d.fingerprint)} · \${d.lastSeenAt ? 'last seen ' + new Date(d.lastSeenAt).toLocaleString() : 'never connected'}</div>
          </div>
          <div style="display:flex;gap:8px">
            \${d.revoked
              ? \`<button class="small" onclick="device('\${d.id}','restore')">Restore</button>\`
              : \`<button class="small danger" onclick="device('\${d.id}','revoke')">Revoke</button>\`}
            <button class="small danger" onclick="device('\${d.id}','delete')">Remove</button>
          </div>
        </div>
        <div class="scopes">
          \${SCOPES.map(s => \`<span class="scope \${d.scopes.includes(s) ? 'active' : ''} \${RISKY.has(s) ? 'danger' : ''}"
             onclick="toggleScope('\${d.id}','\${s}')">\${s}</span>\`).join('')}
        </div>
      </div>\`;
    }).join('');
  }

  document.getElementById('log').textContent = state.log.join('\\n');
}

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function newPairing() {
  const r = await fetch('/api/pair', { method: 'POST' });
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
  await fetch('/api/scope', { method: 'POST', body: JSON.stringify({ requestId, approve }) });
  load();
}

async function device(deviceId, action) {
  if (action === 'delete' && !confirm('Remove this device? It will need to pair again.')) return;
  await fetch('/api/device', { method: 'POST', body: JSON.stringify({ deviceId, action }) });
  load();
}

async function toggleScope(deviceId, scope) {
  const d = state.devices.find(x => x.id === deviceId);
  if (!d) return;
  const next = d.scopes.includes(scope) ? d.scopes.filter(s => s !== scope) : [...d.scopes, scope];
  if (!d.scopes.includes(scope) && RISKY.has(scope)
      && !confirm('Grant "' + scope + '" to ' + d.name + '?\\n\\n' +
                  (scope === 'terminal' ? 'This gives the device a real shell on this Mac.' : 'This is a powerful permission.'))) return;
  await fetch('/api/device', { method: 'POST', body: JSON.stringify({ deviceId, action: 'scopes', scopes: next }) });
  load();
}

load();
setInterval(load, 4000);
</script>
</body>
</html>`
