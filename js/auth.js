// ==========================================================================
// auth.js — toegangsbeveiliging: pincode-vergrendelscherm + auto-lock.
//
// Dit scherm (#view-lock, zie index.html) ligt als een overlay BOVEN de
// rest van de app (position:fixed, z-index hoog, zie styles.css) en
// verbergt zo alle cliëntgegevens totdat de juiste pincode (of, indien
// ingesteld, biometrie) is bevestigd. De daadwerkelijke encryptie-sleutel
// leeft pas in het geheugen ná een geslaagde ontgrendeling — zie crypto.js.
// ==========================================================================

import * as Crypto from './crypto.js';
import * as Sync from './sync.js';

const PIN_LENGTH = 6;
const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minuten inactiviteit → vergrendelen
const ACTIVITY_CHECK_MS = 15 * 1000;

const els = {
  view: document.getElementById('view-lock'),
  pinBox: document.getElementById('lock-pin-box'),
  dots: document.getElementById('lock-dots'),
  keypad: document.getElementById('lock-keypad'),
  biometricBtn: document.getElementById('lock-biometric-btn'),
  error: document.getElementById('lock-error'),
  hint: document.getElementById('lock-setup-hint'),
  showSyncLoginBtn: document.getElementById('lock-show-sync-login'),
  syncLoginBox: document.getElementById('lock-sync-login'),
  syncServer: document.getElementById('sync-login-server'),
  syncEmail: document.getElementById('sync-login-email'),
  syncPassword: document.getElementById('sync-login-password'),
  syncPin: document.getElementById('sync-login-pin'),
  syncSubmit: document.getElementById('sync-login-submit'),
  syncCancel: document.getElementById('sync-login-cancel'),
  syncError: document.getElementById('sync-login-error'),
};

let mode = 'unlock'; // 'unlock' | 'setup-first' | 'setup-confirm'
let firstPin = '';
let digits = '';
let onUnlockCallback = null;
let autoLockSuspended = false;
let lastActivity = Date.now();

function renderDots() {
  els.dots.innerHTML = '';
  for (let i = 0; i < PIN_LENGTH; i++) {
    const dot = document.createElement('span');
    dot.className = 'dot' + (i < digits.length ? ' filled' : '');
    els.dots.appendChild(dot);
  }
}

function buildKeypad() {
  els.keypad.innerHTML = '';
  const layout = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  for (const key of layout) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (!key) {
      btn.style.visibility = 'hidden';
    } else {
      btn.textContent = key;
      btn.setAttribute('aria-label', key === '⌫' ? 'Wis cijfer' : `Cijfer ${key}`);
      btn.addEventListener('click', () => onKeyPress(key));
    }
    els.keypad.appendChild(btn);
  }
}

function onKeyPress(key) {
  els.error.textContent = '';
  if (key === '⌫') {
    digits = digits.slice(0, -1);
    renderDots();
    return;
  }
  if (digits.length >= PIN_LENGTH) return;
  digits += key;
  renderDots();
  if (digits.length === PIN_LENGTH) {
    setTimeout(submitPin, 120); // korte vertraging zodat de laatste dot zichtbaar is
  }
}

async function submitPin() {
  if (mode === 'unlock') {
    const ok = await Crypto.unlockWithPin(digits);
    if (ok) {
      digits = '';
      await finishUnlock();
    } else {
      els.error.textContent = 'Onjuiste pincode. Probeer opnieuw.';
      digits = '';
      renderDots();
    }
    return;
  }

  if (mode === 'setup-first') {
    firstPin = digits;
    digits = '';
    mode = 'setup-confirm';
    els.hint.textContent = 'Herhaal je pincode ter bevestiging.';
    renderDots();
    return;
  }

  if (mode === 'setup-confirm') {
    if (digits !== firstPin) {
      els.error.textContent = 'Pincodes komen niet overeen. Begin opnieuw.';
      firstPin = '';
      digits = '';
      mode = 'setup-first';
      els.hint.textContent = `Kies een pincode van ${PIN_LENGTH} cijfers.`;
      renderDots();
      return;
    }
    await Crypto.setupPin(digits);
    digits = '';
    await maybeOfferBiometric();
    await finishUnlock();
  }
}

async function maybeOfferBiometric() {
  if (!(await Crypto.isBiometricSupported())) return;
  const wants = window.confirm(
    'Wil je ook Face ID / vingerafdruk gebruiken om sneller te ontgrendelen? ' +
    'Je pincode blijft altijd werken als alternatief.'
  );
  if (!wants) return;
  try {
    await Crypto.registerBiometric();
  } catch (err) {
    console.warn('Biometrie instellen mislukt:', err);
    // Stil falen: de app blijft gewoon met pincode werken.
  }
}

async function finishUnlock() {
  els.view.classList.remove('active');
  lastActivity = Date.now();
  onUnlockCallback?.();
}

els.biometricBtn.addEventListener('click', async () => {
  els.error.textContent = '';
  const ok = await Crypto.unlockWithBiometric();
  if (ok) {
    await finishUnlock();
  } else {
    els.error.textContent = 'Biometrisch ontgrendelen mislukt. Gebruik je pincode.';
  }
});

async function showLockScreen() {
  digits = '';
  firstPin = '';
  els.error.textContent = '';
  els.hint.textContent = '';
  els.syncLoginBox.hidden = true;
  els.pinBox.hidden = false;

  if (await Crypto.isSetup()) {
    mode = 'unlock';
    els.biometricBtn.hidden = !(await Crypto.isBiometricSupported() && await Crypto.isBiometricRegistered());
    els.showSyncLoginBtn.hidden = true;
  } else {
    mode = 'setup-first';
    els.hint.textContent = `Kies een pincode van ${PIN_LENGTH} cijfers om cliëntgegevens te beveiligen.`;
    els.biometricBtn.hidden = true;
    els.showSyncLoginBtn.hidden = false;
  }
  renderDots();
  els.view.classList.add('active');

  if (mode === 'unlock' && !els.biometricBtn.hidden) {
    // Meteen een poging wagen zodat de gebruiker niet extra hoeft te tikken.
    els.biometricBtn.click();
  }
}

// --------------------------------------------------------------------
// Auto-lock na inactiviteit
// --------------------------------------------------------------------

function registerActivity() {
  lastActivity = Date.now();
}

['pointerdown', 'keydown', 'touchstart'].forEach(evt =>
  document.addEventListener(evt, registerActivity, { passive: true })
);

setInterval(() => {
  if (autoLockSuspended) return;
  if (!Crypto.isUnlocked()) return;
  if (Date.now() - lastActivity > AUTO_LOCK_MS) {
    Crypto.lock();
    showLockScreen();
  }
}, ACTIVITY_CHECK_MS);

/**
 * Onderdrukt auto-lock tijdelijk — nodig tijdens het opnemen van audio,
 * want daarbij raakt de psycholoog het scherm bewust niet aan (die praat),
 * wat anders per ongeluk een lopende opname zou kunnen onderbreken.
 */
export function suspendAutoLock() {
  autoLockSuspended = true;
}
export function resumeAutoLock() {
  autoLockSuspended = false;
  registerActivity();
}

export function lockNow() {
  Crypto.lock();
  showLockScreen();
}

// --------------------------------------------------------------------
// "Al een account op een ander apparaat?" — inloggen op een bestaand
// sync-account vanaf een NIEUW apparaat, vóórdat er lokaal een pincode
// bestaat. Haalt de gedeelde sleutel op via sync.js, bindt daarna een
// lokale pincode aan diezelfde sleutel, en haalt tot slot de bestaande
// cliëntgegevens van het account binnen.
// --------------------------------------------------------------------

els.showSyncLoginBtn.addEventListener('click', () => {
  els.pinBox.hidden = true;
  els.syncLoginBox.hidden = false;
  els.syncError.textContent = '';
});

els.syncCancel.addEventListener('click', () => {
  els.syncLoginBox.hidden = true;
  els.pinBox.hidden = false;
});

els.syncSubmit.addEventListener('click', async () => {
  const serverUrl = els.syncServer.value.trim();
  const email = els.syncEmail.value.trim();
  const password = els.syncPassword.value;
  const pin = els.syncPin.value.trim();

  els.syncError.textContent = '';
  if (!serverUrl || !email || !password) {
    els.syncError.textContent = 'Vul server, e-mail en wachtwoord in.';
    return;
  }
  if (!/^\d{6}$/.test(pin)) {
    els.syncError.textContent = `Kies een lokale pincode van ${PIN_LENGTH} cijfers.`;
    return;
  }

  els.syncSubmit.disabled = true;
  try {
    await Sync.loginAccount(serverUrl, email, password); // zet de gedeelde DEK actief
    await Crypto.setupPinForExistingDek(pin); // bindt een lokale pincode aan diezelfde DEK
    await Sync.syncNow(); // haalt de bestaande cliëntgegevens van dit account binnen
    els.syncLoginBox.hidden = true;
    await finishUnlock();
  } catch (err) {
    console.warn('Sync-login mislukt:', err);
    els.syncError.textContent = err.message || 'Inloggen mislukt. Controleer server, e-mail en wachtwoord.';
  } finally {
    els.syncSubmit.disabled = false;
  }
});

/** Initialiseert het vergrendelscherm. onUnlock wordt aangeroepen zodra de app mag worden getoond. */
export function initAuth(onUnlock) {
  onUnlockCallback = onUnlock;
  buildKeypad();
  showLockScreen();
}
