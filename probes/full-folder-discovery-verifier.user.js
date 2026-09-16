// ==UserScript==
// @name         Google Drive Folder Player - Full Folder Discovery Verifier
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Verify Google Drive full-folder MP3/WebM discovery with forward, reverse, and repeat passes.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-full-folder-discovery-verifier';
  const MEDIA_RE = /([^\/\n\r]{1,320}\.(?:mp3|webm))(?=\s|$)/i;
  const SETTLE_MS = 380;
  const EDGE_SETTLE_MS = 700;
  const MAX_STEPS = 260;

  let running = false;
  let stopRequested = false;
  let union = new Map();
  let passResults = [];
  let logLines = [];

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-140);
    const box = document.querySelector(`#${PANEL_ID} [data-vf="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP Discovery Verifier]', text);
  }

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
  }

  function isRendered(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function extractName(element) {
    if (!(element instanceof Element)) return '';
    for (const value of [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('data-tooltip'),
      element.textContent
    ]) {
      if (!value || value.length > 1800) continue;
      const match = value.trim().match(MEDIA_RE);
      if (match) return match[1].trim();
    }
    return '';
  }

  function typeOf(name) {
    return String(name || '').toLowerCase().endsWith('.webm') ? 'webm' : 'mp3';
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element) || isInsidePanel(node)) break;
      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (
        node.hasAttribute('data-id') || node.hasAttribute('data-target') ||
        node.hasAttribute('data-file-id') || node.hasAttribute('data-docid') ||
        node.hasAttribute('data-doc-id')
      ) fallback = node;
    }
    return fallback;
  }

  function idFromHref(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      const queryId = url.searchParams.get('id');
      if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      return url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/)?.[1] || '';
    } catch {
      return '';
    }
  }

  function getItemId(root) {
    if (!(root instanceof Element)) return '';
    const attrs = ['data-id', 'data-target', 'data-file-id', 'data-docid', 'data-doc-id'];
    const candidates = [
      root,
      ...root.querySelectorAll('[data-id], [data-target], [data-file-id], [data-docid], [data-doc-id], a[href]')
    ];
    for (const element of candidates) {
      for (const attr of attrs) {
        const value = element.getAttribute?.(attr) || '';
        if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
      }
      const hrefId = idFromHref(element.getAttribute?.('href') || '');
      if (hrefId) return hrefId;
    }
    return '';
  }

  function collectRendered() {
    const candidates = document.querySelectorAll(
      '[role="row"], [role="gridcell"], [role="rowheader"], [role="listitem"], a, span, [aria-label], [title], [data-tooltip]'
    );
    const roots = new Set();
    const rows = [];
    for (const element of candidates) {
      if (!(element instanceof Element) || isInsidePanel(element)) continue;
      const name = extractName(element);
      if (!name) continue;
      const root = findItemRoot(element);
      if (!root || !isRendered(root) || roots.has(root)) continue;
      const id = getItemId(root);
      if (!id) continue;
      roots.add(root);
      rows.push({ id, name, type: typeOf(name), root, top: root.getBoundingClientRect().top });
    }
    rows.sort((a, b) => a.top - b.top);
    return rows;
  }

  function looksScrollable(element) {
    if (!(element instanceof Element) || isInsidePanel(element)) return false;
    const style = getComputedStyle(element);
    if (!['auto', 'scroll', 'overlay'].includes(style.overflowY)) return false;
    return element.scrollHeight > element.clientHeight + 80 && element.clientHeight > 180;
  }

  function findScroller() {
    const rows = collectRendered();
    const anchor = rows[Math.floor(rows.length / 2)]?.root || rows[0]?.root;
    const ancestors = [];
    let node = anchor?.parentElement;
    for (let depth = 0; node && depth < 18; depth += 1, node = node.parentElement) {
      if (looksScrollable(node)) ancestors.push(node);
    }
    if (ancestors.length) {
      ancestors.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return ancestors[0];
    }
    return [...document.querySelectorAll('div, main, section')]
      .filter(looksScrollable)
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || null;
  }

  function addSample(passMap) {
    const rows = collectRendered();
    let passAdded = 0;
    let unionAdded = 0;
    for (const row of rows) {
      if (!passMap.has(row.id)) {
        passMap.set(row.id, { id: row.id, name: row.name, type: row.type });
        passAdded += 1;
      }
      if (!union.has(row.id)) {
        union.set(row.id, { id: row.id, name: row.name, type: row.type });
        unionAdded += 1;
      }
    }
    render();
    return { rendered: rows.length, passAdded, unionAdded };
  }

  async function runPass(scroller, label, direction) {
    const passMap = new Map();
    const goingDown = direction === 'down';
    const edge = goingDown ? 0 : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTo({ top: edge, behavior: 'auto' });
    await sleep(EDGE_SETTLE_MS);
    let sample = addSample(passMap);
    log(`${label} start: rendered=${sample.rendered}, pass=${passMap.size}, union=${union.size}.`);

    let steps = 0;
    let unchanged = 0;
    let previousTop = scroller.scrollTop;
    while (!stopRequested && steps < MAX_STEPS) {
      steps += 1;
      const range = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const stepSize = Math.max(260, Math.floor(scroller.clientHeight * 0.72));
      const target = goingDown
        ? Math.min(range, scroller.scrollTop + stepSize)
        : Math.max(0, scroller.scrollTop - stepSize);
      scroller.scrollTo({ top: target, behavior: 'auto' });
      await sleep(SETTLE_MS);
      sample = addSample(passMap);
      const currentTop = scroller.scrollTop;
      const currentRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const atEdge = goingDown ? currentRange - currentTop <= 8 : currentTop <= 8;
      if (Math.abs(currentTop - previousTop) < 2 && sample.passAdded === 0) unchanged += 1;
      else unchanged = 0;
      previousTop = currentTop;
      log(`${label} step ${steps}: top=${Math.round(currentTop)}/${Math.round(currentRange)}, rendered=${sample.rendered}, +pass=${sample.passAdded}, +union=${sample.unionAdded}, pass=${passMap.size}, union=${union.size}${atEdge ? ' · edge' : ''}.`);

      if (atEdge) {
        await sleep(EDGE_SETTLE_MS);
        const settled = addSample(passMap);
        const finalRange = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const stillEdge = goingDown ? finalRange - scroller.scrollTop <= 8 : scroller.scrollTop <= 8;
        log(`${label} settle: +pass=${settled.passAdded}, +union=${settled.unionAdded}, pass=${passMap.size}, union=${union.size}, stillEdge=${stillEdge}.`);
        if (stillEdge && settled.passAdded === 0) break;
      }
      if (unchanged >= 4) break;
    }
    log(`${label} complete: ${passMap.size} unique media ID(s), steps=${steps}.`);
    return passMap;
  }

  function setDiff(a, b) {
    const result = [];
    for (const key of a.keys()) if (!b.has(key)) result.push(key);
    return result;
  }

  async function verify() {
    if (running) return;
    running = true;
    stopRequested = false;
    union = new Map();
    passResults = [];
    logLines = [];
    render();

    const scroller = findScroller();
    if (!scroller) {
      log('Could not identify the Drive list scroll container.');
      running = false;
      render();
      return;
    }
    const originalTop = scroller.scrollTop;
    const originalLeft = scroller.scrollLeft;
    log(`Verification started. Initial top=${Math.round(originalTop)}, client=${scroller.clientHeight}, scroll=${scroller.scrollHeight}.`);

    const forward1 = await runPass(scroller, 'PASS 1 DOWN', 'down');
    if (!stopRequested) passResults.push({ label: 'down-1', map: forward1 });
    const reverse = stopRequested ? new Map() : await runPass(scroller, 'PASS 2 UP', 'up');
    if (!stopRequested) passResults.push({ label: 'up', map: reverse });
    const forward2 = stopRequested ? new Map() : await runPass(scroller, 'PASS 3 DOWN', 'down');
    if (!stopRequested) passResults.push({ label: 'down-2', map: forward2 });

    if (!stopRequested && passResults.length === 3) {
      const missing1 = setDiff(union, forward1).length;
      const missing2 = setDiff(union, reverse).length;
      const missing3 = setDiff(union, forward2).length;
      const exact = forward1.size === union.size && reverse.size === union.size && forward2.size === union.size;
      const items = [...union.values()];
      const mp3 = items.filter(item => item.type === 'mp3').length;
      const webm = items.filter(item => item.type === 'webm').length;
      log(`VERIFY RESULT: union=${union.size} (${mp3} MP3, ${webm} WebM); pass sizes=${forward1.size}/${reverse.size}/${forward2.size}; missing from union=${missing1}/${missing2}/${missing3}.`);
      log(exact
        ? `STRONG MATCH: all three complete traversals independently found the same ${union.size} stable media IDs.`
        : 'MISMATCH: at least one pass missed IDs found by another pass; discovery needs more work before integration.');
    } else {
      log('Verification stopped before all three passes completed.');
    }

    scroller.scrollTo({ top: Math.min(originalTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight)), behavior: 'auto' });
    scroller.scrollLeft = originalLeft;
    await sleep(250);
    running = false;
    stopRequested = false;
    render();
  }

  function stop() {
    if (!running) return;
    stopRequested = true;
    log('Stop requested.');
  }

  function copyReport() {
    const lines = [
      `Full Folder Discovery Verifier ${VERSION}`,
      `Union: ${union.size}`,
      ...passResults.map(item => `${item.label}: ${item.map.size}`),
      '',
      ...[...union.values()].map((item, index) => `${index + 1}. [${item.type.toUpperCase()}] ${item.name} | ${item.id}`)
    ];
    navigator.clipboard?.writeText(lines.join('\n')).then(
      () => log('Verification report copied.'),
      () => log('Clipboard write failed.')
    );
  }

  function render() {
    const status = document.querySelector(`#${PANEL_ID} [data-vf="status"]`);
    if (!status) return;
    const items = [...union.values()];
    const mp3 = items.filter(item => item.type === 'mp3').length;
    const webm = items.filter(item => item.type === 'webm').length;
    const sizes = passResults.length ? ` | passes ${passResults.map(item => item.map.size).join('/')}` : '';
    status.textContent = `${running ? 'VERIFYING' : 'IDLE'} | union ${items.length} | ${mp3} MP3 | ${webm} WebM${sizes}`;
  }

  function button(label, handler) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    Object.assign(node.style, {
      padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    node.addEventListener('click', handler);
    return node;
  }

  function mount() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '700px',
      maxHeight: '82vh', overflow: 'auto', boxSizing: 'border-box', padding: '10px', borderRadius: '10px',
      background: 'rgba(25,27,30,.97)', color: '#f1f3f4', border: '1px solid rgba(255,255,255,.18)',
      boxShadow: '0 6px 22px rgba(0,0,0,.3)', font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });
    const title = document.createElement('div');
    title.textContent = `Full Folder Discovery Verifier ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';
    const note = document.createElement('div');
    note.textContent = 'Runs three independent traversals of the same Drive folder: top→bottom, bottom→top, top→bottom. A strong match means all passes found exactly the same stable MP3/WebM IDs. Diagnostic only; no playback or file changes.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';
    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(button('Verify full folder count', () => void verify()), button('Stop', stop), button('Copy report', copyReport));
    const status = document.createElement('div');
    status.dataset.vf = 'status';
    Object.assign(status.style, { marginBottom: '8px', padding: '7px', borderRadius: '6px', whiteSpace: 'pre-wrap', background: 'rgba(129,201,149,.10)', border: '1px solid rgba(129,201,149,.20)' });
    const logBox = document.createElement('div');
    logBox.dataset.vf = 'log';
    Object.assign(logBox.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px', background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '220px' });
    panel.append(title, note, controls, status, logBox);
    document.body.appendChild(panel);
    render();
    log(`Verifier ${VERSION} mounted.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();
