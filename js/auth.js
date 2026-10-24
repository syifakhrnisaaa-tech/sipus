/* ============================================================
   js/auth.js — SIPUS
   Simulasi autentikasi lokal (tanpa backend):
   - Akun demo disimpan di localStorage dengan KATA SANDI DI-HASH
     (SHA-256 bila tersedia, fallback hash sederhana).
   - Sesi disimpan di sessionStorage.
   PENTING: ini hanya simulasi; penyimpanan lokal TIDAK aman
   untuk produksi (dijelaskan di README.md).
============================================================ */
(function () {
  'use strict';

  const S = SIPUS.Storage, U = SIPUS.Util;

  /* ==========================================================
     HASH KATA SANDI
     Tidak menyimpan kata sandi teks biasa. SHA-256 dipakai bila
     crypto.subtle tersedia (konteks aman); fallback hash sederhana
     untuk lingkungan file:// lama.
  ========================================================== */
  async function hashPassword(password) {
    const text = String(password == null ? '' : password);
    const subtle = window.crypto && window.crypto.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      try {
        const data = new TextEncoder().encode('SIPUS$' + text);
        const buf = await subtle.digest('SHA-256', data);
        return 'sha256:' + Array.from(new Uint8Array(buf))
          .map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        console.warn('crypto.subtle gagal, memakai hash cadangan:', e);
      }
    }
    // Fallback: hash sederhana (bukan enkripsi) — tetap bukan teks biasa.
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
      h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619) >>> 0;
      h2 = Math.imul(h2 + text.charCodeAt(i) * (i + 7), 2654435761) >>> 0;
    }
    return 'fb:' + h1.toString(16) + h2.toString(16);
  }

  /* ==========================================================
     AKUN DEMO
  ========================================================== */
  const DEMO_ACCOUNTS = [
    { username: 'petugas', password: 'petugas123', nama: 'Andi Pratama', role: 'petugas', memberId: null },
    { username: 'mahasiswa', password: 'mahasiswa123', nama: 'Dewi Anggraini', role: 'anggota', memberId: 'AG001' }
  ];

  /** Buat akun demo bila belum ada. force=true menimpa seluruh akun. */
  async function ensureDefaultUsers(force) {
    const existing = S.getUsers();
    if (!force && existing && existing.length) return existing;
    const users = [];
    for (const acc of DEMO_ACCOUNTS) {
      users.push({
        username: acc.username,
        nama: acc.nama,
        role: acc.role,
        memberId: acc.memberId,
        passwordHash: await hashPassword(acc.password)
      });
    }
    S.saveUsers(users);
    return users;
  }

  /* ==========================================================
     SESI
  ========================================================== */
  function saveSession(username) {
    try { window.sessionStorage.setItem(S.SESSION_KEY, username); } catch (e) { console.warn(e); }
  }

  function clearSession() {
    try { window.sessionStorage.removeItem(S.SESSION_KEY); } catch (e) { console.warn(e); }
  }

  /** Pengguna yang sedang masuk, atau null. */
  function currentUser() {
    let username = null;
    try { username = window.sessionStorage.getItem(S.SESSION_KEY); } catch (e) { console.warn(e); }
    if (!username) return null;
    const user = S.getUsers().find(u => u.username === username) || null;
    if (!user) { clearSession(); return null; }
    // Sertakan data anggota bila akun terhubung ke anggota.
    if (user.memberId) user.member = S.getMember(user.memberId);
    return user;
  }

  function isLoggedIn() { return currentUser() != null; }
  function isPetugas() { const u = currentUser(); return !!u && u.role === 'petugas'; }

  /** Cek hak akses berbasis peran; lempar pesan bila tidak berhak. */
  function requireRole(role) {
    const u = currentUser();
    if (!u) throw new Error('Anda harus masuk terlebih dahulu.');
    if (role && u.role !== role) throw new Error('Hanya petugas yang dapat melakukan tindakan ini.');
    return u;
  }

  /** Verifikasi nama pengguna + kata sandi. */
  async function login(username, password) {
    const uname = String(username || '').trim().toLowerCase();
    const pass = String(password || '');
    if (!uname || !pass) return { ok: false, error: 'Nama pengguna dan kata sandi wajib diisi.' };

    const users = S.getUsers();
    if (!users.length) {
      // Belum ada data pengguna — buat akun demo agar aplikasi tetap dapat dicoba.
      await ensureDefaultUsers(false);
    }
    const list = S.getUsers();
    const user = list.find(u => u.username.toLowerCase() === uname);
    if (!user) return { ok: false, error: 'Nama pengguna tidak ditemukan.' };

    const hashed = await hashPassword(pass);
    if (hashed !== user.passwordHash) return { ok: false, error: 'Kata sandi salah.' };

    saveSession(user.username);
    return { ok: true, user };
  }

  function logout() {
    clearSession();
  }

  /* ==========================================================
     WIRING FORM LOGIN
  ========================================================== */
  function init() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const errEl = document.getElementById('login-error');
      const uname = document.getElementById('login-username').value;
      const pass = document.getElementById('login-password').value;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const res = await login(uname, pass);
        if (!res.ok) {
          if (errEl) { errEl.textContent = res.error; errEl.classList.remove('hidden'); }
          return;
        }
        if (errEl) errEl.classList.add('hidden');
        form.reset();
        if (window.SIPUS && SIPUS.App && typeof SIPUS.App.onAuthChanged === 'function') {
          SIPUS.App.onAuthChanged();
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  SIPUS.Auth = {
    DEMO_ACCOUNTS,
    hashPassword, ensureDefaultUsers,
    login, logout, currentUser, isLoggedIn, isPetugas, requireRole, init
  };
})();
