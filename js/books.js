/* ============================================================
   js/books.js — SIPUS
   Manajemen buku: tambah, ubah, hapus, lihat detail, pencarian,
   filter kategori, dan validasi (kode unik, stok tidak negatif).
============================================================ */
(function () {
  'use strict';

  const S = SIPUS.Storage, U = SIPUS.Util;
  const esc = U.esc;

  // State pencarian/filter halaman (hidup selama sesi)
  const state = { q: '', kategori: '' };

  /* ==========================================================
     PERHITUNGAN STOK
     Stok tersedia dihitung dinamis dari total stok dikurangi
     eksemplar yang masih dipinjam pada transaksi aktif,
     sehingga stok tidak pernah "kembar ganda" saat pengembalian.
  ========================================================== */
  function borrowedCount(bookId) {
    let n = 0;
    S.getTransactions().forEach(tx => {
      tx.items.forEach(it => {
        if (it.bookId !== bookId) return;
        n += Math.max(0, (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0));
      });
    });
    return n;
  }

  function availableCount(book) {
    return Math.max(0, (book.stok || 0) - borrowedCount(book.id));
  }

  /** Statistik koleksi: judul, total eksemplar, eksemplar tersedia. */
  function stats() {
    const books = S.getBooks();
    let eksemplar = 0, tersedia = 0;
    books.forEach(b => { eksemplar += b.stok || 0; tersedia += availableCount(b); });
    return { judul: books.length, eksemplar, tersedia };
  }

  /* ==========================================================
     VALIDASI & CRUD
  ========================================================== */
  /** Validasi input buku. editingId diisi saat mode ubah (abaikan kode diri sendiri). */
  function validate(input, editingId) {
    const errors = [];
    const id = String(input.id || '').trim().toUpperCase();
    const judul = String(input.judul || '').trim();
    const stok = Number(input.stok);

    if (!id) errors.push('Kode buku wajib diisi.');
    else if (!/^[A-Z0-9-]+$/.test(id)) errors.push('Kode buku hanya boleh huruf, angka, dan tanda hubung.');
    else if (S.getBooks().some(b => b.id === id && b.id !== editingId)) errors.push('Kode buku "' + id + '" sudah digunakan.');

    if (!judul) errors.push('Judul buku wajib diisi.');
    if (!Number.isInteger(stok) || stok < 0) errors.push('Jumlah stok harus bilangan bulat >= 0.');
    if (input.tahun && (Number(input.tahun) < 1000 || Number(input.tahun) > 2100)) errors.push('Tahun terbit tidak valid.');

    return errors;
  }

  function createBook(input) {
    SIPUS.Auth.requireRole('petugas');
    const errors = validate(input, null);
    if (errors.length) throw new Error(errors.join(' '));
    const books = S.getBooks();
    const now = new Date().toISOString();
    books.push({
      id: String(input.id).trim().toUpperCase(),
      judul: String(input.judul).trim(),
      penulis: String(input.penulis || '').trim(),
      penerbit: String(input.penerbit || '').trim(),
      tahun: U.toInt(input.tahun, 0),
      kategori: String(input.kategori || '').trim() || 'Lainnya',
      stok: Number(input.stok),
      rak: String(input.rak || '').trim(),
      createdAt: now,
      updatedAt: now
    });
    S.saveBooks(books);
    return books[books.length - 1];
  }

  function updateBook(id, input) {
    SIPUS.Auth.requireRole('petugas');
    const errors = validate(input, id);
    if (errors.length) throw new Error(errors.join(' '));
    const books = S.getBooks();
    const book = books.find(b => b.id === id);
    if (!book) throw new Error('Buku tidak ditemukan.');
    // Stok baru harus tetap >= eksemplar yang sedang dipinjam
    const dipinjam = borrowedCount(id);
    if (Number(input.stok) < dipinjam) {
      throw new Error('Stok tidak boleh kurang dari jumlah eksemplar yang sedang dipinjam (' + dipinjam + ').');
    }
    Object.assign(book, {
      judul: String(input.judul).trim(),
      penulis: String(input.penulis || '').trim(),
      penerbit: String(input.penerbit || '').trim(),
      tahun: U.toInt(input.tahun, 0),
      kategori: String(input.kategori || '').trim() || 'Lainnya',
      stok: Number(input.stok),
      rak: String(input.rak || '').trim(),
      updatedAt: new Date().toISOString()
    });
    S.saveBooks(books);
    return book;
  }

  function deleteBook(id) {
    SIPUS.Auth.requireRole('petugas');
    const dipinjam = borrowedCount(id);
    if (dipinjam > 0) {
      throw new Error('Buku ini masih dipinjam (' + dipinjam + ' eksemplar) dan tidak dapat dihapus agar data transaksi tetap konsisten.');
    }
    const books = S.getBooks().filter(b => b.id !== id);
    S.saveBooks(books);
    return true;
  }

  /* ==========================================================
     PENCARIAN & FILTER
  ========================================================== */
  function filtered() {
    const q = U.norm(state.q);
    return S.getBooks().filter(b => {
      const cocokQ = !q ||
        U.norm(b.judul).includes(q) ||
        U.norm(b.penulis).includes(q) ||
        U.norm(b.id).includes(q);
      const cocokKat = !state.kategori || b.kategori === state.kategori;
      return cocokQ && cocokKat;
    });
  }

  /* ==========================================================
     TAMPILAN
  ========================================================== */
  function render() {
    const root = document.getElementById('page-books');
    if (!root) return;
    const st = stats();
    const rows = filtered();
    const kategoriOpts = S.getCategories();

    root.innerHTML =
      '<div class="page-head">' +
        '<div><h3>Data Buku</h3><p>Kelola koleksi judul, stok eksemplar, dan lokasi rak.</p></div>' +
        '<button class="btn" id="btn-add-book">＋ Tambah Buku</button>' +
      '</div>' +

      '<div class="stats-grid">' +
        statCard('📚', 'Total Judul Buku', st.judul, '') +
        statCard('📦', 'Total Eksemplar', st.eksemplar, '') +
        statCard('✅', 'Eksemplar Tersedia', st.tersedia, 'ok') +
        statCard('🏷️', 'Kategori', kategoriOpts.length, '') +
      '</div>' +

      '<div class="card">' +
        '<div class="toolbar no-print">' +
          '<div class="field grow">' +
            '<label for="book-search">Pencarian</label>' +
            '<input type="search" id="book-search" placeholder="Cari judul, penulis, atau kode buku..." value="' + esc(state.q) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label for="book-filter">Kategori</label>' +
            '<select id="book-filter">' +
              '<option value="">Semua kategori</option>' +
              kategoriOpts.map(k => '<option value="' + esc(k) + '"' + (state.kategori === k ? ' selected' : '') + '>' + esc(k) + '</option>').join('') +
            '</select>' +
          '</div>' +
          '<button class="btn btn-outline" id="book-reset">Reset</button>' +
        '</div>' +

        '<div class="table-wrap"><table class="table">' +
          '<thead><tr>' +
            '<th>Kode</th><th>Judul</th><th>Penulis</th><th>Kategori</th>' +
            '<th>Rak</th><th>Stok / Tersedia</th><th>Status</th><th class="no-print">Aksi</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (rows.length ? rows.map(rowHtml).join('') :
            '<tr><td class="empty" colspan="8">Tidak ada buku yang cocok dengan pencarian/filter.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
        '<p class="small muted" style="margin-top:10px;">Menampilkan ' + rows.length + ' dari ' + S.getBooks().length + ' judul buku.</p>' +
      '</div>';

    // Pasang perilaku
    root.querySelector('#btn-add-book').addEventListener('click', () => openForm(null));
    const search = root.querySelector('#book-search');
    search.addEventListener('input', () => {
      state.q = search.value;
      render();
      const s = root.querySelector('#book-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
    root.querySelector('#book-filter').addEventListener('change', (e) => { state.kategori = e.target.value; render(); });
    root.querySelector('#book-reset').addEventListener('click', () => { state.q = ''; state.kategori = ''; render(); });
    root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-action');
        if (act === 'view') openDetail(id);
        else if (act === 'edit') openForm(id);
        else if (act === 'delete') confirmDelete(id);
      });
    });
  }

  function statCard(icon, label, value, kind) {
    return '<div class="stat-card">' +
      '<div class="stat-icon ' + (kind || '') + '">' + icon + '</div>' +
      '<div><div class="stat-value">' + value + '</div><div class="stat-label">' + esc(label) + '</div></div>' +
    '</div>';
  }

  function rowHtml(b) {
    const avail = availableCount(b);
    const badge = avail > 0
      ? '<span class="badge badge-tersedia">Tersedia</span>'
      : '<span class="badge badge-habis">Stok Habis</span>';
    return '<tr>' +
      '<td class="nowrap"><strong>' + esc(b.id) + '</strong></td>' +
      '<td>' + esc(b.judul) + '<div class="small muted">' + esc(b.penerbit || '-') + ' · ' + (b.tahun || '-') + '</div></td>' +
      '<td>' + esc(b.penulis || '-') + '</td>' +
      '<td><span class="badge badge-kategori">' + esc(b.kategori) + '</span></td>' +
      '<td class="nowrap">' + esc(b.rak || '-') + '</td>' +
      '<td class="nowrap">' + (b.stok || 0) + ' / ' + avail + '</td>' +
      '<td>' + badge + '</td>' +
      '<td class="actions no-print">' +
        '<button class="btn btn-sm btn-outline" data-action="view" data-id="' + esc(b.id) + '">Lihat</button> ' +
        '<button class="btn btn-sm btn-outline" data-action="edit" data-id="' + esc(b.id) + '">Ubah</button> ' +
        '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + esc(b.id) + '">Hapus</button>' +
      '</td>' +
    '</tr>';
  }

  /** Modal tambah/ubah buku. */
  function openForm(id) {
    const book = id ? S.getBook(id) : null;
    const kategoriList = S.getCategories();
    const body =
      '<div class="form-error hidden" id="book-form-error"></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Kode Buku *</label>' +
          '<input id="f-id" value="' + esc(book ? book.id : '') + '" placeholder="mis. BK008"' + (book ? ' readonly' : '') + '>' +
          (book ? '<p class="hint">Kode buku tidak dapat diubah.</p>' : '<p class="hint">Harus unik, mis. BK008.</p>') +
        '</div>' +
        '<div class="form-group"><label>Tahun Terbit</label>' +
          '<input id="f-tahun" type="number" min="1000" max="2100" value="' + (book && book.tahun ? book.tahun : '') + '" placeholder="mis. 2021">' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>Judul Buku *</label><input id="f-judul" value="' + esc(book ? book.judul : '') + '"></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Penulis</label><input id="f-penulis" value="' + esc(book ? book.penulis : '') + '"></div>' +
        '<div class="form-group"><label>Penerbit</label><input id="f-penerbit" value="' + esc(book ? book.penerbit : '') + '"></div>' +
      '</div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Kategori</label>' +
          '<input id="f-kategori" list="kategori-list" value="' + esc(book ? book.kategori : '') + '" placeholder="mis. Teknologi">' +
          '<datalist id="kategori-list">' + kategoriList.map(k => '<option value="' + esc(k) + '">').join('') + '</datalist>' +
        '</div>' +
        '<div class="form-group"><label>Jumlah Stok *</label><input id="f-stok" type="number" min="0" step="1" value="' + (book ? book.stok : 1) + '"></div>' +
      '</div>' +
      '<div class="form-group"><label>Lokasi Rak</label><input id="f-rak" value="' + esc(book ? book.rak : '') + '" placeholder="mis. A-4"></div>';

    SIPUS.UI.openModal({
      title: book ? 'Ubah Buku' : 'Tambah Buku',
      body: body,
      submitLabel: book ? 'Simpan Perubahan' : 'Tambah',
      onSubmit: () => {
        const input = {
          id: (document.getElementById('f-id').value || '').trim().toUpperCase(),
          judul: document.getElementById('f-judul').value,
          penulis: document.getElementById('f-penulis').value,
          penerbit: document.getElementById('f-penerbit').value,
          tahun: document.getElementById('f-tahun').value,
          kategori: document.getElementById('f-kategori').value,
          stok: document.getElementById('f-stok').value,
          rak: document.getElementById('f-rak').value
        };
        try {
          if (book) updateBook(book.id, input);
          else createBook(input);
          SIPUS.UI.notify(book ? 'Buku berhasil diperbarui.' : 'Buku berhasil ditambahkan.', 'success');
          SIPUS.App.refreshPage();
          return true;
        } catch (e) {
          SIPUS.UI.showFormError('book-form-error', e.message);
          return false;
        }
      }
    });
  }

  /** Modal detail buku. */
  function openDetail(id) {
    const b = S.getBook(id);
    if (!b) return;
    const dipinjam = borrowedCount(b.id);
    const body =
      '<div class="detail-grid">' +
        detailItem('Kode Buku', b.id) +
        detailItem('Judul', b.judul) +
        detailItem('Penulis', b.penulis || '-') +
        detailItem('Penerbit', b.penerbit || '-') +
        detailItem('Tahun Terbit', b.tahun || '-') +
        detailItem('Kategori', b.kategori) +
        detailItem('Lokasi Rak', b.rak || '-') +
        detailItem('Total Eksemplar', (b.stok || 0) + ' eksemplar') +
        detailItem('Sedang Dipinjam', dipinjam + ' eksemplar') +
        detailItem('Stok Tersedia', availableCount(b) + ' eksemplar') +
      '</div>';
    SIPUS.UI.openModal({ title: 'Detail Buku', body: body, submitLabel: null });
  }

  function detailItem(k, v) {
    return '<div class="detail-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  /** Konfirmasi hapus buku. */
  function confirmDelete(id) {
    const b = S.getBook(id);
    if (!b) return;
    SIPUS.UI.confirmDialog(
      'Hapus buku "' + b.judul + '" (' + b.id + ')? Tindakan ini tidak dapat dibatalkan.'
    ).then(ok => {
      if (!ok) return;
      try {
        deleteBook(id);
        SIPUS.UI.notify('Buku berhasil dihapus.', 'success');
        SIPUS.App.refreshPage();
      } catch (e) {
        SIPUS.UI.notify(e.message, 'error');
      }
    });
  }

  /* ==========================================================
     KATALOG BUKU (untuk anggota & petugas, tanpa aksi penghapusan)
  ========================================================== */
  const catState = { q: '', kategori: '' };

  function catalogFiltered() {
    const q = U.norm(catState.q);
    return S.getBooks().filter(b => {
      const cocokQ = !q || U.norm(b.judul).includes(q) || U.norm(b.penulis).includes(q) || U.norm(b.id).includes(q);
      const cocokKat = !catState.kategori || b.kategori === catState.kategori;
      return cocokQ && cocokKat;
    });
  }

  function renderCatalog() {
    const root = document.getElementById('page-catalog');
    if (!root) return;
    const rows = catalogFiltered();
    const kategoriList = S.getCategories();
    const st = stats();

    root.innerHTML =
      '<div class="page-head">' +
        '<div><h3>Katalog Buku</h3><p>Jelajahi koleksi perpustakaan beserta ketersediaan stok.</p></div>' +
      '</div>' +

      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-icon">📚</div><div><div class="stat-value">' + st.judul + '</div><div class="stat-label">Judul Tersedia</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon ok">✅</div><div><div class="stat-value">' + st.tersedia + '</div><div class="stat-label">Eksemplar Siap Dipinjam</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon">🏷️</div><div><div class="stat-value">' + kategoriList.length + '</div><div class="stat-label">Kategori</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon warn">📍</div><div><div class="stat-value">' + new Set(S.getBooks().map(b => b.rak).filter(Boolean)).size + '</div><div class="stat-label">Lokasi Rak</div></div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="toolbar no-print">' +
          '<div class="field grow">' +
            '<label for="cat-search">Pencarian</label>' +
            '<input type="search" id="cat-search" placeholder="Cari judul, penulis, atau kode buku..." value="' + esc(catState.q) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label for="cat-filter">Kategori</label>' +
            '<select id="cat-filter">' +
              '<option value="">Semua kategori</option>' +
              kategoriList.map(k => '<option value="' + esc(k) + '"' + (catState.kategori === k ? ' selected' : '') + '>' + esc(k) + '</option>').join('') +
            '</select>' +
          '</div>' +
          '<button class="btn btn-outline" id="cat-reset">Reset</button>' +
        '</div>' +

        '<div class="table-wrap"><table class="table">' +
          '<thead><tr>' +
            '<th>Kode</th><th>Judul</th><th>Penulis</th><th>Kategori</th>' +
            '<th>Penerbit</th><th>Tahun</th><th>Rak</th><th>Stok Tersedia</th><th>Status</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (rows.length ? rows.map(b => {
            const avail = availableCount(b);
            return '<tr>' +
              '<td class="nowrap"><strong>' + esc(b.id) + '</strong></td>' +
              '<td>' + esc(b.judul) + '</td>' +
              '<td>' + esc(b.penulis || '-') + '</td>' +
              '<td><span class="badge badge-kategori">' + esc(b.kategori) + '</span></td>' +
              '<td>' + esc(b.penerbit || '-') + '</td>' +
              '<td>' + (b.tahun || '-') + '</td>' +
              '<td class="nowrap">' + esc(b.rak || '-') + '</td>' +
              '<td class="nowrap">' + avail + ' dari ' + (b.stok || 0) + ' eksemplar</td>' +
              '<td>' + (avail > 0 ? '<span class="badge badge-tersedia">Tersedia</span>' : '<span class="badge badge-habis">Stok Habis</span>') + '</td>' +
            '</tr>';
          }).join('') :
            '<tr><td class="empty" colspan="9">Tidak ada buku yang cocok dengan pencarian/filter.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
        '<p class="small muted" style="margin-top:10px;">Menampilkan ' + rows.length + ' dari ' + S.getBooks().length + ' judul. Peminjaman dicatat oleh petugas melalui menu Peminjaman.</p>' +
      '</div>';

    const search = root.querySelector('#cat-search');
    search.addEventListener('input', () => {
      catState.q = search.value;
      renderCatalog();
      const s = root.querySelector('#cat-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
    root.querySelector('#cat-filter').addEventListener('change', e => { catState.kategori = e.target.value; renderCatalog(); });
    root.querySelector('#cat-reset').addEventListener('click', () => { catState.q = ''; catState.kategori = ''; renderCatalog(); });
  }

  SIPUS.Books = {
    render, renderCatalog, stats, availableCount, borrowedCount,
    createBook, updateBook, deleteBook, validate
  };
})();
