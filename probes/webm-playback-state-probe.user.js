// ==UserScript==
// @name         Google Drive Folder Player - WebM Playback State Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Diagnostic probe for changing playback-state signals when Google Drive hides WebM/video transport controls.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const PANEL_ID = 'gdfp-webm-state-probe';
  const SAMPLE_MS = 250;
  const DURATION_MS = 10000;
  const TIME_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;

  let timer = null;
  let baseline = new Map();
  let changes = new Map();

  function insidePanel(el) {
    return Boolean(el?.closest?.(`#${PANEL_ID}`));
  }

  function shortText(value, max = 90) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function domPath(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    for (let i = 0; node && node !== document.body && i < 5; i += 1, node = node.parentElement) {
      const role = node.getAttribute('role');
      const cls = [...node.classList].slice(0, 2).join('.');
      parts.unshift(`${node.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${cls ? `.${cls}` : ''}`);
    }
    return parts.join('>');
  }

  function collectSignals() {
    const out = [];
    const nodes = document.querySelectorAll('[aria-valuenow], [aria-valuetext], [aria-label], [title], [role="button"], [role="slider"], span, div');

    let ordinal = 0;
    for (const el of nodes) {
      if (!(el instanceof Element) || insidePanel(el)) continue;

      const text = shortText(el.textContent, 60);
      const ariaNow = el.getAttribute('aria-valuenow') || '';
      const ariaText = el.getAttribute('aria-valuetext') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const role = el.getAttribute('role') || '';

      const timeLike = TIME_RE.test(text) || TIME_RE.test(ariaText);
      const numeric = ariaNow !== '';
      const stateLike = /play|pause|progress|volume|lecture|pause|progression|volume|播放|暂停|進度|音量/i.test(`${ariaLabel} ${title}`);

      if (!timeLike && !numeric && !stateLike) continue;

      const key = `${domPath(el)}#${ordinal++}`;
      const value = `role=${role || '-'} now=${ariaNow || '-'} valuetext=${shortText(ariaText) || '-'} label=${shortText(ariaLabel || title) || '-'} text=${text || '-'}`;
      out.push({ key, value });
    }
    return out;
  }

  function sample() {
    for (const signal of collectSignals()) {
      if (!baseline.has(signal.key)) {
        baseline.set(signal.key, signal.value);
        continue;
      }
      const previous = baseline.get(signal.key);
      if (previous !== signal.value) {
        const entry = changes.get(signal.key) || { count: 0, first: previous, last: signal.value };
        entry.count += 1;
        entry.last = signal.value;
        changes.set(signal.key, entry);
        baseline.set(signal.key, signal.value);
      }
    }
    render();
  }

  function render() {
    const status = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
    const body = document.querySelector(`#${PANEL_ID} [data-role="body"]`);
    if (!status || !body) return;

    const ranked = [...changes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
    status.textContent = timer
      ? `Monitoring… ${baseline.size} candidate signal(s), ${changes.size} changing.`
      : `Idle. ${baseline.size} candidate signal(s), ${changes.size} changing.`;

    body.textContent = ranked.length
      ? ranked.map(([key, info], i) => `#${i + 1} changes=${info.count}\n${key}\nFIRST: ${info.first}\nLAST:  ${info.last}`).join('\n\n')
      : 'No changing playback-state signal detected yet.';
  }

  function inspectNow() {
    baseline = new Map(collectSignals().map(x => [x.key, x.value]));
    changes = new Map();
    render();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    render();
  }

  function monitor10s() {
    stop();
    inspectNow();
    timer = setInterval(sample, SAMPLE_MS);
    setTimeout(() => {
      stop();
      const status = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
      if (status) status.textContent = changes.size
        ? `Monitor finished: ${changes.size} changing signal(s) found.`
        : 'Monitor finished: no changing playback-state signal found.';
    }, DURATION_MS);
  }

  function button(label, fn) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      border: '1px solid rgba(255,255,255,.28)', borderRadius: '7px', padding: '7px 10px',
      background: 'rgba(255,255,255,.11)', color: 'inherit', cursor: 'pointer', font: 'inherit'
    });
    b.addEventListener('click', fn);
    return b;
  }

  function mount() {
    if (document.getElementById(PANEL_ID) || !document.body) return;
    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: 2147483647,
      width: '470px', maxHeight: '80vh', overflow: 'auto', boxSizing: 'border-box',
      padding: '12px', borderRadius: '12px', background: 'rgba(32,33,36,.97)', color: '#f1f3f4',
      boxShadow: '0 8px 30px rgba(0,0,0,.32)', font: '13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = 'GDFP — WebM Playback State Probe';
    title.style.fontWeight = '650';
    title.style.marginBottom = '8px';

    const status = document.createElement('div');
    status.dataset.role = 'status';
    status.textContent = 'Open and play a WebM/video, let controls hide, then Monitor 10s.';
    status.style.marginBottom = '8px';

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(button('Inspect now', inspectNow), button('Monitor 10s', monitor10s), button('Stop', stop));

    const body = document.createElement('pre');
    body.dataset.role = 'body';
    body.textContent = 'No samples yet.';
    Object.assign(body.style, {
      whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, padding: '8px', borderRadius: '7px',
      background: 'rgba(138,180,248,.12)', border: '1px solid rgba(138,180,248,.28)', fontSize: '11px'
    });

    panel.append(title, status, controls, body);
    document.body.appendChild(panel);
  }

  function init() {
    if (!document.body) return setTimeout(init, 100);
    mount();
  }

  init();
})();
