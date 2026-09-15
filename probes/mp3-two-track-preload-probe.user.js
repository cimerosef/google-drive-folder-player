// ==UserScript==
// @name         Google Drive Folder Player - MP3 Two-Track Preload Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Validate two independent direct MP3 Audio elements, preload, and A-to-B transition timing without Drive Preview.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '0.0.1';
  const PANEL_ID = 'gdfp-two-track-preload-probe';
  const MP3_RE = /([^\/\n\r]{1,320}\.mp3)(?=\s|$)/i;

  let lastClicked = null;
  let slotA = null;
  let slotB = null;
  let audioA = null;
  let audioB = null;
  let autoSwitch = true;
  let pendingSwitchStartedAt = 0;
  let logLines = [];

  function stamp() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function log(text) {
    logLines.push(`${stamp()}  ${text}`);
    logLines = logLines.slice(-80);
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-two="log"]`);
    if (box) box.textContent = logLines.join('\n');
    console.log('[GDFP Two-Track Probe]', text);
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
      const match = value.trim().match(MP3_RE);
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
    log(`Remembered MP3: ${name} | stable id captured.`);
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
      log(`No clicked MP3 captured yet for slot ${which}.`);
      return;
    }
    if (which === 'A') slotA = { ...lastClicked };
    else slotB = { ...lastClicked };
    renderSlots();
    log(`Assigned ${lastClicked.name} to slot ${which}.`);
  }

  function attachEvents(audio, label) {
    const events = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'suspend', 'ended', 'error'];
    for (const eventName of events) {
      audio.addEventListener(eventName, () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration.toFixed(1) : 'n/a';
        const error = audio.error ? ` errorCode=${audio.error.code}` : '';
        const buffered = audio.buffered?.length ? `${audio.buffered.start(0).toFixed(1)}-${audio.buffered.end(audio.buffered.length - 1).toFixed(1)}` : '(empty)';
        log(`${label} ${eventName}: ready=${audio.readyState} net=${audio.networkState} paused=${audio.paused} t=${audio.currentTime.toFixed(1)}/${duration} buffered=${buffered}${error}`);

        if (label === 'B' && eventName === 'playing' && pendingSwitchStartedAt) {
          const elapsed = Math.round(performance.now() - pendingSwitchStartedAt);
          log(`A→B audible-start latency: ${elapsed} ms.`);
          pendingSwitchStartedAt = 0;
        }
      });
    }

    if (label === 'A') {
      audio.addEventListener('ended', () => {
        if (!autoSwitch || !audioB) return;
        pendingSwitchStartedAt = performance.now();
        log('A ended; requesting B.play() immediately.');
        void audioB.play().catch(error => {
          log(`B auto-play rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
          pendingSwitchStartedAt = 0;
        });
      });
    }
  }

  function makeAudio(item, label) {
    const audio = new Audio();
    audio.preload = 'auto';
    attachEvents(audio, label);
    audio.src = directUrl(item);
    audio.load();
    log(`${label} preload requested using authuser=${authuserIndex()}.`);
    return audio;
  }

  function preloadBoth() {
    if (!slotA || !slotB) {
      log('Assign both slot A and slot B first.');
      return;
    }
    try { audioA?.pause(); } catch {}
    try { audioB?.pause(); } catch {}
    audioA = makeAudio(slotA, 'A');
    audioB = makeAudio(slotB, 'B');
    log('Both direct MP3 Audio elements created. Wait for A/B canplay before testing transition.');
  }

  async function playA() {
    if (!audioA) return log('Preload both tracks first.');
    try {
      await audioA.play();
      log('A play() resolved.');
    } catch (error) {
      log(`A play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
    }
  }

  function seekANearEnd() {
    if (!audioA || !Number.isFinite(audioA.duration) || audioA.duration <= 6) {
      log('A metadata/duration is not ready yet.');
      return;
    }
    audioA.currentTime = Math.max(0, audioA.duration - 5);
    log(`A seeked to last ~5 seconds (${audioA.currentTime.toFixed(1)}/${audioA.duration.toFixed(1)}).`);
  }

  async function switchNow() {
    if (!audioB) return log('Preload both tracks first.');
    try { audioA?.pause(); } catch {}
    pendingSwitchStartedAt = performance.now();
    log('Manual A→B switch requested.');
    try {
      await audioB.play();
    } catch (error) {
      log(`B play() rejected: ${error?.name || 'Error'} ${error?.message || ''}`.trim());
      pendingSwitchStartedAt = 0;
    }
  }

  function pauseAll() {
    audioA?.pause();
    audioB?.pause();
    log('Paused A and B.');
  }

  function toggleAuto() {
    autoSwitch = !autoSwitch;
    const button = document.querySelector(`#${PANEL_ID} [data-gdfp-two="auto"]`);
    if (button) button.textContent = `Auto A→B: ${autoSwitch ? 'ON' : 'OFF'}`;
    log(`Auto A→B ${autoSwitch ? 'ON' : 'OFF'}.`);
  }

  function renderSlots() {
    const box = document.querySelector(`#${PANEL_ID} [data-gdfp-two="slots"]`);
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
    if (role) button.dataset.gdfpTwo = role;
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
      position: 'fixed', left: '16px', bottom: '16px', zIndex: '2147483647', width: '650px', maxHeight: '70vh', overflow: 'auto',
      boxSizing: 'border-box', padding: '10px', borderRadius: '10px', background: 'rgba(25,27,30,.97)', color: '#f1f3f4',
      border: '1px solid rgba(255,255,255,.18)', boxShadow: '0 6px 22px rgba(0,0,0,.3)',
      font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = `MP3 Two-Track Preload Probe ${VERSION}`;
    title.style.fontWeight = '650';
    title.style.marginBottom = '5px';

    const note = document.createElement('div');
    note.textContent = 'No Drive Preview. Click one MP3 and assign A, click another and assign B, then preload both. This tests whether B can remain ready while A plays and how fast B becomes audible after A ends.';
    note.style.opacity = '0.78';
    note.style.marginBottom = '8px';

    const slots = document.createElement('div');
    slots.dataset.gdfpTwo = 'slots';
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
    logBox.dataset.gdfpTwo = 'log';
    Object.assign(logBox.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '8px', borderRadius: '6px', background: 'rgba(138,180,248,.10)', border: '1px solid rgba(138,180,248,.22)', minHeight: '140px' });

    panel.append(title, note, slots, controls, logBox);
    document.body.appendChild(panel);
    renderSlots();
    log(`Probe ${VERSION} mounted. Direct MP3 two-track preload test ready.`);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    document.addEventListener('click', rememberClick, true);
    mountPanel();
  }

  init();
})();
