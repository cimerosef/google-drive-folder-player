// ==UserScript==
// @name         Google Drive Folder Player - WebM Two-Track Preload Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Validate two independent direct WebM media elements, preload, and A-to-B transition timing without Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-webm-two-track-probe';
  const WEBM_RE = /([^\/\n\r]{1,320}\.webm)(?=\s|$)/i;

  let lastClicked = null;
  let slotA = null;
  let slotB = null;
  let mediaA = null;
  let mediaB = null;
  let autoSwitch = true;
  let pendingSwitchStartedAt = 0;
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-90);
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-webm-two="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP WebM Two-Track Probe]', text);
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
      const match = value.trim().match(WEBM_RE);
      if (match) return match[1].trim();
    }
    return '';
  }

  function findItemRoot(element) {
    let node = element;
    let fallback = element;
    for (let depth = 0; node && depth < 14; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) break;
      if (node.closest?.(`#${PANEL_ID}`)) break;
      const role = node.getAttribute('role');
      if (role === 'row' || role === 'listitem') return node;
      if (role === 'gridcell' || role === 'rowheader') fallback = node;
      if (node.hasAttribute('data-id') || node.hasAttribute('data-target') || node.hasAttribute('data-file-id') || node.hasAttribute('data-docid')) fallback = node;
    }
    return fallback;
  }

  function idFromHref(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      const queryId = url.searchParams.get('id');
      if (queryId && /^[A-Za-z0-9_-]{10,}$/.test(queryId)) return queryId;
      const match = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
      return match?.[1] || '';
    } catch {
      return '';
    }
  }

  function getItemId(root) {
    if (!(root instanceof Element)) return '';
    const attrs = ['data-id', 'data-target', 'data-file-id', 'data-docid', 'data-doc-id'];
    const candidates = [root, ...root.querySelectorAll('[data-id], [data-target], [data-file-id], [data-docid], [data-doc-id], a[href]')];
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

  function rememberClick(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(`#${PANEL_ID}`)) return;
    const root = findItemRoot(target);
    if (!root) return;
    const name = extractName(root) || extractName(target);
    const id = getItemId(root);
    if (!name || !id) return;
    lastClicked = { name, id };
    renderSlots();
    log(`Remembered WebM: ${name} | stable id captured.`);
  }

  function authuserIndex() {
    const pathMatch = location.pathname.match(/\/u\/(\d+)(?:\/|$)/);
    if (pathMatch) return pathMatch[1];
    const query = new URL(location.href).searchParams.get('authuser');
    return query && /^\d+$/.test(query) ? query : '0';
  }

  function directUrl(item) {
    const authuser = authuserIndex();
    return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(item.id)}&export=download&confirm=t&authuser=${encodeURIComponent(authuser)}`;
  }

  function assignSlot(which) {
    if (!lastClicked) {
      log(`No clicked WebM captured yet for slot ${which}.`);
      return;
    }
    if (which === 'A') slotA = { ...lastClicked };
    else slotB = { ...lastClicked };
    renderSlots();
    log(`Assigned ${lastClicked.name} to slot ${which}.`);
  }

  function bufferedText(media) {
    if (!media?.buffered?.length) return '(empty)';
    const start = media.buffered.start(0).toFixed(1);
    const end = media.buffered.end(media.buffered.length - 1).toFixed(1);
    return `${start}-${end}`;
  }

  function attachEvents(media, label) {
    const events = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'playing', 'waiting', 'stalled', 'suspend', 'ended', 'error'];
    for (const eventName of events) {
      media.addEventListener(eventName, () => {
        const duration = Number.isFinite(media.duration) ? media.duration.toFixed(1) : 'n/a';
        const time = Number.isFinite(media.currentTime) ? media.currentTime.toFixed(1) : 'n/a';
        const error = media.error ? ` errorCode=${media.error.code}` : '';
        log(`${label} ${eventName}: ready=${media.readyState} net=${media.networkState} paused=${media.paused} t=${time}/${duration} buffered=${bufferedText(media)} video=${media.videoWidth || 0}x${media.videoHeight || 0}${error}`);

        if (label === 'B' && eventName === 'playing' && pendingSwitchStartedAt) {
          const elapsed = Math.round(performance.now() - pendingSwitchStartedAt);
          log(`A→B audible-start latency: ${elapsed} ms.`);
          pendingSwitchStartedAt = 0;
        }
      });
    }

    if (label === 'A') {
      media.addEventListener('ended', () => {
        if (!autoSwitch || !mediaB) return;
        pendingSwitchStartedAt = performance.now();
        log('A ended; requesting B.play() immediately.');
        void mediaB.play().catch(error => {
          log(`B auto-play rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
          pendingSwitchStartedAt = 0;
        });
      });
    }
  }

  function makeMedia(item, label) {
    const media = document.createElement('video');
    media.preload = 'auto';
    media.playsInline = true;
    attachEvents(media, label);
    media.src = directUrl(item);
    media.load();
    log(`${label} preload requested using authuser=${authuserIndex()}. Browser canPlayType(video/webm)=${media.canPlayType('video/webm') || '(empty)'}.`);
    return media;
  }

  function preloadBoth() {
    if (!slotA || !slotB) {
      log('Assign both slot A and slot B first.');
      return;
    }
    try { mediaA?.pause(); } catch {}
    try { mediaB?.pause(); } catch {}
    mediaA = makeMedia(slotA, 'A');
    mediaB = makeMedia(slotB, 'B');
    log('Both direct WebM media elements created. Wait for A/B canplay before testing transition.');
  }

  async function playA() {
    if (!mediaA) return log('Preload both tracks first.');
    try {
      await mediaA.play();
      log('A play() resolved.');
    } catch (error) {
      log(`A play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
    }
  }

  function seekANearEnd() {
    if (!mediaA || !Number.isFinite(mediaA.duration) || mediaA.duration <= 6) {
      log('A metadata/duration is not ready yet.');
      return;
    }
    mediaA.currentTime = Math.max(0, mediaA.duration - 5);
    log(`A seeked to last ~5 seconds (${mediaA.currentTime.toFixed(1)}/${mediaA.duration.toFixed(1)}).`);
  }

  async function switchNow() {
    if (!mediaB) return log('Preload both tracks first.');
    try { mediaA?.pause(); } catch {}
    pendingSwitchStartedAt = performance.now();
    log('Manual A→B switch requested.');
    try {
      await mediaB.play();
    } catch (error) {
      log(`B play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
      pendingSwitchStartedAt = 0;
    }
  }

  function pauseAll() {
    mediaA?.pause();
    mediaB?.pause();
    log('Paused A and B.');
  }

  function toggleAuto() {
    autoSwitch = !autoSwitch;
    const button = document.querySelector(`#${PANEL_ID} [data-gdfp-webm-two="auto"]`);
    if (button) button.textContent = `Auto A→B: ${autoSwitch ? 'ON' : 'OFF'}`;
    log(`Auto A→B ${autoSwitch ? 'ON' : 'OFF'}.`);
  }

  function renderSlots() {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-webm-two="slots"]`);
    if (!box) return;
    box.textContent = [
      `Last clicked: ${lastClicked?.name || '—'}`,
      `A: ${slotA?.name || '—'}`,
      `B: ${slotB?.name || '—'}`,
      `authuser=${authuserIndex()}`
    ].join('\n');
  }

  function makeButton(label, handler, role = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (role) button.dataset.gdfpWebmTwo = role;
    Object.assign(button.style, {
      padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(255,255,255,.24)',
      background: 'rgba(255,255,255,.10)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mountPanel() {
    if (!document.body || document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '670px', maxHeight: '72vh', overflow: 'auto',
      boxSizing: 'border-box', padding: '10px', borderRadius: '10px', background: 'rgba(25,27,30,.97)', color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)', boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `WebM Two-Track Preload Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'No Drive Preview. Assign two WebM files to A/B, preload both, then test natural A→B handoff and background switching.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const slots = document.createElement('div');
    slots.dataset.gdfpWebmTwo = 'slots';
    Object.assign(slots.style, { marginBottom: '8px', padding: '7px', borderRadius: '6px', background: 'rgba(129,201,149,.10)', whiteSpace: 'pre-wrap' });

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(
      makeButton('Assign clicked → A', () => assignSlot('A')),
      makeButton('Assign clicked → B', () => assignSlot('B')),
      makeButton('Preload A+B', preloadBoth),
      makeButton('Play A', playA),
      makeButton('Seek A to last 5s', seekANearEnd),
      makeButton('Switch now to B', switchNow),
      makeButton('Auto A→B: ON', toggleAuto, 'auto'),
      makeButton('Pause all', pauseAll)
    );

    const logBox = document.createElement('div');
    logBox.dataset.gdfpWebmTwo = 'log';
    Object.assign(logBox.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px', background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '150px' });

    panel.append(title, note, slots, controls, logBox);
    document.body.appendChild(panel);
    renderSlots();
    log(`Probe ${VERSION} mounted. Direct WebM two-track preload test ready.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    document.addEventListener('click', rememberClick, true);
    mountPanel();
  }

  init();
})();
