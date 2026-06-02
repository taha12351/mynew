'use strict';

// ╔══════════════════════════════════════════════════════════════╗
// ║  Diamond Casino — Command Permission Store                  ║
// ║  Persists per-user command permissions to commandPerms.json ║
// ╚══════════════════════════════════════════════════════════════╝

const fs   = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'commandPerms.json');

function load() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('[permStore] save error:', e.message); }
}

// ─── Read a single permission entry ───────────────────────────
// Returns: null  ——  user has no permission for this command
// Returns: { balance: -1 (infinite) | number, grantedBy, grantedAt }
function getPerm(userId, command) {
  const data = load();
  return data[userId]?.[command] || null;
}

// ─── Write / overwrite a permission ───────────────────────────
// balance: -1 = infinite, positive number = remaining budget
function setPerm(userId, command, balance, grantedBy) {
  const data = load();
  if (!data[userId]) data[userId] = {};
  data[userId][command] = {
    balance,
    grantedBy,
    grantedAt: Date.now(),
  };
  save(data);
}

// ─── Deduct an amount from a user's command budget ────────────
// Returns true if the deduction succeeded (or balance is infinite)
// Returns false if insufficient budget
function deductPerm(userId, command, amount) {
  const data = load();
  const perm = data[userId]?.[command];
  if (!perm) return false;
  if (perm.balance === -1) return true; // infinite — no deduction needed
  if (perm.balance < amount) return false;
  data[userId][command].balance -= amount;
  save(data);
  return true;
}

// ─── Remove a permission entirely ─────────────────────────────
function removePerm(userId, command) {
  const data = load();
  if (!data[userId]?.[command]) return false;
  delete data[userId][command];
  if (Object.keys(data[userId]).length === 0) delete data[userId];
  save(data);
  return true;
}

// ─── Remove ALL permissions for a user ────────────────────────
function removeAllPerms(userId) {
  const data = load();
  if (!data[userId]) return false;
  delete data[userId];
  save(data);
  return true;
}

// ─── Get all permissions (for !perms listing) ─────────────────
function getAllPerms() {
  return load();
}

// ─── Format balance for display ───────────────────────────────
function fmtBalance(balance) {
  if (balance === -1) return '∞ لا محدود';
  return `$${balance.toLocaleString()}`;
}

// ─── Check if a user can use a command ────────────────────────
// Returns: true if user can use the command, false otherwise
// (Checks if user has permission for the command)
function canUseCommand(userId, command) {
  const perm = getPerm(userId, command);
  if (!perm) return false; // No permission granted
  if (perm.balance === -1) return true; // Infinite permission
  if (perm.balance > 0) return true; // Has remaining budget
  return false; // Insufficient budget
}

module.exports = { getPerm, setPerm, deductPerm, removePerm, removeAllPerms, getAllPerms, fmtBalance, canUseCommand };
