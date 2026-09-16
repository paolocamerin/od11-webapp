/**
 * OD-11 speaker control — talks to the speaker's WebSocket directly from the browser.
 * Protocol mirrors OD11-remote's speaker.js: join, keepalive ping, volume delta, playback toggle.
 * The speaker IP is kept only in localStorage on this machine.
 */

const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 5000;
const STORAGE_KEY = 'od11-webapp:ip';
const COLOR_STORAGE_KEY = 'od11-webapp:color';

// Dial geometry — a 270° sweep with a gap at the bottom (min at bottom-left,
// max at bottom-right, straight up = halfway).
const DIAL_MIN_ANGLE = -135;
const DIAL_MAX_ANGLE = 135;
const DIAL_SWEEP = DIAL_MAX_ANGLE - DIAL_MIN_ANGLE;

// The readout's oblique slant grows with volume (0 -> 100 maps to 0deg -> 12deg).
// This is a browser-synthesized oblique (font-style: oblique <angle>), not a
// variable-font slant axis.
const DIAL_MIN_SLANT = 0;
const DIAL_MAX_SLANT = 12;

// Palette the dial colour can be picked from, spanning the full hue spectrum.
const DIAL_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#FFAE00', //
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
];



const els = {
  setup: document.getElementById('setup'),
  controls: document.getElementById('controls'),
  ipInput: document.getElementById('ip'),
  connectBtn: document.getElementById('connect'),
  disconnectBtn: document.getElementById('disconnect'),
  statusChip: document.getElementById('statusChip'),
  statusText: document.getElementById('statusText'),
  colorPicker: document.getElementById('colorPicker'),
  colorButton: document.getElementById('colorButton'),
  dial: document.getElementById('dial'),
  dialIndicator: document.getElementById('dialIndicator'),
  volumeValue: document.getElementById('volumeValue'),
  palette: document.getElementById('palette'),
  playpause: document.getElementById('playpause'),
  playpauseIcon: document.getElementById('playpauseIcon'),
};

let socket = null;
let pingInterval = null;
let reconnectTimeout = null;
let dragging = false;
let pendingVolume = 0;
let dragLastAngle = 0;
let dragVolume = 0;

let currentVolume = 0;
let maxVolume = 100;
let isPlaying = false;
let isConnected = false;
let sourcesMap = {};
let currentSourceId = null;

function setStatusChip(text, state) {
  els.statusText.textContent = text;
  els.statusChip.dataset.state = state;
}

function setControlsEnabled(enabled) {
  isConnected = enabled;
  els.dial.classList.toggle('disabled', !enabled);
  els.dial.tabIndex = enabled ? 0 : -1;
  updatePlayPauseAvailability();
}

function updatePlayPauseAvailability() {
  els.playpause.disabled = !isConnected || !canCurrentSourcePause();
}

function connect(ip, isRetry) {
  clearTimeout(reconnectTimeout);
  setStatusChip(isRetry ? 'Reconnecting…' : 'Connecting…', 'connecting');
  setControlsEnabled(false);

  socket = new WebSocket(`ws://${ip}/ws`);
  const uid = 'uid-' + Math.floor(1e8 * Math.random());

  socket.addEventListener('open', () => {
    setStatusChip('connected', 'connected');
    setControlsEnabled(true);
    renderPlayback();

    socket.send(JSON.stringify({
      protocol_major_version: 0,
      protocol_minor_version: 4,
      action: 'global_join',
    }));
    socket.send(JSON.stringify({
      color_index: 0,
      name: 'od11-webapp',
      realtime_data: true,
      uid,
      action: 'group_join',
    }));

    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          value: Date.now() % 1e6,
          action: 'speaker_ping',
        }));
      }
    }, PING_INTERVAL_MS);
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    const items = Array.isArray(msg) ? msg : [msg];
    for (const item of items) {
      if (item && item.update) parseUpdate(item);
      if (item && Array.isArray(item.sources)) {
        for (const src of item.sources) {
          if (src && typeof src.id === 'number') sourcesMap[src.id] = src;
        }
        updatePlayPauseAvailability();
      }
      if (item && Array.isArray(item.state)) {
        for (const stateItem of item.state) {
          if (stateItem && stateItem.update) parseUpdate(stateItem);
        }
      }
    }
  });

  socket.addEventListener('error', () => {
    setStatusChip('Disconnected', 'disconnected');
  });

  socket.addEventListener('close', () => {
    setStatusChip('Disconnected', 'disconnected');
    setControlsEnabled(false);
    clearInterval(pingInterval);
    pingInterval = null;
    reconnectTimeout = setTimeout(() => connect(ip, true), RECONNECT_DELAY_MS);
  });
}

function parseUpdate(item) {
  if (item.update === 'group_max_volume' && typeof item.value === 'number') {
    maxVolume = item.value;
    els.dial.setAttribute('aria-valuemax', String(maxVolume));
    if (!dragging) updateDial(currentVolume);
  }
  if (item.update === 'group_volume_changed' && typeof item.vol === 'number') {
    currentVolume = item.vol;
    if (!dragging) updateDial(currentVolume);
  }
  if (item.update === 'playback_state_changed' && typeof item.playing === 'boolean') {
    isPlaying = item.playing;
    renderPlayback();
  }
  if (item.update === 'group_input_source_changed' && typeof item.source === 'number') {
    currentSourceId = item.source;
    updatePlayPauseAvailability();
  }
}

function valueToAngle(value) {
  return DIAL_MIN_ANGLE + (value / maxVolume) * DIAL_SWEEP;
}

// Raw, unclamped angle from the dial's center to a point (degrees, 0 = straight
// up, clockwise positive). Used only for measuring drag deltas, not absolute value.
function angleFromPoint(clientX, clientY) {
  const rect = els.dial.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.atan2(clientX - cx, cy - clientY) * (180 / Math.PI);
}

// Shortest signed difference between two angles, normalized to (-180, 180] so a
// drag crossing the ±180° seam doesn't register as a huge jump. Only safe for
// angles that are close together (e.g. consecutive drag samples) — beyond 180°
// apart, "shortest path" is ambiguous.
function angleDelta(from, to) {
  return ((to - from + 180) % 360 + 360) % 360 - 180;
}

function updateDial(value) {
  const clamped = Math.max(0, Math.min(maxVolume, value));
  const angle = valueToAngle(clamped);
  const slant = DIAL_MIN_SLANT + (clamped / maxVolume) * (DIAL_MAX_SLANT - DIAL_MIN_SLANT);
  els.dialIndicator.setAttribute('transform', `rotate(${angle} 110 110)`);
  els.volumeValue.textContent = String(clamped);
  els.volumeValue.style.fontStyle = `oblique ${slant.toFixed(1)}deg`;
  els.dial.setAttribute('aria-valuenow', String(clamped));
}

function applyDialColor(color) {
  els.dial.style.setProperty('--accent', color);
  els.colorButton.style.background = color;
  for (const swatch of els.palette.children) {
    swatch.setAttribute('aria-checked', String(swatch.dataset.color === color));
  }
  localStorage.setItem(COLOR_STORAGE_KEY, color);
}

function openPalette() {
  els.palette.classList.remove('hidden');
  els.colorButton.setAttribute('aria-expanded', 'true');
}

function closePalette() {
  els.palette.classList.add('hidden');
  els.colorButton.setAttribute('aria-expanded', 'false');
}

function buildPalette() {
  const savedColor = localStorage.getItem(COLOR_STORAGE_KEY);
  const initialColor = DIAL_COLORS.includes(savedColor) ? savedColor : DIAL_COLORS[0];

  const frag = document.createDocumentFragment();
  DIAL_COLORS.forEach((color, i) => {
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.dataset.color = color;
    swatch.style.setProperty('--swatch-color', color);
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', String(color === initialColor));
    swatch.setAttribute('aria-label', `Colour ${i + 1}`);
    swatch.tabIndex = color === initialColor ? 0 : -1;
    frag.appendChild(swatch);
  });
  els.palette.appendChild(frag);

  els.palette.addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    selectSwatch(swatch, true);
  });

  els.palette.addEventListener('keydown', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectSwatch(swatch, true);
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const swatches = [...els.palette.children];
    const dir = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
    const next = swatches[(swatches.indexOf(swatch) + dir + swatches.length) % swatches.length];
    next.focus();
    selectSwatch(next);
  });

  return initialColor;
}

function selectSwatch(swatch, closeAfter) {
  for (const s of els.palette.children) s.tabIndex = -1;
  swatch.tabIndex = 0;
  applyDialColor(swatch.dataset.color);
  if (closeAfter) {
    closePalette();
    els.colorButton.focus();
  }
}

function renderPlayback() {
  els.playpauseIcon.classList.toggle('ph-play', !isPlaying);
  els.playpauseIcon.classList.toggle('ph-pause', isPlaying);
  els.playpause.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

function sendVolumeDelta(newValue) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const amount = newValue - currentVolume;
  if (amount === 0) return;
  socket.send(JSON.stringify({ amount, action: 'group_change_volume' }));
}

function canCurrentSourcePause() {
  const src = currentSourceId !== null ? sourcesMap[currentSourceId] : null;
  return src ? src.supports_pause !== false : true;
}

function togglePlayPause() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!canCurrentSourcePause()) return;
  const newPlaying = !isPlaying;
  socket.send(JSON.stringify({ action: newPlaying ? 'playback_start' : 'playback_stop' }));
  isPlaying = newPlaying;
  renderPlayback();
}

// ── UI wiring ────────────────────────────────────────────────────────────

els.ipInput.value = localStorage.getItem(STORAGE_KEY) || '';

els.connectBtn.addEventListener('click', () => {
  const ip = els.ipInput.value.trim();
  if (!ip) return;
  localStorage.setItem(STORAGE_KEY, ip);
  els.setup.classList.add('hidden');
  els.controls.classList.remove('hidden');
  connect(ip);
});

els.disconnectBtn.addEventListener('click', () => {
  clearTimeout(reconnectTimeout);
  clearInterval(pingInterval);
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  els.controls.classList.add('hidden');
  els.setup.classList.remove('hidden');
});

applyDialColor(buildPalette());
updateDial(currentVolume);

els.colorButton.addEventListener('click', (e) => {
  e.stopPropagation();
  if (els.palette.classList.contains('hidden')) openPalette();
  else closePalette();
});

document.addEventListener('click', (e) => {
  if (els.palette.classList.contains('hidden')) return;
  if (els.colorPicker.contains(e.target)) return;
  closePalette();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.palette.classList.contains('hidden')) {
    closePalette();
    els.colorButton.focus();
  }
});

els.dial.addEventListener('pointerdown', (e) => {
  if (els.dial.classList.contains('disabled')) return;
  dragging = true;
  els.dial.classList.add('dragging');
  els.dial.setPointerCapture(e.pointerId);
  dragLastAngle = angleFromPoint(e.clientX, e.clientY);
  dragVolume = currentVolume;
});

els.dial.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const angle = angleFromPoint(e.clientX, e.clientY);
  const delta = angleDelta(dragLastAngle, angle);
  dragLastAngle = angle;
  dragVolume = Math.max(0, Math.min(maxVolume, dragVolume + (delta / DIAL_SWEEP) * maxVolume));
  pendingVolume = Math.round(dragVolume);
  updateDial(pendingVolume);
});

function endDialDrag(e) {
  if (!dragging) return;
  dragging = false;
  els.dial.classList.remove('dragging');
  els.dial.releasePointerCapture(e.pointerId);
  sendVolumeDelta(pendingVolume);
}

els.dial.addEventListener('pointerup', endDialDrag);
els.dial.addEventListener('pointercancel', endDialDrag);

els.dial.addEventListener('keydown', (e) => {
  if (els.dial.classList.contains('disabled')) return;
  let next;
  if (e.key === 'Home') {
    next = 0;
  } else if (e.key === 'End') {
    next = maxVolume;
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
    next = currentVolume + (e.shiftKey ? 5 : 1);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
    next = currentVolume - (e.shiftKey ? 5 : 1);
  } else {
    return;
  }
  e.preventDefault();
  next = Math.max(0, Math.min(maxVolume, next));
  updateDial(next);
  sendVolumeDelta(next);
});

els.playpause.addEventListener('click', togglePlayPause);

// Auto-connect if we already have a saved IP.
const savedIp = localStorage.getItem(STORAGE_KEY);
if (savedIp) {
  els.setup.classList.add('hidden');
  els.controls.classList.remove('hidden');
  connect(savedIp);
}
