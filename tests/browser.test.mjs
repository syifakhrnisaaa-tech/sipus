/* ============================================================
   tests/browser.test.mjs — SIPUS
   Pengujian UI nyata di Chrome headless lewat Chrome DevTools
   Protocol (tanpa dependensi): login, CRUD lewat formulir modal,
   peminjaman/pengembalian lewat UI, impor JSON lewat input file,
   hak akses, responsif, persistensi setelah reload, dan
   penangkapan error console. Juga menyusun screenshot aktual
   ke folder screenshots/.
   Jalankan: node tests/browser.test.mjs
============================================================ */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;
const CHROME = process.env.SIPUS_CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

if (!fs.existsSync(CHROME)) {
  console.error('Chrome tidak ditemukan di: ' + CHROME);
  process.exit(2);
}

/* ---------- laporan hasil ---------- */
let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; failures.push(label); console.log('  ✘ GAGAL: ' + label); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

/* ---------- luncurkan Chrome ---------- */
const profileDir = path.join(root, 'tests', '.chrome-profile-' + process.pid);
// Bersihkan sisa profil dari lari sebelumnya (tanpa gagal bila masih terkunci).
try {
  fs.readdirSync(path.join(root, 'tests'))
    .filter(d => d.startsWith('.chrome-'))
    .forEach(d => {
      try { fs.rmSync(path.join(root, 'tests', d), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
      catch (e) { /* abaikan */ }
    });
} catch (e) { /* abaikan */ }
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1440,900',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profileDir,
  'about:blank'
], { stdio: 'ignore' });

const consoleErrors = [];

async function waitForPort(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (res.ok) return true;
    } catch (e) { /* belum siap */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/* ---------- koneksi CDP ---------- */
let ws, msgId = 0;
const pending = new Map();
const eventHandlers = [];

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('WebSocket gagal: ' + e.message));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        eventHandlers.forEach(h => h(msg));
      }
    };
  });
}

function send(method, params) {
  msgId += 1;
  const id = msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

/* ---------- util evaluasi di halaman ---------- */
async function evalPage(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('Ekspresi gagal: ' + (r.exceptionDetails.exception &&
      r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result ? r.result.value : undefined;
}

async function waitFor(expression, timeoutMs, what) {
  // Boleh berupa selektor CSS atau ekspresi JavaScript di halaman.
  const looksLikeSelector = !/[(=;!]/.test(expression);
  const expr = looksLikeSelector
    ? '!!document.querySelector(' + JSON.stringify(expression) + ')'
    : expression;
  const start = Date.now();
  while (Date.now() - start < (timeoutMs || 6000)) {
    try {
      if (await evalPage(expr)) return true;
    } catch (e) { /* coba lagi */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Timeout menunggu: ' + (what || expression));
}

/** Ambil teks semua elemen yang cocok sebagai array. */
async function texts(selector) {
  const r = await evalPage(
    'JSON.stringify(Array.from(document.querySelectorAll("' + selector + '")).map(e => e.textContent.trim()))'
  );
  return JSON.parse(r || '[]');
}

async function screenshot(name) {
  // Bersihkan notifikasi agar tangkapan layar rapi
  await evalPage('document.getElementById("toast-root").innerHTML = ""');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const outDir = path.join(root, 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
  console.log('  📸 screenshots/' + name);
}

/* ---------- tangkap error console & exception ---------- */
eventHandlers.push((msg) => {
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleErrors.push('exception: ' + (d.exception && d.exception.description || d.text));
  }
  if (msg.method === 'Log.entryAdded') {
    const e = msg.params.entry;
    if (e.level === 'error' && !/favicon/i.test(e.text)) {
      consoleErrors.push(e.source + ': ' + e.text);
    }
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    if (msg.params.type === 'error') {
      const args = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
      if (!/favicon/i.test(args)) consoleErrors.push('console.error: ' + args);
    }
  }
});

/* ---------- rangkaian uji ---------- */
async function run() {
  // Port siap
  if (!(await waitForPort(15000))) throw new Error('Chrome headless tidak merespons di port ' + PORT);

  // Ambil target halaman pertama
  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('Tidak ada target halaman.');
  await connectCdp(page.webSocketDebuggerUrl);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  });

  const indexUrl = pathToFileURL(path.join(root, 'index.html')).href;
  await send('Page.navigate', { url: indexUrl });
  await waitFor('document.readyState === "complete"', 15000, 'halaman termuat');

  // Jalankan fase uji (definisi menyusul di bagian 2)
  await runPhases(screenshot);
}

async function runPhases(screenshot) {
  /* ---------- FASE 1: HALAMAN LOGIN ---------- */
  section('1. Halaman login');
  ok(await evalPage('!document.getElementById("login-view").classList.contains("hidden")'),
    'halaman login tampil pertama kali');
  ok((await texts('.login-demo-table tbody tr')).length === 2,
    'akun demo ditampilkan di halaman login');
  await screenshot('login.png');

  await evalPage(`(() => {
    document.getElementById('login-username').value = 'petugas';
    document.getElementById('login-password').value = 'salah-banget';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    return true;
  })()`);
  await waitFor('!document.getElementById("login-error").classList.contains("hidden")',
    6000, 'pesan error login');
  ok(true, 'kata sandi salah menampilkan pesan error');
  ok(await evalPage('document.getElementById("app-view").classList.contains("hidden")'),
    'aplikasi belum terbuka saat login gagal');

  await evalPage(`(() => {
    document.getElementById('login-password').value = 'petugas123';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    return true;
  })()`);
  await waitFor('!document.getElementById("app-view").classList.contains("hidden")',
    10000, 'masuk aplikasi');
  ok(true, 'login petugas berhasil, kerangka aplikasi tampil');

  /* ---------- FASE 2: MUAT DATA CONTOH LEWAT UI ---------- */
  section('2. Muat data contoh lewat UI Pengaturan');
  await evalPage(`document.querySelector('.menu-item[data-page="settings"]').click()`);
  ok(await waitFor('#set-sample', 5000, 'halaman pengaturan'), 'halaman pengaturan terbuka');
  await evalPage(`document.getElementById('set-sample').click()`);
  await waitFor('#modal-root .modal', 5000, 'dialog konfirmasi');
  ok(await evalPage(`document.getElementById('modal-root').innerText.includes('MENGGANTI')`),
    'konfirmasi menjelaskan data tersimpan akan diganti');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor('SIPUS.Storage.getBooks().length === 7', 10000, 'data contoh termuat');
  ok(await evalPage('SIPUS.Storage.getMembers().length === 5'), '5 anggota contoh termuat');
  ok(await evalPage('SIPUS.Storage.getTransactions().length === 3'), '3 transaksi contoh termuat');

  /* ---------- FASE 3: DASHBOARD ---------- */
  section('3. Dashboard');
  await evalPage(`document.querySelector('.menu-item[data-page="dashboard"]').click()`);
  await waitFor('!document.getElementById("page-dashboard").classList.contains("hidden")', 5000);
  const stats = await texts('#page-dashboard .stat-card .stat-value');
  ok(stats[0] === '7' && stats[1] === '5', 'statistik dashboard 7 judul & 5 anggota → ' + stats.join(' | '));
  ok(stats[2] === '4 eksemplar', 'buku sedang dipinjam = 4 eksemplar');
  ok(stats[3] === '1', 'peminjaman terlambat = 1');
  const dashRows = await evalPage(`document.querySelectorAll('#page-dashboard tbody tr').length`);
  ok(dashRows === 8, 'daftar transaksi terbaru (3) & buku terpopuler (5) terisi → ' + dashRows + ' baris');
  ok(await evalPage(`document.querySelectorAll('#page-dashboard .shortcut').length >= 7`),
    'navigasi pintas menu tersedia');
  await screenshot('dashboard.png');

  /* ---------- FASE 4: MANAJEMEN BUKU LEWAT FORMULIR ---------- */
  section('4. Manajemen buku lewat formulir');
  await evalPage(`document.querySelector('.menu-item[data-page="books"]').click()`);
  await waitFor('#btn-add-book', 5000, 'halaman buku');
  await evalPage(`document.getElementById('btn-add-book').click()`);
  await waitFor('#f-id', 5000, 'form tambah buku');

  // Uji validasi kode duplikat
  await evalPage(`(() => {
    document.getElementById('f-id').value = 'BK001';
    document.getElementById('f-judul').value = 'Uji Duplikat';
    document.getElementById('f-stok').value = '1';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('!document.getElementById("book-form-error").classList.contains("hidden")', 5000,
    'validasi duplikat muncul');
  ok(true, 'kode buku duplikat ditolak oleh formulir');
  ok(await evalPage('!!document.querySelector("#modal-root .modal")'),
    'modal tetap terbuka saat validasi gagal');

  // Tambah buku valid
  await evalPage(`(() => {
    document.getElementById('f-id').value = 'BK090';
    document.getElementById('f-judul').value = 'Buku Uji Browser';
    document.getElementById('f-penulis').value = 'Tester Browser';
    document.getElementById('f-kategori').value = 'Uji';
    document.getElementById('f-stok').value = '2';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('SIPUS.Storage.getBooks().length === 8', 6000, 'buku tersimpan');
  await waitFor(`document.querySelector('#page-books') && document.querySelector('#page-books tbody').innerText.includes('BK090')`,
    5000, 'baris buku baru di tabel');
  ok(true, 'buku baru tersimpan dan tampil di tabel');

  // Pencarian
  await evalPage(`(() => {
    const s = document.getElementById('book-search');
    s.value = 'Buku Uji Browser';
    s.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#page-books tbody tr').length === 1 &&
    !document.querySelector('#page-books tbody td.empty')`, 5000, 'pencarian menyaring');
  ok(true, 'pencarian judul menyaring tabel (1 hasil)');
  await evalPage(`document.getElementById('book-reset').click()`);
  await waitFor(`document.querySelectorAll('#page-books tbody tr').length === 8`, 5000, 'reset filter');

  // Hapus buku dengan konfirmasi
  await evalPage(`document.querySelector('[data-action="delete"][data-id="BK090"]').click()`);
  await waitFor('#modal-root .modal', 5000, 'dialog hapus');
  ok(await evalPage(`document.getElementById('modal-root').innerText.includes('Hapus buku')`),
    'konfirmasi penghapusan menampilkan nama buku');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor('SIPUS.Storage.getBooks().length === 7', 6000, 'buku terhapus');
  ok(true, 'buku terhapus setelah konfirmasi');

  // Hapus buku yang sedang dipinjam harus ditolak
  await evalPage(`document.querySelector('[data-action="delete"][data-id="BK001"]').click()`);
  await waitFor('#modal-root .modal', 5000, 'dialog hapus BK001');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor('SIPUS.Storage.getBooks().length === 7', 6000);
  ok(await evalPage('!!SIPUS.Storage.getBook("BK001")'),
    'buku yang sedang dipinjam tidak terhapus (notifikasi penolakan tampil)');
  await new Promise(r => setTimeout(r, 300));

  // Ubah buku via formulir (mode ubah: kode terkunci)
  await evalPage(`document.querySelector('[data-action="edit"][data-id="BK007"]').click()`);
  await waitFor('#f-rak', 5000, 'form ubah buku');
  ok(await evalPage(`document.getElementById('f-id').readOnly === true`),
    'kode buku terkunci pada mode ubah');
  await evalPage(`(() => {
    document.getElementById('f-rak').value = 'C-9';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor(`SIPUS.Storage.getBook('BK007').rak === 'C-9'`, 6000, 'perubahan tersimpan');
  ok(true, 'ubah buku via formulir berhasil dan tersimpan');

  /* ---------- FASE 4b: MANAJEMEN ANGGOTA LEWAT FORMULIR ---------- */
  section('4b. Manajemen anggota lewat formulir');
  await evalPage(`document.querySelector('.menu-item[data-page="members"]').click()`);
  await waitFor('#btn-add-member', 5000, 'halaman anggota');
  const memberSebelum = await evalPage('SIPUS.Storage.getMembers().length');

  // NIM ganda ditolak
  await evalPage(`document.getElementById('btn-add-member').click()`);
  await waitFor('#m-id', 5000, 'form tambah anggota');
  await evalPage(`(() => {
    document.getElementById('m-id').value = 'AG999';
    document.getElementById('m-nama').value = 'Anggota Baru';
    document.getElementById('m-nim').value = '2110512001';
    document.getElementById('m-telepon').value = '081234567899';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('!document.getElementById("member-form-error").classList.contains("hidden")', 5000,
    'validasi NIM ganda');
  ok(await evalPage(`document.getElementById('member-form-error').textContent.includes('sudah terdaftar')`),
    'NIM ganda ditolak oleh formulir anggota');

  // Tambah anggota valid
  await evalPage(`(() => {
    document.getElementById('m-id').value = 'AG999';
    document.getElementById('m-nama').value = 'Anggota Baru';
    document.getElementById('m-nim').value = '990011';
    document.getElementById('m-prodi').value = 'Teknik Uji';
    document.getElementById('m-telepon').value = '081234567899';
    document.getElementById('m-email').value = 'anggota.baru@mahasiswa.ac.id';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('SIPUS.Storage.getMembers().length === ' + (memberSebelum + 1), 6000,
    'anggota baru tersimpan');
  ok(true, 'anggota baru tersimpan lewat formulir');

  // Pencarian anggota
  await evalPage(`(() => {
    const s = document.getElementById('member-search');
    s.value = 'Anggota Baru';
    s.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#page-members tbody tr').length === 1 &&
    !document.querySelector('#page-members tbody td.empty')`, 5000, 'pencarian anggota');
  ok(true, 'pencarian anggota menyaring tabel (1 hasil)');

  // Ubah anggota
  await evalPage(`document.querySelector('[data-action="edit"][data-id="AG999"]').click()`);
  await waitFor('#m-prodi', 5000, 'form ubah anggota');
  await evalPage(`(() => {
    document.getElementById('m-prodi').value = 'Sistem Informasi Uji';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor(`SIPUS.Storage.getMember('AG999').prodi === 'Sistem Informasi Uji'`, 6000,
    'perubahan anggota tersimpan');
  ok(true, 'ubah anggota via formulir berhasil');

  // Hapus anggota dengan konfirmasi
  await evalPage(`document.querySelector('[data-action="delete"][data-id="AG999"]').click()`);
  await waitFor('#modal-root .modal', 5000, 'dialog hapus anggota');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor('SIPUS.Storage.getMembers().length === ' + memberSebelum, 6000,
    'anggota terhapus');
  ok(true, 'hapus anggota dengan konfirmasi berhasil');

  /* ---------- FASE 5: PEMINJAMAN LEWAT UI ---------- */
  section('5. Peminjaman lewat UI');
  await evalPage(`document.querySelector('.menu-item[data-page="loans"]').click()`);
  await waitFor('#btn-new-loan', 5000, 'halaman peminjaman');
  await evalPage(`document.getElementById('btn-new-loan').click()`);
  await waitFor('#l-member', 5000, 'form peminjaman');
  ok(await waitFor('#l-due', 3000) && await evalPage(`document.getElementById('l-due').textContent !== '-'`),
    'tanggal jatuh tempo otomatis terhitung');

  // Peminjaman valid: AG004 meminjam BK006 sebanyak 2
  await evalPage(`(() => {
    document.getElementById('l-member').value = 'AG004';
    const row = document.querySelector('#l-rows .loan-row');
    row.querySelector('.l-book').value = 'BK006';
    row.querySelector('.l-qty').value = '2';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('SIPUS.Storage.getTransactions().length === 4', 8000, 'transaksi baru tersimpan');
  ok(await evalPage('SIPUS.Books.availableCount(SIPUS.Storage.getBook("BK006")) === 1'),
    'stok BK006 otomatis berkurang 3 → 1');
  ok(await evalPage('!document.querySelector("#modal-root .modal")'), 'modal tertutup setelah simpan');

  // Ditolak: melebihi batas 3 eksemplar (AG004 sudah pinjam 2)
  await evalPage(`document.getElementById('btn-new-loan').click()`);
  await waitFor('#l-member', 5000);
  await evalPage(`(() => {
    document.getElementById('l-member').value = 'AG004';
    const row = document.querySelector('#l-rows .loan-row');
    row.querySelector('.l-book').value = 'BK007';
    row.querySelector('.l-qty').value = '2';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('!document.getElementById("loan-form-error").classList.contains("hidden")', 5000,
    'pesan batas muncul');
  ok(await evalPage(`document.getElementById('loan-form-error').textContent.includes('batas maksimal')`),
    'pinjaman melebihi batas 3 eksemplar ditolak di UI');

  // Ditolak: stok tidak mencukupi (BK006 tersisa 1, diminta 3)
  await evalPage(`(() => {
    document.getElementById('l-member').value = 'AG005';
    const row = document.querySelector('#l-rows .loan-row');
    row.querySelector('.l-book').value = 'BK006';
    row.querySelector('.l-qty').value = '3';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor(`document.getElementById('loan-form-error').textContent.includes('tidak mencukupi')`,
    5000, 'pesan stok muncul');
  ok(true, 'stok tidak tersedia ditolak di UI');
  await evalPage(`document.querySelector('#modal-root .modal-cancel').click()`);
  ok(await evalPage('SIPUS.Storage.getTransactions().length === 4'),
    'transaksi yang ditolak tidak menyimpan data');

  // Filter riwayat peminjaman
  await evalPage(`(() => {
    const s = document.getElementById('loan-search');
    s.value = 'AG004';
    s.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#page-loans tbody tr').length === 1 &&
    !document.querySelector('#page-loans tbody td.empty')`, 5000, 'pencarian riwayat');
  ok(true, 'pencarian riwayat peminjaman berfungsi');
  await evalPage(`document.getElementById('loan-reset').click()`);
  await waitFor(`document.querySelectorAll('#page-loans tbody tr').length === 4`, 5000, 'reset riwayat');

  /* ---------- FASE 6: PENGEMBALIAN LEWAT UI ---------- */
  section('6. Pengembalian lewat UI');
  await evalPage(`document.querySelector('.menu-item[data-page="returns"]').click()`);
  await waitFor('#page-returns tbody [data-return]', 5000, 'daftar pengembalian');
  const activeRows = await evalPage(`document.querySelectorAll('#page-returns tbody [data-return]').length`);
  ok(activeRows === 3, 'daftar menampilkan 3 peminjaman aktif (dapat ' + activeRows + ')');

  // (a) Kembalikan transaksi terlambat (jatuh tempo terdekat di atas) → denda Rp8.000
  await evalPage(`document.querySelector('#page-returns tbody [data-return]').click()`);
  await waitFor('#r-date', 5000, 'form pengembalian');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor(`SIPUS.Transactions.derived(SIPUS.Storage.getTransactions()
    .find(t => t.memberId === 'AG003')).status === 'selesai'`, 8000, 'transaksi telat selesai');
  const dendaTelat = await evalPage(`SIPUS.Transactions.derived(SIPUS.Storage.getTransactions()
    .find(t => t.memberId === 'AG003')).dendaTerkini`);
  ok(dendaTelat === 8000, 'denda keterlambatan 8 hari = Rp8.000 (dapat ' + dendaTelat + ')');
  ok(await evalPage('SIPUS.Books.availableCount(SIPUS.Storage.getBook("BK005")) === 3'),
    'stok BK005 kembali penuh (3) setelah pengembalian');

  // (b) Pengembalian sebagian pada transaksi AG001 (1 dari 2 BK001, BK003 belum)
  const kodeAg001 = await evalPage("SIPUS.Storage.getTransactions().find(t => t.memberId === 'AG001').kode");
  await evalPage("document.querySelector('#page-returns [data-return=\"" + kodeAg001 + "\"]').click()");
  await waitFor('#r-date', 5000, 'form pengembalian sebagian');
  await evalPage(`(() => {
    const qtys = document.querySelectorAll('#modal-root .r-qty');
    qtys[0].value = '1';
    qtys[1].value = '0';
    document.querySelector('#modal-form button[type="submit"]').click();
    return true;
  })()`);
  await waitFor('SIPUS.Books.availableCount(SIPUS.Storage.getBook("BK001")) === 4', 8000,
    'stok BK001 bertambah 1');
  ok(true, 'stok BK001 bertambah tepat satu kali (3 → 4) untuk 1 eksemplar');
  const ag001Selesai = await evalPage("SIPUS.Transactions.derived(SIPUS.Storage.getTransactions().find(t => t.kode === '" + kodeAg001 + "')).selesai");
  ok(ag001Selesai === false, 'pengembalian sebagian: transaksi AG001 belum selesai');

  // (c) Kembalikan seluruh sisa peminjaman AG004 → selesai + stok penuh
  const kodeAg004 = await evalPage("SIPUS.Storage.getTransactions().find(t => t.memberId === 'AG004').kode");
  await evalPage("document.querySelector('#page-returns [data-return=\"" + kodeAg004 + "\"]').click()");
  await waitFor('#r-date', 5000, 'form pengembalian penuh');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor("SIPUS.Transactions.derived(SIPUS.Storage.getTransactions().find(t => t.kode === '" + kodeAg004 + "')).selesai", 8000, 'transaksi AG004 selesai');
  ok(true, 'pengembalian seluruh sisa eksemplar menyelesaikan transaksi');
  ok(await evalPage('SIPUS.Books.availableCount(SIPUS.Storage.getBook("BK006")) === 3'),
    'stok BK006 kembali penuh (3) setelah pengembalian penuh');
  const activeAfter = await evalPage(`document.querySelectorAll('#page-returns tbody [data-return]').length`);
  ok(activeAfter === 1, 'hanya 1 peminjaman aktif tersisa (dapat ' + activeAfter + ')');

  /* ---------- FASE 7: LAPORAN ---------- */
  section('7. Laporan & cetak');
  await evalPage(`document.querySelector('.menu-item[data-page="reports"]').click()`);
  await waitFor('#report-table', 5000, 'halaman laporan');
  const repRows = await evalPage(`document.querySelectorAll('#report-table tbody tr').length`);
  ok(repRows === 4, 'laporan menampilkan 4 transaksi sesuai data (dapat ' + repRows + ')');
  ok(await evalPage('!!document.getElementById("btn-print")'), 'tombol cetak laporan tersedia');
  ok(await evalPage(`document.body.innerText.includes('Total denda')`), 'ringkasan total denda tampil');
  ok((await texts('#report-table thead th')).length === 8,
    'kolom laporan lengkap (kode, anggota, buku, pinjam, tempo, kembali, status, denda)');

  // Filter status
  await evalPage(`(() => {
    document.getElementById('rep-status').value = 'selesai';
    document.getElementById('rep-apply').click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#report-table tbody tr').length < 4 &&
    document.querySelectorAll('#report-table tbody tr').length > 0`, 5000, 'filter status');
  const selesaiRows = await evalPage(`document.querySelectorAll('#report-table tbody tr').length`);
  ok(true, 'filter status memperkecil hasil laporan (' + selesaiRows + ' baris selesai)');

  // Filter rentang tanggal pinjam (hari ini saja → hanya transaksi hari ini)
  await evalPage(`(() => {
    const today = SIPUS.Util.todayISO();
    document.getElementById('rep-from').value = today;
    document.getElementById('rep-to').value = today;
    document.getElementById('rep-apply').click();
    return true;
  })()`);
  await waitFor(`document.querySelectorAll('#report-table tbody tr').length === 1`, 5000,
    'filter rentang tanggal');
  ok(true, 'filter rentang tanggal memperkecil hasil laporan (1 transaksi hari ini)');

  await evalPage(`document.getElementById('rep-reset').click()`);
  await waitFor(`document.querySelectorAll('#report-table tbody tr').length === 4`, 5000, 'reset laporan');
  await new Promise(r => setTimeout(r, 300));
  await screenshot('laporan.png');

  /* ---------- FASE 8: SCREENSHOT HALAMAN LAIN ---------- */
  section('8. Screenshot antarmuka aktual');
  await evalPage(`document.querySelector('.menu-item[data-page="loans"]').click()`);
  await waitFor('#page-loans tbody tr', 5000, 'halaman peminjaman');
  await new Promise(r => setTimeout(r, 400));
  await screenshot('peminjaman.png');
  await evalPage(`document.querySelector('.menu-item[data-page="catalog"]').click()`);
  await waitFor('#cat-search', 5000, 'halaman katalog');
  await new Promise(r => setTimeout(r, 400));
  await screenshot('katalog.png');

  /* ---------- FASE 9: IMPOR JSON LEWAT INPUT FILE UI ---------- */
  section('9. Impor JSON lewat UI');
  await evalPage(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['{"foo":1}'], 'rusak.json', { type: 'application/json' }));
    const inp = document.getElementById('import-file');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await waitFor(`document.getElementById('modal-root').innerText.includes('Impor Ditolak')`, 8000,
    'impor tidak valid ditolak');
  ok(true, 'berkas JSON tidak valid ditolak dengan rincian kesalahan');
  ok(await evalPage('SIPUS.Storage.getBooks().length === 7'),
    'data lama tidak berubah saat impor ditolak');
  await evalPage(`document.querySelector('#modal-root .modal-cancel').click()`);

  // Impor valid (round-trip hasil ekspor)
  await evalPage(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([JSON.stringify(SIPUS.Storage.buildExportPayload())], 'sipus.json',
      { type: 'application/json' }));
    const inp = document.getElementById('import-file');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await waitFor(`document.getElementById('modal-root').innerText.includes('Konfirmasi Impor')`, 8000,
    'dialog konfirmasi impor tampil');
  ok(true, 'impor valid meminta konfirmasi sebelum menimpa data');
  await evalPage(`document.querySelector('#modal-form button[type="submit"]').click()`);
  await waitFor(`SIPUS.Storage.getBooks().length === 7 && !document.querySelector('#modal-root .modal')`,
    8000, 'impor valid diterima');
  ok(true, 'impor valid diterima dan data tetap utuh');
  ok(await evalPage('!!SIPUS.Auth.currentUser()'), 'sesi petugas tetap setelah impor');

  // Tombol ekspor data (Blob + unduhan JSON)
  await evalPage(`document.querySelector('.menu-item[data-page="settings"]').click()`);
  await waitFor('#set-export', 5000, 'halaman pengaturan untuk ekspor');
  await evalPage(`document.getElementById('set-export').click()`);
  await waitFor(`document.getElementById('toast-root').innerText.includes('diekspor')`, 8000,
    'notifikasi ekspor');
  ok(true, 'tombol Ekspor Data berfungsi dan menampilkan notifikasi sukses');

  /* ---------- FASE 10: LOGOUT & HAK AKSES ANGGOTA ---------- */
  section('10. Logout & hak akses anggota');
  await evalPage(`document.getElementById('btn-logout').click()`);
  await waitFor('!document.getElementById("login-view").classList.contains("hidden")', 6000,
    'kembali ke halaman login');
  ok(true, 'logout berhasil');
  await evalPage(`(() => {
    document.getElementById('login-username').value = 'mahasiswa';
    document.getElementById('login-password').value = 'mahasiswa123';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    return true;
  })()`);
  await waitFor('!document.getElementById("app-view").classList.contains("hidden")', 10000,
    'login anggota');
  const menuCount = await evalPage(`document.querySelectorAll('#sidebar-menu .menu-item').length`);
  ok(menuCount === 2, 'menu anggota hanya Katalog & Riwayat Saya (dapat ' + menuCount + ')');

  // Akses paksa halaman petugas harus ditolak
  await evalPage(`SIPUS.UI.goTo('loans')`);
  await new Promise(r => setTimeout(r, 300));
  ok(await evalPage(`document.getElementById('page-loans').classList.contains('hidden')`),
    'anggota tidak dapat membuka halaman Peminjaman');

  await evalPage(`SIPUS.UI.goTo('catalog')`);
  await waitFor('#page-catalog tbody tr', 5000, 'katalog anggota');
  ok(await evalPage(`document.querySelectorAll('#page-catalog tbody tr').length === 7`),
    'katalog menampilkan 7 judul untuk anggota');
  ok(await evalPage(`document.getElementById('page-catalog').innerText.includes('Tersedia')`),
    'label Tersedia/Stok Habis tampil di katalog');

  await evalPage(`SIPUS.UI.goTo('my-history')`);
  await waitFor('#page-my-history tbody tr', 5000, 'riwayat anggota');
  const histRows = await evalPage(`document.querySelectorAll('#page-my-history tbody tr').length`);
  ok(histRows === 1, 'riwayat peminjaman sendiri tampil (' + histRows + ' transaksi)');

  /* ---------- FASE 11: PERSISTENSI SETELAH MUAT ULANG ---------- */
  section('11. Persistensi setelah reload halaman');
  await send('Page.reload', { ignoreCache: true });
  await waitFor('document.readyState === "complete"', 20000, 'reload selesai');
  await waitFor('!document.getElementById("app-view").classList.contains("hidden")', 12000,
    'aplikasi termuat ulang');
  ok(true, 'sesi login bertahan setelah halaman dimuat ulang');
  ok(await evalPage('SIPUS.Storage.getBooks().length === 7'), 'data buku bertahan setelah reload');
  ok(await evalPage('SIPUS.Storage.getTransactions().length === 4'),
    'data transaksi bertahan setelah reload');
  ok(await evalPage(`document.querySelectorAll('#sidebar-menu .menu-item').length === 2`),
    'peran anggota tetap setelah reload');

  /* ---------- FASE 12: TAMPILAN RESPONSIF ---------- */
  section('12. Tampilan responsif mobile');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await new Promise(r => setTimeout(r, 400));
  ok(await evalPage(`getComputedStyle(document.getElementById('menu-toggle')).display !== 'none'`),
    'tombol menu tampil di layar kecil');
  ok(await evalPage(`document.getElementById('sidebar').getBoundingClientRect().left < 0 ||
    getComputedStyle(document.getElementById('sidebar')).transform !== 'none'`),
    'sidebar tersembunyi di layar kecil');
  await evalPage(`document.getElementById('menu-toggle').click()`);
  ok(await evalPage(`document.getElementById('sidebar').classList.contains('open')`),
    'sidebar terbuka lewat tombol menu');
  await evalPage(`document.getElementById('sidebar-overlay').click()`);
  ok(await evalPage(`!document.getElementById('sidebar').classList.contains('open')`),
    'sidebar tertutup lewat overlay');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  });
}

/* ---------- jalankan & bersihkan ---------- */
let exitCode = 0;
try {
  await run();
} catch (e) {
  exitCode = 1;
  console.error('\nERROR UJI: ' + (e && e.stack || e));
  failures.push('harness: ' + (e && e.message || e));
  failed++;
}

console.log('\n==========================================');
console.log('ERROR CONSOLE: ' + consoleErrors.length);
consoleErrors.slice(0, 10).forEach(e => console.log(' - ' + e));
console.log('LULUS: ' + passed + ' | GAGAL: ' + failed);
if (failed) {
  console.log('Rincian gagal:');
  failures.forEach(f => console.log(' - ' + f));
  exitCode = 1;
}
if (consoleErrors.length) exitCode = 1;

try { ws && ws.close(); } catch (e) { /* abaikan */ }
chrome.kill();
// Profil Chrome mungkin masih terkunci sesaat setelah kill — bersihkan tanpa gagal total.
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (e) {
  console.warn('Catatan: profil sementara belum dapat dihapus: ' + e.message);
}
process.exit(exitCode);
