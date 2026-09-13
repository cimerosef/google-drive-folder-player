// ==UserScript==
// @name         Google Drive Folder Player - WebM Hidden Progress Probe
// @namespace    https://github.com/cimerosef/google-drive-folder-player
// @version      0.0.1
// @description  Diagnostic probe for hidden Google Drive media progress controls during WebM/video playback.
// @author       cimerosef
// @match        https://drive.google.com/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const PANEL_ID = 'gdfp-webm-progress-probe';
  let monitorTimer = null;
  let samples = [];

  function q(selector) {
    return document.querySelector(selector);
  }

  function isInsidePanel(element) {
    return Boolean(element?.closest?.(`#${PANEL_ID}`));
  }

  function describeCandidate(element, index) {
    const now = Number(element.getAttribute('aria-valuenow'));
    const min = Number(element.getAttribute('aria-valuemin'));
    const max = Number(element.getAttribute('aria-valuemax'));
    const span = max - min;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';

    return {
      index,
      element,
      now,
      min,
      max,
      span,
      label,
      rect: `${Math.round(rect.width)}×${Math.round(rect.height)} @ ${Math.round(rect.left)},${Math.round(rect.top)}`,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity
    };
  }

  function collectCandidates() {
    return [...document.querySelectorAll('[aria-valuenow][aria-valuemin][aria-valuemax]')]
      .filter(element => !isInsidePanel(element))
      .map(describeCandidate)
      .filter(item => [item.now, item.min, item.max].every(Number.isFinite) && item.max > item.min)
      .sort((a, b) => b.span - a.span);
  }

  function renderCandidates() {
    const box = q(`#${PANEL_ID} [data-probe="results"]`);
    const status = q(`#${PANEL_ID} [data-probe="status"]`);
    if (!box || !status) return;

    const candidates = collectCandidates();
    const progressish = candidates.filter(item => item.span > 100);

    status.textContent = candidates.length
      ? `${candidates.length} ranged control(s) found; ${progressish.length} candidate(s) have span > 100.`
      : 'No ranged controls found in the current Drive page.';

    box.textContent = candidates.length
      ? candidates.slice(0, 12).map(item =>
          `#${item.index} span=${item.span} now=${item.now} [${item.min}..${item.max}]\n` +
          `label=${item.label || '(none)'}\n` +
          `rect=${item.rect}; display=${item.display}; visibility=${item.visibility}; opacity=${item.opacity}`
        ).join('\n\n')
      : 'Nothing to show.';
  }

  function stopMonitor() {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function startMonitor() {
    stopMonitor();
    samples = [];
    const started = performance.now();
    const durationMs = 10000;
    const status = q(`#${PANEL_ID} [data-probe="status"]`);
    const logBox = q(`#${PANEL_ID} [data-probe="log"]`);

    if (status) status.textContent = 'Monitoring hidden/visible ranged controls for 10 seconds…';
    if (logBox) logBox.textContent = '';

    monitorTimer = setInterval(() => {
      const elapsed = Math.round(performance.now() - started);
      const candidates = collectCandidates().filter(item => item.span > 100);
      const snapshot = candidates.map(item => ({
        elapsed,
        span: item.span,
        now: item.now,
        min: item.min,
        max: item.max,
        label: item.label,
        display: item.display,
        visibility: item.visibility,
        opacity: item.opacity,
        rect: item.rect
      }));
      samples.push(...snapshot);

      if (elapsed >= durationMs) {
        stopMonitor();
        summarizeMonitor();
      }
    }, 250);
  }

  function summarizeMonitor() {
    const status = q(`#${PANEL_ID} [data-probe="status"]`);
    const logBox = q(`#${PANEL_ID} [data-probe="log"]`);

    if (!samples.length) {
      if (status) status.textContent = '10-second monitor finished: no span > 100 control was found.';
      if (logBox) logBox.textContent = 'No hidden or visible progress-style ranged control was observable.';
      return;
    }

    const groups = new Map();
    for (const sample of samples) {
      const key = `${sample.min}:${sample.max}:${sample.label}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sample);
    }

    const summaries = [...groups.entries()].map(([key, values]) => {
      const nows = values.map(value => value.now);
      const first = values[0];
      const last = values[values.length - 1];
      const changed = new Set(nows).size > 1;
      return `${key}\n` +
        `samples=${values.length}; changed=${changed}; first=${first.now}; last=${last.now}; minSeen=${Math.min(...nows)}; maxSeen=${Math.max(...nows)}\n` +
        `last style: display=${last.display}; visibility=${last.visibility}; opacity=${last.opacity}; rect=${last.rect}`;
    });

    const anyChanging = [...groups.values()].some(values => new Set(values.map(value => value.now)).size > 1);
    if (status) {
      status.textContent = anyChanging
        ? 'SUCCESS: at least one progress-style control kept changing during the 10-second monitor.'
        : 'Monitor finished: progress-style control(s) existed, but none changed during the sample window.';
    }
    if (logBox) logBox.textContent = summaries.join('\n\n');
  }

  function makeButton(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      border: '1px solid rgba(255,255,255,.28)',
      borderRadius: '7px',
      padding: '7px 10px',
      background: 'rgba(255,255,255,.11)',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit'
    });
    button.addEventListener('click', handler);
    return button;
  }

  function mount() {
    if (document.getElementById(PANEL_ID) || !document.body) return;

    const panel = document.createElement('section');
    panel.id = PANEL_ID;
    Object.assign(panel.style, {
      position: 'fixed',
      left: '18px',
      bottom: '18px',
      zIndex: '2147483647',
      width: '430px',
      maxHeight: '72vh',
      overflow: 'auto',
      boxSizing: 'border-box',
      padding: '12px',
      borderRadius: '12px',
      background: 'rgba(32,33,36,.97)',
      color: '#f1f3f4',
      boxShadow: '0 8px 30px rgba(0,0,0,.32)',
      font: '12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    });

    const title = document.createElement('div');
    title.textContent = 'GDFP — WebM Hidden Progress Probe';
    title.style.fontWeight = '700';
    title.style.marginBottom = '8px';

    const status = document.createElement('div');
    status.dataset.probe = 'status';
    status.textContent = 'Open a WebM/video preview and let it play, preferably after the Drive controls auto-hide.';
    status.style.marginBottom = '8px';

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '7px', flexWrap: 'wrap', marginBottom: '8px' });
    controls.append(
      makeButton('Inspect now', renderCandidates),
      makeButton('Monitor 10s', startMonitor),
      makeButton('Stop monitor', stopMonitor)
    );

    const results = document.createElement('pre');
    results.dataset.probe = 'results';
    results.textContent = 'No inspection run yet.';
    Object.assign(results.style, {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      margin: '0 0 8px 0',
      padding: '8px',
      borderRadius: '7px',
      background: 'rgba(138,180,248,.12)',
      border: '1px solid rgba(138,180,248,.28)'
    });

    const logBox = document.createElement('pre');
    logBox.dataset.probe = 'log';
    logBox.textContent = '10-second monitor summary will appear here.';
    Object.assign(logBox.style, {
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      margin: '0',
      padding: '8px',
      borderRadius: '7px',
      background: 'rgba(129,201,149,.12)',
      border: '1px solid rgba(129,201,149,.28)'
    });

    panel.append(title, status, controls, results, logBox);
    document.body.appendChild(panel);
  }

  if (document.body) mount();
  else window.addEventListener('DOMContentLoaded', mount, { once: true });
})();
