import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopBridge } from '../sidecars/pet/lib/desktop-bridge.mjs';
import { findElectronExecutable } from '../sidecars/pet/lib/desktop-host.mjs';

function openSse(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, res => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

test('DesktopBridge enforces loopback token auth and routes HTTP/art requests', async t => {
  const bridge = new DesktopBridge();
  const info = await bridge.start();
  t.after(() => bridge.stop());

  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);
  const base = `http://127.0.0.1:${info.port}`;

  for (const path of ['/', '/renderer.js', '/art?name=idle', '/events', '/msg']) {
    const method = path === '/msg' ? 'POST' : 'GET';
    const noToken = await fetch(`${base}${path}`, { method });
    assert.equal(noToken.status, 403, `${path} without token`);
    const badToken = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=wrong`, { method });
    assert.equal(badToken.status, 403, `${path} with wrong token`);
  }

  const html = await fetch(`${base}/?token=${info.token}`);
  assert.equal(html.status, 200);
  const htmlText = await html.text();
  assert.match(htmlText, /Hagemi Pet/);
  assert.match(htmlText, /hasOpenedOnce/, 're-sends ready when EventSource reconnects');
  assert.match(htmlText, /es\.onerror/);

  const js = await fetch(`${base}/renderer.js?token=${info.token}`);
  assert.equal(js.status, 200);
  const jsText = await js.text();
  assert.doesNotThrow(() => new Function(jsText));
  assert.match(jsText, /desktop:\s*true/);

  const art = await fetch(`${base}/art?token=${info.token}&name=idle`);
  assert.equal(art.status, 200);
  assert.ok((await art.text()).length > 100);

  const traversal = await fetch(`${base}/art?token=${info.token}&name=${encodeURIComponent('../main')}`);
  assert.equal(traversal.status, 404);
});

test('DesktopBridge delivers SSE broadcasts and POST /msg callbacks', async t => {
  const received = [];
  const bridge = new DesktopBridge({
    onMessage: (msg, session) => received.push({ msg, desktop: session.desktop, ready: session.ready }),
  });
  const info = await bridge.start();
  t.after(() => bridge.stop());
  const base = `http://127.0.0.1:${info.port}`;

  const sse = await openSse(`${base}/events?token=${info.token}&client=c1`);
  t.after(() => sse.req.destroy());
  assert.equal(sse.res.statusCode, 200);

  let buffer = '';
  sse.res.setEncoding('utf8');
  sse.res.on('data', chunk => { buffer += chunk; });

  const postReady = await fetch(`${base}/msg?token=${info.token}&client=c1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'ready' }),
  });
  assert.equal(postReady.status, 204);
  assert.deepEqual(received, [{ msg: { type: 'ready' }, desktop: true, ready: true }]);

  bridge.broadcast({ t: 'say', text: 'hello' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(buffer, /"t":"say"/);
  assert.match(buffer, /"text":"hello"/);

  const badJson = await fetch(`${base}/msg?token=${info.token}&client=c1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(badJson.status, 400);
});

test('findElectronExecutable checks HAGEMI_ELECTRON_PATH and sidecar electron-runtime', t => {
  const root = mkdtempSync(join(tmpdir(), 'hagemi-electron-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dataDir = join(root, 'data');
  const runtimeExe = join(root, 'electron-runtime', 'node_modules', 'electron', 'dist', 'electron.exe');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, 'electron-runtime', 'node_modules', 'electron', 'dist'), { recursive: true });
  writeFileSync(runtimeExe, 'stub');

  assert.equal(findElectronExecutable({ dataDir, env: {}, platform: 'win32' }), runtimeExe);

  const customExe = join(root, 'custom-electron.exe');
  writeFileSync(customExe, 'stub');
  assert.equal(
    findElectronExecutable({ dataDir, env: { HAGEMI_ELECTRON_PATH: customExe }, platform: 'win32' }),
    customExe,
  );
});

test('desktop overlay streams global cursor coordinates to preload and renderer', async () => {
  const { readFileSync } = await import('node:fs');
  const root = join(import.meta.dirname, '..');
  const mainSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'electron-main.cjs'), 'utf8');
  const preloadSrc = readFileSync(join(root, 'sidecars', 'pet', 'desktop', 'preload.cjs'), 'utf8');
  assert.match(mainSrc, /screen\.getCursorScreenPoint\(\)/);
  assert.match(mainSrc, /win\.webContents\.send\('hagemi:cursor'/);
  assert.match(preloadSrc, /onCursorMove:/);
  assert.match(preloadSrc, /ipcRenderer\.on\('hagemi:cursor'/);
});
