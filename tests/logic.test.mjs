/* ============================================================
   tests/logic.test.mjs — SIPUS
   Pengujian logika inti di Node (tanpa browser):
   memuat script aplikasi ke dalam konteks VM palsu
   (localStorage & sessionStorage berbasis Map) lalu menjalankan
   alur penting: CRUD, peminjaman, pengembalian, denda,
   validasi impor, persistensi, dan autentikasi.
   Jalankan: node tests/logic.test.mjs
============================================================ */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- laporan hasil ---------- */
let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; failures.push(label); console.log('  ✘ GAGAL: ' + label); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }
function throwsWith(fn, substr, label) {
  try { fn(); ok(false, label + ' (tidak melempar error)'); }
  catch (e) {
    ok(e.message.includes(substr), label + ' → "' + e.message.slice(0, 90) + '"');
  }
}

/* ---------- DOM & storage palsu ---------- */
function makeStorageMap() { return new Map(); }

function makeStubEl() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, style: {},
    className: '', files: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, setSelectionRange() {}, scrollIntoView() {}, click() {}, getAttribute() { return null; }
  };
}

function makeContext(storeMap, sessionMap) {
  const localStorage = {
    getItem: k => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => { storeMap.set(k, String(v)); },
    removeItem: k => { storeMap.delete(k); },
    clear: () => storeMap.clear()
  };
  const sessionStorage = {
    getItem: k => (sessionMap.has(k) ? sessionMap.get(k) : null),
    setItem: (k, v) => { sessionMap.set(k, String(v)); },
    removeItem: k => { sessionMap.delete(k); }
  };
  const sandbox = {
    console,
    localStorage,
    sessionStorage,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    FileReader: class { readAsText() {} },
    setTimeout,
    clearTimeout,
    document: {
      readyState: 'loading', // init() aplikasi tidak dijalankan otomatis di Node
      addEventListener() {}, removeEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() { return makeStubEl(); },
      body: makeStubEl()
    }
  };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

function loadApp(ctx) {
  const files = ['storage.js', 'auth.js', 'books.js', 'members.js', 'transactions.js', 'reports.js', 'app.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(root, 'js', f), 'utf8');
    vm.runInContext(code, ctx, { filename: 'js/' + f });
  }
  return ctx;
}

/* ---------- siapkan aplikasi pertama ---------- */
const storeMap = makeStorageMap();
const sessionMap = new Map();
const ctx = loadApp(makeContext(storeMap, sessionMap));
const S = vm.runInContext('SIPUS.Storage', ctx);
const U = vm.runInContext('SIPUS.Util', ctx);
const Auth = vm.runInContext('SIPUS.Auth', ctx);
const Books = vm.runInContext('SIPUS.Books', ctx);
const Members = vm.runInContext('SIPUS.Members', ctx);
const Tx = vm.runInContext('SIPUS.Transactions', ctx);
const Reports = vm.runInContext('SIPUS.Reports', ctx);

// Hak akses: jalankan sebagai petugas
sessionMap.set(S.SESSION_KEY, 'petugas');
await Auth.ensureDefaultUsers(false); // buat akun demo agar sesi petugas valid

/* ==========================================================
   1. DATA CONTOH & STATISTIK
========================================================== */
section('1. Data contoh & statistik dashboard');
S.loadSampleData();
ok(S.getBooks().length === 7, 'memuat 7 judul buku contoh');
ok(S.getMembers().length === 5, 'memuat 5 anggota contoh');
ok(S.getTransactions().length === 3, 'memuat 3 transaksi contoh');

const statuses = S.getTransactions().map(t => Tx.derived(t).status).sort();
ok(statuses.includes('dipinjam'), 'ada transaksi berstatus sedang dipinjam');
ok(statuses.includes('selesai'), 'ada transaksi berstatus selesai');
ok(statuses.includes('terlambat'), 'ada transaksi berstatus terlambat');

const dash = Reports.dashboardStats();
ok(dash.judul === 7, 'dashboard: total judul = 7');
ok(dash.anggota === 5, 'dashboard: total anggota = 5');
ok(dash.dipinjam === 4, 'dashboard: eksemplar dipinjam = 4 (2+1+1)');
ok(dash.terlambat === 1, 'dashboard: peminjaman terlambat = 1');
ok(dash.tersedia === 22, 'dashboard: eksemplar tersedia = 22 (26 - 4 dipinjam)');

// Konsistensi stok contoh
ok(Books.availableCount(S.getBook('BK001')) === 3, 'BK001 tersedia 3 dari 5 (2 dipinjam)');
ok(Books.availableCount(S.getBook('BK005')) === 2, 'BK005 tersedia 2 dari 3 (1 dipinjam)');

/* ==========================================================
   2. CRUD BUKU
========================================================== */
section('2. Manajemen buku');
const newBook = Books.createBook({ id: 'bk-099', judul: 'Buku Uji', penulis: 'Tester', penerbit: 'Penerbit Uji', tahun: '2024', kategori: 'Uji', stok: '2', rak: 'Z-1' });
ok(newBook.id === 'BK-099', 'kode buku diseragamkan huruf besar');
throwsWith(() => Books.createBook({ id: 'BK001', judul: 'Duplikat', stok: 1 }), 'sudah digunakan', 'kode buku duplikat ditolak');
throwsWith(() => Books.createBook({ id: 'BK777', judul: 'Tanpa Stok', stok: -3 }), 'stok', 'stok negatif ditolak');
throwsWith(() => Books.createBook({ id: 'BK778', judul: '', stok: 1 }), 'Judul', 'judul wajib diisi');
Books.updateBook('BK-099', { id: 'BK-099', judul: 'Buku Uji Diubah', penulis: 'Tester', penerbit: 'Penerbit Uji', tahun: '2024', kategori: 'Uji', stok: '4', rak: 'Z-1' });
ok(S.getBook('BK-099').judul === 'Buku Uji Diubah' && S.getBook('BK-099').stok === 4, 'ubah buku berhasil');
throwsWith(() => Books.updateBook('BK001', { id: 'BK001', judul: 'X', stok: 1 }), 'sedang dipinjam', 'stok tidak boleh kurang dari eksemplar dipinjam');
Books.deleteBook('BK-099');
ok(!S.getBook('BK-099'), 'buku tanpa pinjaman dapat dihapus');
throwsWith(() => Books.deleteBook('BK001'), 'masih dipinjam', 'buku yang sedang dipinjam tidak dapat dihapus');

/* ==========================================================
   3. CRUD ANGGOTA
========================================================== */
section('3. Manajemen anggota');
Members.createMember({ id: 'AG-999', nama: 'Anggota Uji', nim: '999999', prodi: 'Uji', telepon: '0811111111', email: 'uji@contoh.ac.id' });
ok(!!S.getMember('AG-999'), 'tambah anggota berhasil');
throwsWith(() => Members.createMember({ id: 'AG001', nama: 'Duplikat', nim: '888888' }), 'sudah digunakan', 'ID anggota duplikat ditolak');
throwsWith(() => Members.createMember({ id: 'AG888', nama: 'Nim Ganda', nim: '2110512001' }), 'sudah terdaftar', 'NIM duplikat ditolak');
Members.updateMember('AG-999', { id: 'AG-999', nama: 'Anggota Uji 2', nim: '999999', prodi: 'Uji', telepon: '0811111111', email: 'uji@contoh.ac.id' });
ok(S.getMember('AG-999').nama === 'Anggota Uji 2', 'ubah anggota berhasil');
throwsWith(() => Members.deleteMember('AG001'), 'peminjaman aktif', 'anggota dengan pinjaman aktif tidak dapat dihapus');
Members.deleteMember('AG-999');
ok(!S.getMember('AG-999'), 'anggota tanpa pinjaman dapat dihapus');

/* ==========================================================
   4. PEMINJAMAN: STOK BERKURANG & VALIDASI
========================================================== */
section('4. Peminjaman buku');
const availSebelum = Books.availableCount(S.getBook('BK006'));
const tx1 = Tx.createLoan({ memberId: 'AG004', items: [{ bookId: 'BK006', qty: 2 }] });
ok(tx1.kode.indexOf('PJM-') === 0, 'kode transaksi dibuat: ' + tx1.kode);
ok(tx1.jatuhTempo === U.addDays(tx1.tanggalPinjam, 7), 'jatuh tempo = tanggal pinjam + 7 hari kalender');
ok(Books.availableCount(S.getBook('BK006')) === availSebelum - 2, 'stok tersedia berkurang 2 eksemplar');

// Anggota AG004 kini meminjam 2 eksemplar; batas maksimal 3
throwsWith(() => Tx.createLoan({ memberId: 'AG004', items: [{ bookId: 'BK007', qty: 2 }] }), 'batas maksimal', 'pinjaman melebihi batas 3 eksemplar ditolak');
// Stok habis
throwsWith(() => Tx.createLoan({ memberId: 'AG-UNKNOWN', items: [{ bookId: 'BK006', qty: 1 }] }), 'tidak ditemukan', 'anggota tidak valid ditolak');
throwsWith(() => Tx.createLoan({ memberId: 'AG005', items: [{ bookId: 'BK006', qty: 3 }] }), 'tidak mencukupi', 'stok tidak mencukupi ditolak');
throwsWith(() => Tx.createLoan({ memberId: 'AG005', items: [] }), 'setidaknya satu buku', 'transaksi tanpa buku ditolak');

// Duplikat buku dalam satu transaksi digabung (tidak dihitung dua kali)
const tx2 = Tx.createLoan({ memberId: 'AG005', items: [{ bookId: 'BK007', qty: 1 }, { bookId: 'BK007', qty: 2 }] });
ok(tx2.items.length === 1 && tx2.items[0].jumlah === 3, 'buku sama dalam satu transaksi digabung jumlahnya');

/* ==========================================================
   5. PENGEMBALIAN: STOK & DENDA
========================================================== */
section('5. Pengembalian, keterlambatan, dan denda');
// Kembalikan sebagian BK006 (1 dari 2) pada tx1
const today = U.todayISO();
const res1 = Tx.processReturn(tx1.kode, [{ index: 0, qty: 1 }], today);
ok(res1.jumlahKembali === 1 && !res1.selesai, 'pengembalian sebagian dicatat, transaksi belum selesai');
ok(Books.availableCount(S.getBook('BK006')) === availSebelum - 1, 'stok bertambah tepat satu kali (1 eksemplar)');
// Pengembalian ganda melebihi sisa ditolak
throwsWith(() => Tx.processReturn(tx1.kode, [{ index: 0, qty: 5 }], today), 'melebihi sisa', 'pengembalian melebihi sisa eksemplar ditolak');
// Kembalikan sisa -> selesai
const res2 = Tx.processReturn(tx1.kode, [{ index: 0, qty: 1 }], today);
ok(res2.selesai === true, 'transaksi menjadi selesai saat semua eksemplar kembali');
ok(Books.availableCount(S.getBook('BK006')) === availSebelum, 'stok kembali penuh setelah selesai');
throwsWith(() => Tx.processReturn(tx1.kode, [{ index: 0, qty: 1 }], today), 'sudah selesai', 'pengembalian ganda pada transaksi selesai ditolak');

// Denda: pinjam 15 hari lalu, jatuh tempo 8 hari lalu, kembali hari ini → 8 hari × Rp1.000
const txLate = S.getTransactions().find(t => t.memberId === 'AG003');
const dSebelum = Tx.derived(txLate).denda;
ok(dSebelum === 8 * 1000, 'denda sementara terlambat 8 hari = Rp8.000 (dapat ' + U.rupiah(dSebelum) + ')');
const resLate = Tx.processReturn(txLate.kode, [{ index: 0, qty: 1 }], today);
ok(resLate.denda === 8 * 1000, 'denda saat pengembalian telat = Rp8.000 (dapat ' + U.rupiah(resLate.denda) + ')');
const txLateAfter = S.getTransactions().find(t => t.kode === txLate.kode); // ambil ulang dari penyimpanan
ok(Tx.derived(txLateAfter).status === 'selesai', 'transaksi telat menjadi selesai setelah dikembalikan');

// Pengembalian tepat waktu tanpa denda
Members.createMember({ id: 'AG-99X', nama: 'Anggota Uji X', nim: '777777' });
const txNew2 = Tx.createLoan({ memberId: 'AG-99X', items: [{ bookId: 'BK002', qty: 1 }], tanggalPinjam: today });
const resOnTime = Tx.processReturn(txNew2.kode, [{ index: 0, qty: 1 }], today);
ok(resOnTime.denda === 0, 'pengembalian tepat waktu tanpa denda');
// Tanggal kembali sebelum pinjam / setelah hari ini ditolak
const txNew3 = Tx.createLoan({ memberId: 'AG-99X', items: [{ bookId: 'BK003', qty: 1 }], tanggalPinjam: today });
throwsWith(() => Tx.processReturn(txNew3.kode, [{ index: 0, qty: 1 }], U.addDays(today, 2)), 'melewati hari ini', 'tanggal kembali masa depan ditolak');
Tx.processReturn(txNew3.kode, [{ index: 0, qty: 1 }], today);

/* ==========================================================
   6. LAPORAN & TOp BUKU
========================================================== */
section('6. Laporan & buku terpopuler');
const top = Reports.topBooks(3);
ok(top.length > 0 && top[0].jumlah >= top[top.length - 1].jumlah, 'buku terpopuler terurut menurun');
ok(top[0].bookId === 'BK007', 'buku paling sering dipinjam = BK007 (' + top[0].jumlah + ' eksemplar dari data uji)');
const semuaTx = S.getTransactions();
ok(semuaTx.every(t => Tx.derived(t).totalJumlah > 0), 'semua transaksi memiliki jumlah eksemplar valid');

/* ==========================================================
   7. EKSPOR & VALIDASI IMPOR
========================================================== */
section('7. Ekspor, impor, dan validasi berkas');
const payload = S.buildExportPayload();
ok(payload.buku.length === S.getBooks().length && payload.transaksi.length === S.getTransactions().length, 'payload ekspor berisi seluruh data');

// Berkas tidak valid: struktur salah
let v = S.validateImportPayload({ foo: 'bar' });
ok(!v.valid && v.errors.length > 0, 'impor objek sembarangan ditolak');

// Berkas tidak valid: kode buku ganda & stok negatif
v = S.validateImportPayload({
  buku: [
    { id: 'X1', judul: 'A', stok: 1 },
    { id: 'X1', judul: 'B', stok: 1 }
  ],
  anggota: [{ id: 'M1', nama: 'N', nim: '1' }],
  transaksi: []
});
ok(!v.valid && v.errors.some(e => e.includes('ganda')), 'kode buku ganda pada berkas impor ditolak');

// Berkas tidak valid: stok kurang dari yang dipinjam
v = S.validateImportPayload({
  buku: [{ id: 'X1', judul: 'A', stok: 1 }],
  anggota: [{ id: 'M1', nama: 'N', nim: '1' }],
  transaksi: [{
    kode: 'PJM-1', memberId: 'M1',
    items: [{ bookId: 'X1', jumlah: 3, kembali: [] }],
    tanggalPinjam: U.todayISO(), jatuhTempo: U.addDays(U.todayISO(), 7)
  }]
});
ok(!v.valid && v.errors.some(e => e.includes('dipinjam')), 'impor dengan stok tidak konsisten ditolak');

// Berkas valid diterima
v = S.validateImportPayload(payload);
ok(v.valid, 'berkas hasil ekspor sendiri lolos validasi (' + v.errors.length + ' error)');

// Simpan data lama, lalu impor data valid → data berubah sesuai berkas
const jumlahSebelum = S.getBooks().length;
const dataImpor = {
  buku: [{ id: 'IM1', judul: 'Hasil Impor', penulis: 'A', penerbit: 'B', tahun: 2020, kategori: 'Uji', stok: 2, rak: 'R-1' }],
  anggota: [{ id: 'IM-A1', nama: 'Anggota Impor', nim: '555555' }],
  transaksi: []
};
v = S.validateImportPayload(dataImpor);
ok(v.valid, 'berkas impor valid diterima');
S.applyImportData(v.data);
ok(S.getBooks().length === 1 && S.getBooks()[0].judul === 'Hasil Impor', 'data lama diganti setelah validasi & konfirmasi');
ok(S.getMembers().length === 1, 'data anggota ikut diganti');
ok(jumlahSebelum >= 7, 'sebelumnya ada data (jika tidak divalidasi, impor tidak boleh menimpa)');

/* ==========================================================
   8. PERSISTENSI (simulasi muat ulang halaman)
========================================================== */
section('8. Persistensi localStorage');
const ctx2 = loadApp(makeContext(storeMap, sessionMap)); // konteks baru = "reload"
const S2 = vm.runInContext('SIPUS.Storage', ctx2);
ok(S2.getBooks().length === 1 && S2.getBooks()[0].id === 'IM1', 'data buku bertahan setelah "reload"');
ok(S2.getMembers().length === 1, 'data anggota bertahan setelah "reload"');
ok(S2.getUsers().length >= 0, 'data pengguna dibaca tanpa error');

/* ==========================================================
   9. AUTENTIKASI & HAK AKSES
========================================================== */
section('9. Autentikasi & hak akses');
await Auth.ensureDefaultUsers(true);
const loginOk = await Auth.login('petugas', 'petugas123');
ok(loginOk.ok === true && loginOk.user.role === 'petugas', 'login petugas berhasil');
const loginMember = await Auth.login('mahasiswa', 'mahasiswa123');
ok(loginMember.ok === true && loginMember.user.role === 'anggota', 'login anggota berhasil');
const loginWrong = await Auth.login('petugas', 'salah');
ok(loginWrong.ok === false, 'kata sandi salah ditolak');
const userHash = S.getUsers().find(u => u.username === 'petugas');
ok(userHash.passwordHash !== 'petugas123' && userHash.passwordHash.length >= 20, 'kata sandi tidak disimpan sebagai teks biasa');

// Hak akses: anggota tidak boleh membuat peminjaman
sessionMap.set(S.SESSION_KEY, 'mahasiswa');
throwsWith(() => Books.createBook({ id: 'ZZ1', judul: 'X', stok: 1 }), 'petugas', 'anggota tidak dapat menambah buku');
throwsWith(() => Tx.createLoan({ memberId: 'AG001', items: [{ bookId: 'BK001', qty: 1 }] }), 'petugas', 'anggota tidak dapat membuat peminjaman');
sessionMap.set(S.SESSION_KEY, 'petugas');

/* ==========================================================
   10. UTILITAS TANGGAL & FORMAT
========================================================== */
section('10. Util tanggal & format');
ok(U.formatDate('2026-10-24') === '24/10/2026', 'format tanggal dd/mm/yyyy');
ok(U.addDays('2026-02-26', 3) === '2026-03-01', 'addDays melewati batas bulan');
ok(U.daysBetween('2026-01-01', '2026-01-08') === 7, 'daysBetween menghitung hari kalender');
ok(U.rupiah(1000) === 'Rp1.000' && U.rupiah(1234567) === 'Rp1.234.567', 'format rupiah');
ok(U.rupiah(0) === 'Rp0', 'rupiah nol');

/* ---------- ringkasan ---------- */
console.log('\n==========================================');
console.log('LULUS: ' + passed + ' | GAGAL: ' + failed);
if (failed) {
  console.log('Rincian gagal:');
  failures.forEach(f => console.log(' - ' + f));
  process.exit(1);
}
