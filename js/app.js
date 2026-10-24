/* ============================================================
   js/app.js — SIPUS
   Inisialisasi aplikasi, navigasi antar-halaman, modal,
   notifikasi, hak akses, dan halaman Pengaturan
   (ekspor/impor data, muat data contoh).
   Dimuat terakhir setelah seluruh modul.
============================================================ */
(function () {
  'use strict';

  const S = SIPUS.Storage, U = SIPUS.Util;
  const esc = U.esc;

  /* ==========================================================
     NOTIFIKASI (TOAST)
  ========================================================== */
  function notify(message, type) {
    const root = document.getElementById('toast-root');
    if (!root) { console.log('[SIPUS]', message); return; }
    const icons = { success: '✅', error: '⚠️', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = '<span>' + (icons[type] || icons.info) + '</span><span>' + esc(message) + '</span>';
    root.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 320);
    }, 4200);
  }

  /* ==========================================================
     MODAL
  ========================================================== */
  function openModal(opts) {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML =
      '<div class="modal' + (opts.size === 'lg' ? ' modal-lg' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<h3>' + esc(opts.title || 'Dialog') + '</h3>' +
          '<button type="button" class="modal-close" aria-label="Tutup">×</button>' +
        '</div>' +
        '<form id="modal-form" novalidate>' +
          '<div class="modal-body">' + (opts.body || '') + '</div>' +
          '<div class="modal-foot">' +
            '<button type="button" class="btn btn-outline modal-cancel">' + esc(opts.cancelLabel || 'Batal') + '</button>' +
            (opts.submitLabel ? '<button type="submit" class="btn ' + (opts.danger ? 'btn-danger' : '') + '">' + esc(opts.submitLabel) + '</button>' : '') +
          '</div>' +
        '</form>' +
      '</div>';
    root.appendChild(overlay);

    const close = () => { root.innerHTML = ''; };
    overlay.querySelector('.modal-close').addEventListener('click', close);
    overlay.querySelector('.modal-cancel').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });

    const form = overlay.querySelector('#modal-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!opts.onSubmit) { close(); return; }
      const result = opts.onSubmit();
      if (result !== false) close();
    });

    if (typeof opts.onOpen === 'function') opts.onOpen();

    const firstInput = overlay.querySelector('.modal-body input, .modal-body select');
    if (firstInput) firstInput.focus();
    return { close, overlay };
  }

  /** Dialog konfirmasi generik -> Promise<boolean>. */
  function confirmDialog(message, opts) {
    const o = opts || {};
    return new Promise(resolve => {
      openModal({
        title: o.title || 'Konfirmasi',
        body: '<p>' + esc(message) + '</p>' +
          (o.warning ? '<div class="callout callout-warn" style="margin-top:12px;">' + esc(o.warning) + '</div>' : ''),
        submitLabel: o.confirmLabel || 'Ya, Lanjutkan',
        danger: o.danger !== false,
        cancelLabel: o.cancelLabel || 'Batal',
        onSubmit: () => { resolve(true); return true; }
      });
      // Batal / tutup => resolve(false)
      const root = document.getElementById('modal-root');
      const cancel = root.querySelector('.modal-cancel');
      const closeBtn = root.querySelector('.modal-close');
      const settle = () => resolve(false);
      cancel.addEventListener('click', settle);
      closeBtn.addEventListener('click', settle);
      root.querySelector('.modal-overlay').addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('modal-overlay')) settle();
      });
    });
  }

  /** Tampilkan pesan kesalahan validasi di dalam modal formulir. */
  function showFormError(id, message) {
    const el = document.getElementById(id);
    if (!el) { notify(message, 'error'); return; }
    el.textContent = message;
    el.classList.remove('hidden');
    el.scrollIntoView({ block: 'nearest' });
  }

  /* ==========================================================
     MENU & NAVIGASI
  ========================================================== */
  const PAGES = {
    dashboard:  { title: 'Dashboard',         icon: '📊', roles: ['petugas'], render: () => SIPUS.Reports.renderDashboard() },
    books:      { title: 'Data Buku',         icon: '📚', roles: ['petugas'], render: () => SIPUS.Books.render() },
    members:    { title: 'Data Anggota',      icon: '👥', roles: ['petugas'], render: () => SIPUS.Members.render() },
    catalog:    { title: 'Katalog Buku',      icon: '📖', roles: ['petugas', 'anggota'], render: () => SIPUS.Books.renderCatalog() },
    loans:      { title: 'Peminjaman',        icon: '🔄', roles: ['petugas'], render: () => SIPUS.Transactions.render() },
    returns:    { title: 'Pengembalian',      icon: '↩️', roles: ['petugas'], render: () => SIPUS.Transactions.renderReturns() },
    reports:    { title: 'Laporan',           icon: '🧾', roles: ['petugas'], render: () => SIPUS.Reports.renderReports() },
    'my-history': { title: 'Riwayat Saya',    icon: '🕘', roles: ['anggota'], render: () => SIPUS.Transactions.renderMyHistory() },
    settings:   { title: 'Pengaturan',        icon: '⚙️', roles: ['petugas'], render: () => renderSettings() }
  };

  let currentPage = 'dashboard';

  function menuForRole(role) {
    if (role === 'petugas') {
      return ['dashboard', 'books', 'members', 'catalog', 'loans', 'returns', 'reports', 'settings'];
    }
    return ['catalog', 'my-history'];
  }

  function buildMenu() {
    const user = SIPUS.Auth.currentUser();
    const nav = document.getElementById('sidebar-menu');
    if (!user || !nav) return;
    nav.innerHTML = menuForRole(user.role).map(key => {
      const p = PAGES[key];
      return '<button class="menu-item' + (key === currentPage ? ' active' : '') + '" data-page="' + key + '">' +
        '<span class="menu-icon">' + p.icon + '</span>' + esc(p.title) + '</button>';
    }).join('');
    nav.querySelectorAll('.menu-item').forEach(btn => {
      btn.addEventListener('click', () => goTo(btn.getAttribute('data-page')));
    });
  }

  /** Navigasi ke halaman tertentu. */
  function goTo(pageKey) {
    const user = SIPUS.Auth.currentUser();
    if (!user) return;
    const page = PAGES[pageKey];
    if (!page || page.roles.indexOf(user.role) === -1) {
      notify('Anda tidak memiliki hak akses untuk halaman tersebut.', 'error');
      return;
    }
    currentPage = pageKey;
    document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById('page-' + pageKey);
    if (target) target.classList.remove('hidden');
    document.getElementById('page-title').textContent = page.title;
    buildMenu();
    try { page.render(); }
    catch (e) {
      console.error('Gagal merender halaman ' + pageKey, e);
      notify('Terjadi kesalahan saat menampilkan halaman.', 'error');
    }
    closeSidebar();
    window.scrollTo(0, 0);
  }

  /** Render ulang halaman yang sedang aktif (setelah data berubah). */
  function refreshPage() { goTo(currentPage); }

  function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.hidden = true;
  }

  /* ==========================================================
     LOGIN / LOGOUT / TAMPILAN SISI KLIEN
  ========================================================== */
  function onAuthChanged() {
    const user = SIPUS.Auth.currentUser();
    const loginView = document.getElementById('login-view');
    const appView = document.getElementById('app-view');

    if (!user) {
      appView.classList.add('hidden');
      loginView.classList.remove('hidden');
      const err = document.getElementById('login-error');
      if (err) err.classList.add('hidden');
      return;
    }

    // Perbarui header & footer sidebar
    const roleLabel = user.role === 'petugas' ? 'Petugas Perpustakaan' : ('Anggota' + (user.memberId ? ' — ' + user.memberId : ''));
    document.getElementById('topbar-user').innerHTML =
      '<span class="badge ' + (user.role === 'petugas' ? 'badge-petugas' : 'badge-anggota') + '">' + esc(roleLabel) + '</span> ' +
      '<strong style="color:var(--navy-900);">' + esc(user.nama) + '</strong>';
    document.getElementById('topbar-date').textContent = formatDateLengkap(U.todayISO());
    document.getElementById('sidebar-footer').innerHTML =
      '<div class="user-name">' + esc(user.nama) + '</div>' +
      '<div class="user-role">' + esc(roleLabel) + '</div>' +
      '<button class="btn btn-outline btn-sm" id="btn-logout">🚪 Keluar</button>';
    document.getElementById('btn-logout').addEventListener('click', logout);

    loginView.classList.add('hidden');
    appView.classList.remove('hidden');

    // Halaman awal sesuai peran
    currentPage = menuForRole(user.role)[0];
    goTo(currentPage);
  }

  function formatDateLengkap(iso) {
    const hari = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const d = U.parseISO(iso);
    if (!d) return '';
    return hari[d.getDay()] + ', ' + U.formatDate(iso);
  }

  function logout() {
    SIPUS.Auth.logout();
    notify('Anda telah keluar dari SIPUS.', 'info');
    onAuthChanged();
  }

  /* ==========================================================
     HALAMAN PENGATURAN (petugas)
  ========================================================== */
  function renderSettings() {
    const root = document.getElementById('page-settings');
    if (!root) return;
    const user = SIPUS.Auth.currentUser();
    const size = S.dataSize();

    root.innerHTML =
      '<div class="page-head"><div><h3>Pengaturan</h3>' +
      '<p>Kelola akun, cadangan data, dan data contoh perpustakaan.</p></div></div>' +

      '<div class="grid-2">' +
        '<div class="card">' +
          '<h4 class="card-title">Akun Aktif</h4>' +
          '<div class="detail-grid">' +
            detail('Nama', user ? user.nama : '-') +
            detail('Nama Pengguna', user ? user.username : '-') +
            detail('Peran', user && user.role === 'petugas' ? 'Petugas Perpustakaan' : 'Anggota') +
            detail('Terkait Anggota', user && user.memberId ? user.memberId : '—') +
          '</div>' +
          '<p class="callout callout-warn small" style="margin-top:14px;">' +
            'Autentikasi di SIPUS hanya simulasi lokal. Kata sandi disimpan dalam bentuk hash, ' +
            'namun penyimpanan di browser tidak memberikan keamanan yang memadai untuk produksi.</p>' +
          '<button class="btn btn-outline" id="set-logout">🚪 Keluar</button>' +
        '</div>' +

        '<div class="card">' +
          '<h4 class="card-title">Data &amp; Penyimpanan</h4>' +
          '<div class="detail-grid">' +
            detail('Buku', size.buku + ' judul') +
            detail('Anggota', size.anggota + ' orang') +
            detail('Transaksi', size.transaksi + ' transaksi') +
            detail('Pengguna', size.pengguna + ' akun') +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:9px;margin-top:14px;">' +
            '<button class="btn" id="set-export">⬇️ Ekspor Data (JSON)</button>' +
            '<button class="btn btn-outline" id="set-import">⬆️ Impor Data (JSON)</button>' +
            '<button class="btn btn-outline" id="set-sample">✨ Muat Data Contoh</button>' +
            '<button class="btn btn-danger" id="set-clear">🗑️ Hapus Semua Data</button>' +
          '</div>' +
          '<p class="small muted" style="margin-top:10px;">Data disimpan di localStorage browser perangkat ini dan tetap ada setelah halaman dimuat ulang.</p>' +
        '</div>' +
      '</div>' +

      '<div class="card">' +
        '<h4 class="card-title">Tentang Aplikasi</h4>' +
        '<p class="small">SIPUS (Sistem Informasi Perpustakaan Kampus) dibangun dengan HTML, CSS, dan JavaScript murni ' +
        'tanpa backend maupun build step — cukup buka <code>index.html</code> di browser. ' +
        'Aturan peminjaman: masa ' + S.LOAN_DAYS + ' hari kalender, maksimal ' + S.MAX_LOAN + ' eksemplar per anggota, ' +
        'denda ' + U.rupiah(S.FINE_PER_DAY) + ' per eksemplar per hari keterlambatan.</p>' +
      '</div>';

    root.querySelector('#set-logout').addEventListener('click', logout);
    root.querySelector('#set-export').addEventListener('click', doExport);
    root.querySelector('#set-import').addEventListener('click', () => {
      const input = document.getElementById('import-file');
      input.value = '';
      input.click();
    });
    root.querySelector('#set-sample').addEventListener('click', doLoadSample);
    root.querySelector('#set-clear').addEventListener('click', doClearAll);
  }

  function detail(k, v) {
    return '<div class="detail-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  /* ==========================================================
     EKSPOR, IMPOR, DATA CONTOH, RESET
  ========================================================== */
  function doExport() {
    try {
      S.exportToFile();
      notify('Data berhasil diekspor ke berkas JSON.', 'success');
    } catch (e) {
      console.error(e);
      notify('Gagal mengekspor data: ' + e.message, 'error');
    }
  }

  /** Impor: validasi struktur dulu — data lama baru diganti setelah konfirmasi. */
  async function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => notify('Gagal membaca berkas.', 'error');
    reader.onload = async () => {
      let payload;
      try {
        payload = JSON.parse(reader.result);
      } catch (e) {
        notify('Berkas tidak valid: bukan JSON yang benar.', 'error');
        return;
      }
      const res = S.validateImportPayload(payload);
      if (!res.valid) {
        openModal({
          title: 'Impor Ditolak — Data Tidak Valid',
          body: '<div class="callout callout-danger">Berkas tidak lolos validasi struktur/relasi data. Data lama TIDAK diubah.</div>' +
            '<ul class="list-plain">' + res.errors.slice(0, 12).map(e => '<li>' + esc(e) + '</li>').join('') +
            (res.errors.length > 12 ? '<li class="muted">… dan ' + (res.errors.length - 12) + ' masalah lainnya.</li>' : '') + '</ul>',
          submitLabel: null
        });
        return;
      }
      const ok = await confirmDialog(
        'Impor akan MENGGANTI seluruh data buku, anggota, dan transaksi yang tersimpan saat ini.',
        { title: 'Konfirmasi Impor', warning: 'Pastikan Anda telah mengekspor data lama bila masih diperlukan.' }
      );
      if (!ok) return;
      if (!S.applyImportData(res.data)) {
        notify('Gagal menyimpan hasil impor ke browser.', 'error');
        return;
      }
      if (!S.getUsers().length) await SIPUS.Auth.ensureDefaultUsers(false);
      notify('Data berhasil diimpor (' + res.data.buku.length + ' buku, ' +
        res.data.anggota.length + ' anggota, ' + res.data.transaksi.length + ' transaksi).', 'success');
      if (!SIPUS.Auth.currentUser()) {
        notify('Sesi berakhir karena akun tidak ada dalam data impor. Silakan masuk kembali.', 'info');
        onAuthChanged();
      } else {
        refreshPage();
      }
    };
    reader.readAsText(file);
  }

  async function doLoadSample() {
    const ok = await confirmDialog(
      'Muat data contoh akan MENGGANTI seluruh data buku, anggota, dan transaksi yang tersimpan, termasuk mengembalikan akun demo ke kondisi awal.',
      { title: 'Muat Data Contoh', warning: 'Data yang tersimpan akan diganti. Lanjutkan?', confirmLabel: 'Ya, Muat Data Contoh' }
    );
    if (!ok) return;
    if (!S.loadSampleData()) {
      notify('Gagal menyimpan data contoh.', 'error');
      return;
    }
    await SIPUS.Auth.ensureDefaultUsers(true);
    notify('Data contoh berhasil dimuat (7 buku, 5 anggota, 3 transaksi).', 'success');
    if (!SIPUS.Auth.currentUser()) onAuthChanged();
    else refreshPage();
  }

  async function doClearAll() {
    const ok = await confirmDialog(
      'Hapus SEMUA data SIPUS (buku, anggota, transaksi, pengguna) dari browser ini?',
      { title: 'Hapus Semua Data', warning: 'Tindakan ini tidak dapat dibatalkan. Ekspor data bila ingin menyimpan cadangan.' }
    );
    if (!ok) return;
    if (!S.clearAll()) { notify('Gagal menghapus data.', 'error'); return; }
    await SIPUS.Auth.ensureDefaultUsers(true);
    notify('Semua data berhasil dihapus. Akun demo dikembalikan.', 'success');
    SIPUS.Auth.logout();
    onAuthChanged();
  }

  /* ==========================================================
     BOOTSTRAP APLIKASI
  ========================================================== */
  function wireShell() {
    const toggle = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay.hidden = !sidebar.classList.contains('open');
    });
    overlay.addEventListener('click', closeSidebar);

    document.getElementById('import-file').addEventListener('change', (e) => {
      handleImportFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });
  }

  async function init() {
    if (!S.storageReady()) {
      notify('Browser ini memblokir penyimpanan lokal; data hanya bertahan selama tab terbuka.', 'error');
    }
    // Siapkan akun demo bila belum ada
    await SIPUS.Auth.ensureDefaultUsers(false);
    wireShell();
    SIPUS.Auth.init();
    onAuthChanged();
    console.log('%cSIPUS', 'color:#2563eb;font-weight:bold;',
      'Sistem Informasi Perpustakaan Kampus — aplikasi lokal tanpa backend.');
  }

  /* ==========================================================
     EKSPOR API
  ========================================================== */
  SIPUS.UI = { notify, openModal, confirmDialog, showFormError, goTo };
  SIPUS.App = { init, goTo, refreshPage, onAuthChanged, logout, PAGES };

  // Jalankan setelah seluruh DOM & script siap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
