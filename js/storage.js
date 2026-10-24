/* ============================================================
   js/storage.js — SIPUS
   Penyimpanan lokal (localStorage), utilitas tanggal/format,
   ekspor & impor JSON, validasi struktur data, dan data contoh.
   Dimuat paling pertama; mendefinisikan namespace window.SIPUS.
============================================================ */
(function () {
  'use strict';

  window.SIPUS = window.SIPUS || {};

  /* ==========================================================
     UTILITAS (dipakai seluruh modul)
  ========================================================== */
  const Util = {
    /** Tanggal hari ini (lokal perangkat) dalam format ISO yyyy-mm-dd. */
    todayISO() { return Util.toISO(new Date()); },

    /** Konversi Date -> string yyyy-mm-dd (lokal, bukan UTC). */
    toISO(d) {
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },

    /** Parse string yyyy-mm-dd menjadi Date lokal (tengah malam). */
    parseISO(s) {
      if (typeof s !== 'string') return null;
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    },

    /** Tambah hari kalender pada tanggal ISO. */
    addDays(iso, n) {
      const d = Util.parseISO(iso);
      if (!d) return null;
      d.setDate(d.getDate() + n);
      return Util.toISO(d);
    },

    /** Selisih hari kalender dari a ke b (b - a). Bilangan bulat. */
    daysBetween(a, b) {
      const da = Util.parseISO(a), db = Util.parseISO(b);
      if (!da || !db) return 0;
      return Math.round((db - da) / 86400000);
    },

    /** Format tanggal ISO -> dd/mm/yyyy. */
    formatDate(iso) {
      const d = Util.parseISO(iso);
      if (!d) return '-';
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
    },

    /** Format angka rupiah tanpa desimal: Rp1.000 */
    rupiah(n) {
      const v = Math.max(0, Math.round(Number(n) || 0));
      return 'Rp' + v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    },

    /** Escape konten untuk aman ditampilkan di innerHTML. */
    esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /** Bilangan bulat aman dari input bebas. */
    toInt(v, def) {
      const n = parseInt(v, 10);
      return isNaN(n) ? (def == null ? 0 : def) : n;
    },

    /** Teks diseragamkan untuk pencarian (case-insensitive). */
    norm(s) { return String(s == null ? '' : s).toLowerCase().trim(); }
  };

  /* ==========================================================
     KUNCI PENYIMPANAN & KONSTANTA
  ========================================================== */
  const KEYS = {
    books: 'sipus_books',
    members: 'sipus_members',
    transactions: 'sipus_transactions',
    users: 'sipus_users'
  };
  const SESSION_KEY = 'sipus_session';
  const DATA_VERSION = 1;
  const LOAN_DAYS = 7;          // masa peminjaman standar (hari kalender)
  const MAX_LOAN = 3;           // maksimal eksemplar belum dikembalikan per anggota
  const FINE_PER_DAY = 1000;    // denda per eksemplar per hari keterlambatan

  /* ==========================================================
     MEMBACA / MENULIS (dengan cadangan memori bila localStorage
     tidak tersedia, mis. mode privat yang ketat)
  ========================================================== */
  let memoryStore = null; // dipakai hanya bila localStorage gagal

  function backendAvailable() {
    try {
      const k = '__sipus_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function readRaw(key) {
    try {
      if (memoryStore) return memoryStore[key] != null ? memoryStore[key] : null;
      return window.localStorage.getItem(key);
    } catch (e) {
      console.warn('Gagal membaca localStorage:', e);
      memoryStore = memoryStore || {};
      return memoryStore[key] != null ? memoryStore[key] : null;
    }
  }

  function writeRaw(key, value) {
    try {
      if (memoryStore) { memoryStore[key] = value; return true; }
      window.localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.error('Gagal menulis localStorage:', e);
      notify('Gagal menyimpan data ke browser: ' + (e && e.message || e), 'error');
      return false;
    }
  }

  function notify(msg, type) {
    if (window.SIPUS && SIPUS.UI && typeof SIPUS.UI.notify === 'function') {
      SIPUS.UI.notify(msg, type);
    } else {
      console.log('[SIPUS]', msg);
    }
  }

  function load(key, fallback) {
    const raw = readRaw(key);
    if (raw == null) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) {
      console.warn('Data localStorage tidak valid untuk', key, e);
      return fallback;
    }
  }

  function save(key, value) {
    return writeRaw(key, JSON.stringify(value));
  }

  /* ==========================================================
     AKSES DATA INTI
  ========================================================== */
  const getBooks = () => load(KEYS.books, []);
  const getMembers = () => load(KEYS.members, []);
  const getTransactions = () => load(KEYS.transactions, []);
  const getUsers = () => load(KEYS.users, []);

  const saveBooks = (v) => save(KEYS.books, v);
  const saveMembers = (v) => save(KEYS.members, v);
  const saveTransactions = (v) => save(KEYS.transactions, v);
  const saveUsers = (v) => save(KEYS.users, v);

  function getBook(id) { return getBooks().find(b => b.id === id) || null; }
  function getMember(id) { return getMembers().find(m => m.id === id) || null; }

  function getCategories() {
    const set = new Set(getBooks().map(b => b.kategori).filter(Boolean));
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'id'));
  }

  /** Total seluruh data tersimpan (untuk halaman pengaturan). */
  function dataSize() {
    return {
      buku: getBooks().length,
      anggota: getMembers().length,
      transaksi: getTransactions().length,
      pengguna: getUsers().length
    };
  }

  /* ==========================================================
     EKSPOR & IMPOR JSON
  ========================================================== */
  function buildExportPayload() {
    return {
      aplikasi: 'SIPUS',
      deskripsi: 'Sistem Informasi Perpustakaan Kampus — data ekspor',
      versi: DATA_VERSION,
      dieksporPada: new Date().toISOString(),
      buku: getBooks(),
      anggota: getMembers(),
      transaksi: getTransactions(),
      pengguna: getUsers()
    };
  }

  /** Unduh data sebagai berkas JSON. */
  function exportToFile() {
    const payload = buildExportPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const t = Util.toISO(new Date()).replace(/-/g, '');
    a.href = url;
    a.download = 'sipus-data-' + t + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  /**
   * Validasi struktur & relasi data sebelum impor.
   * Mengembalikan { valid, errors, data } — data ternormalisasi bila valid.
   */
  function validateImportPayload(payload) {
    const errors = [];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, errors: ['Berkas bukan objek data SIPUS yang valid.'] };
    }

    const books = payload.buku || payload.books;
    const members = payload.anggota || payload.members;
    const transactions = payload.transaksi || payload.transactions || [];
    const users = payload.pengguna || payload.users || [];

    if (!Array.isArray(books)) errors.push('Properti "buku" tidak ditemukan atau bukan array.');
    if (!Array.isArray(members)) errors.push('Properti "anggota" tidak ditemukan atau bukan array.');
    if (!Array.isArray(transactions)) errors.push('Properti "transaksi" bukan array.');
    if (!Array.isArray(users)) errors.push('Properti "pengguna" bukan array.');
    if (errors.length) return { valid: false, errors };

    // --- Buku ---
    const bookIds = new Set();
    const normBooks = [];
    books.forEach((b, i) => {
      const label = 'Buku #' + (i + 1);
      if (!b || typeof b !== 'object') { errors.push(label + ' bukan objek.'); return; }
      const id = typeof b.id === 'string' ? b.id.trim() : '';
      const judul = typeof b.judul === 'string' ? b.judul.trim() : '';
      const stok = Number(b.stok);
      if (!id) errors.push(label + ' tidak memiliki kode buku.');
      else if (bookIds.has(id)) errors.push('Kode buku "' + id + '" ganda.');
      else bookIds.add(id);
      if (!judul) errors.push(label + ' tidak memiliki judul.');
      if (!Number.isInteger(stok) || stok < 0) errors.push(label + ' memiliki stok tidak valid (harus bilangan bulat >= 0).');
      normBooks.push({
        id, judul,
        penulis: typeof b.penulis === 'string' ? b.penulis : '',
        penerbit: typeof b.penerbit === 'string' ? b.penerbit : '',
        tahun: Util.toInt(b.tahun, 0),
        kategori: typeof b.kategori === 'string' ? b.kategori : 'Lainnya',
        stok: Number.isInteger(stok) ? stok : 0,
        rak: typeof b.rak === 'string' ? b.rak : '',
        createdAt: b.createdAt || null,
        updatedAt: b.updatedAt || null
      });
    });

    // --- Anggota ---
    const memberIds = new Set(), nims = new Set();
    const normMembers = [];
    members.forEach((m, i) => {
      const label = 'Anggota #' + (i + 1);
      if (!m || typeof m !== 'object') { errors.push(label + ' bukan objek.'); return; }
      const id = typeof m.id === 'string' ? m.id.trim() : '';
      const nama = typeof m.nama === 'string' ? m.nama.trim() : '';
      const nim = typeof m.nim === 'string' ? m.nim.trim() : '';
      if (!id) errors.push(label + ' tidak memiliki ID anggota.');
      else if (memberIds.has(id)) errors.push('ID anggota "' + id + '" ganda.');
      else memberIds.add(id);
      if (!nama) errors.push(label + ' tidak memiliki nama.');
      if (!nim) errors.push(label + ' tidak memiliki NIM.');
      else if (nims.has(nim)) errors.push('NIM "' + nim + '" ganda.');
      else nims.add(nim);
      normMembers.push({
        id, nama, nim,
        prodi: typeof m.prodi === 'string' ? m.prodi : '',
        telepon: typeof m.telepon === 'string' ? m.telepon : '',
        email: typeof m.email === 'string' ? m.email : '',
        createdAt: m.createdAt || null,
        updatedAt: m.updatedAt || null
      });
    });

    // --- Transaksi (periksa relasi & konsistensi stok) ---
    const txKodes = new Set();
    const normTx = [];
    const borrowed = {}; // bookId -> eksemplar belum kembali
    transactions.forEach((t, i) => {
      const label = 'Transaksi #' + (i + 1);
      if (!t || typeof t !== 'object') { errors.push(label + ' bukan objek.'); return; }
      const kode = typeof t.kode === 'string' ? t.kode.trim() : '';
      if (!kode) errors.push(label + ' tidak memiliki kode transaksi.');
      else if (txKodes.has(kode)) errors.push('Kode transaksi "' + kode + '" ganda.');
      else txKodes.add(kode);
      if (!memberIds.has(t.memberId)) errors.push(label + ' merujuk anggota yang tidak ditemukan ("' + t.memberId + '").');
      if (!Util.parseISO(t.tanggalPinjam)) errors.push(label + ' memiliki tanggal pinjam tidak valid.');
      if (!Util.parseISO(t.jatuhTempo)) errors.push(label + ' memiliki tanggal jatuh tempo tidak valid.');
      if (Util.parseISO(t.tanggalPinjam) && Util.parseISO(t.jatuhTempo) &&
          Util.daysBetween(t.tanggalPinjam, t.jatuhTempo) < 0) {
        errors.push(label + ': tanggal jatuh tempo sebelum tanggal pinjam.');
      }
      const items = Array.isArray(t.items) ? t.items : null;
      if (!items || !items.length) { errors.push(label + ' tidak memiliki daftar buku.'); return; }
      const normItems = [];
      items.forEach((it, j) => {
        const il = label + ' buku #' + (j + 1);
        if (!it || typeof it !== 'object') { errors.push(il + ' bukan objek.'); return; }
        if (!bookIds.has(it.bookId)) errors.push(il + ' merujuk buku yang tidak ditemukan ("' + it.bookId + '").');
        const jumlah = Number(it.jumlah);
        const kembali = Array.isArray(it.kembali) ? it.kembali : [];
        if (!Number.isInteger(jumlah) || jumlah < 1) errors.push(il + ' memiliki jumlah tidak valid.');
        if (kembali.length > jumlah) errors.push(il + ': jumlah pengembalian melebihi jumlah dipinjam.');
        kembali.forEach(d => { if (!Util.parseISO(d)) errors.push(il + ' memiliki tanggal kembali tidak valid.'); });
        const sisa = Math.max(0, jumlah - kembali.length);
        borrowed[it.bookId] = (borrowed[it.bookId] || 0) + sisa;
        normItems.push({
          bookId: it.bookId,
          judul: typeof it.judul === 'string' ? it.judul : '',
          jumlah: Number.isInteger(jumlah) ? jumlah : 0,
          kembali: kembali.filter(d => Util.parseISO(d))
        });
      });
      normTx.push({
        kode,
        memberId: t.memberId,
        items: normItems,
        tanggalPinjam: t.tanggalPinjam,
        jatuhTempo: t.jatuhTempo,
        createdAt: t.createdAt || null
      });
    });

    // Stok buku tidak boleh kurang dari eksemplar yang masih dipinjam
    Object.keys(borrowed).forEach(bid => {
      const bk = normBooks.find(b => b.id === bid);
      if (bk && borrowed[bid] > bk.stok) {
        errors.push('Buku "' + bid + '" memiliki stok ' + bk.stok + ' tetapi tercatat dipinjam ' + borrowed[bid] + ' eksemplar.');
      }
    });

    // --- Pengguna ---
    const usernames = new Set();
    const normUsers = [];
    users.forEach((u, i) => {
      const label = 'Pengguna #' + (i + 1);
      if (!u || typeof u !== 'object') { errors.push(label + ' bukan objek.'); return; }
      const username = typeof u.username === 'string' ? u.username.trim() : '';
      if (!username) errors.push(label + ' tidak memiliki nama pengguna.');
      else if (usernames.has(username)) errors.push('Nama pengguna "' + username + '" ganda.');
      else usernames.add(username);
      if (u.role !== 'petugas' && u.role !== 'anggota') errors.push(label + ' memiliki peran tidak valid.');
      if (!u.passwordHash || typeof u.passwordHash !== 'string') errors.push(label + ' tidak memiliki hash kata sandi.');
      if (u.role === 'anggota' && u.memberId && !memberIds.has(u.memberId)) {
        errors.push(label + ' merujuk anggota yang tidak ditemukan.');
      }
      normUsers.push({
        username,
        nama: typeof u.nama === 'string' ? u.nama : username,
        role: u.role,
        memberId: u.memberId || null,
        passwordHash: u.passwordHash
      });
    });

    return {
      valid: errors.length === 0,
      errors,
      data: { buku: normBooks, anggota: normMembers, transaksi: normTx, pengguna: normUsers }
    };
  }

  /** Ganti seluruh data dengan hasil impor yang sudah divalidasi. */
  function applyImportData(data) {
    const okB = saveBooks(data.buku);
    const okM = saveMembers(data.anggota);
    const okT = saveTransactions(data.transaksi);
    if (data.pengguna && data.pengguna.length) saveUsers(data.pengguna);
    return okB && okM && okT;
  }

  /* ==========================================================
     DATA CONTOH
     Dibuat relatif terhadap tanggal hari ini sehingga status
     transaksi contoh (dipinjam / selesai / terlambat) selalu
     konsisten saat dimuat ulang.
  ========================================================== */
  function buildSampleData() {
    const now = Util.todayISO();
    const stamp = new Date().toISOString();

    const buku = [
      { id: 'BK001', judul: 'Algoritma dan Pemrograman', penulis: 'Andi Setiawan', penerbit: 'Informatika Press', tahun: 2019, kategori: 'Teknologi', stok: 5, rak: 'A-1', createdAt: stamp, updatedAt: stamp },
      { id: 'BK002', judul: 'Rekayasa Perangkat Lunak', penulis: 'Budi Santoso', penerbit: 'Andi Publisher', tahun: 2020, kategori: 'Teknologi', stok: 4, rak: 'A-2', createdAt: stamp, updatedAt: stamp },
      { id: 'BK003', judul: 'Sistem Basis Data', penulis: 'Citra Dewi', penerbit: 'Graha Ilmu', tahun: 2018, kategori: 'Teknologi', stok: 4, rak: 'A-3', createdAt: stamp, updatedAt: stamp },
      { id: 'BK004', judul: 'Pengantar Sistem Informasi', penulis: 'Dian Kurniawan', penerbit: 'Elex Media Komputindo', tahun: 2021, kategori: 'Sistem Informasi', stok: 3, rak: 'B-1', createdAt: stamp, updatedAt: stamp },
      { id: 'BK005', judul: 'Manajemen Proyek TI', penulis: 'Eko Ramadhan', penerbit: 'Informatika Press', tahun: 2017, kategori: 'Manajemen', stok: 3, rak: 'B-2', createdAt: stamp, updatedAt: stamp },
      { id: 'BK006', judul: 'Analisis dan Perancangan Sistem', penulis: 'Fitri Handayani', penerbit: 'Andi Publisher', tahun: 2022, kategori: 'Sistem Informasi', stok: 3, rak: 'B-3', createdAt: stamp, updatedAt: stamp },
      { id: 'BK007', judul: 'Jaringan Komputer', penulis: 'Gunawan Wibowo', penerbit: 'Graha Ilmu', tahun: 2020, kategori: 'Teknologi', stok: 4, rak: 'C-1', createdAt: stamp, updatedAt: stamp }
    ];

    const anggota = [
      { id: 'AG001', nama: 'Dewi Anggraini', nim: '2110512001', prodi: 'Teknik Informatika', telepon: '081234567801', email: 'dewi.anggraini@mahasiswa.ac.id', createdAt: stamp, updatedAt: stamp },
      { id: 'AG002', nama: 'Rizky Firmansyah', nim: '2110512002', prodi: 'Sistem Informasi', telepon: '081234567802', email: 'rizky.firmansyah@mahasiswa.ac.id', createdAt: stamp, updatedAt: stamp },
      { id: 'AG003', nama: 'Salsabila Putri', nim: '2110512003', prodi: 'Teknik Informatika', telepon: '081234567803', email: 'salsabila.putri@mahasiswa.ac.id', createdAt: stamp, updatedAt: stamp },
      { id: 'AG004', nama: 'Bagus Nugroho', nim: '2110512004', prodi: 'Manajemen Informatika', telepon: '081234567804', email: 'bagus.nugroho@mahasiswa.ac.id', createdAt: stamp, updatedAt: stamp },
      { id: 'AG005', nama: 'Cahya Ramadhani', nim: '2110512005', prodi: 'Sistem Informasi', telepon: '081234567805', email: 'cahya.ramadhani@mahasiswa.ac.id', createdAt: stamp, updatedAt: stamp }
    ];

    // 3 transaksi contoh dengan variasi status:
    // 1) sedang dipinjam (jatuh tempo masih depan), 2) selesai (dikembalikan tepat waktu),
    // 3) terlambat (melewati jatuh tempo, belum dikembalikan).
    const transaksi = [
      {
        kode: 'PJM-' + now.replace(/-/g, '') + '-001',
        memberId: 'AG001',
        items: [
          { bookId: 'BK001', judul: 'Algoritma dan Pemrograman', jumlah: 2, kembali: [] },
          { bookId: 'BK003', judul: 'Sistem Basis Data', jumlah: 1, kembali: [] }
        ],
        tanggalPinjam: Util.addDays(now, -2),
        jatuhTempo: Util.addDays(now, 5),
        createdAt: stamp
      },
      {
        kode: 'PJM-' + Util.addDays(now, -12).replace(/-/g, '') + '-002',
        memberId: 'AG002',
        items: [
          { bookId: 'BK002', judul: 'Rekayasa Perangkat Lunak', jumlah: 1, kembali: [Util.addDays(now, -3)] },
          { bookId: 'BK004', judul: 'Pengantar Sistem Informasi', jumlah: 1, kembali: [Util.addDays(now, -3)] }
        ],
        tanggalPinjam: Util.addDays(now, -12),
        jatuhTempo: Util.addDays(now, -5),
        createdAt: stamp
      },
      {
        kode: 'PJM-' + Util.addDays(now, -15).replace(/-/g, '') + '-003',
        memberId: 'AG003',
        items: [
          { bookId: 'BK005', judul: 'Manajemen Proyek TI', jumlah: 1, kembali: [] }
        ],
        tanggalPinjam: Util.addDays(now, -15),
        jatuhTempo: Util.addDays(now, -8),
        createdAt: stamp
      }
    ];

    return { buku, anggota, transaksi };
  }

  /** Timpa data dengan data contoh. Pengguna/kata sandi di-reset oleh auth.js. */
  function loadSampleData() {
    const sample = buildSampleData();
    const okB = saveBooks(sample.buku);
    const okM = saveMembers(sample.anggota);
    const okT = saveTransactions(sample.transaksi);
    return okB && okM && okT;
  }

  /** Hapus seluruh data SIPUS (termasuk sesi login). */
  function clearAll() {
    try {
      if (memoryStore) {
        Object.keys(KEYS).forEach(k => delete memoryStore[KEYS[k]]);
        delete memoryStore[SESSION_KEY];
      } else {
        Object.keys(KEYS).forEach(k => window.localStorage.removeItem(KEYS[k]));
        window.localStorage.removeItem(SESSION_KEY);
      }
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  /** true bila penyimpanan browser benar-benar dapat dipakai. */
  function storageReady() { return backendAvailable() || memoryStore != null || true; }

  /* ==========================================================
     EKSPOR API
  ========================================================== */
  SIPUS.Util = Util;
  SIPUS.Storage = {
    KEYS, SESSION_KEY, DATA_VERSION, LOAN_DAYS, MAX_LOAN, FINE_PER_DAY,
    load, save,
    getBooks, getMembers, getTransactions, getUsers,
    saveBooks, saveMembers, saveTransactions, saveUsers,
    getBook, getMember, getCategories, dataSize,
    buildExportPayload, exportToFile, validateImportPayload, applyImportData,
    buildSampleData, loadSampleData, clearAll, storageReady
  };
})();
