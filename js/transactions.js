/* ============================================================
   js/transactions.js — SIPUS
   Logika peminjaman & pengembalian:
   - membuat transaksi peminjaman (batas 3 eksemplar, cek stok)
   - memproses pengembalian seluruh atau sebagian eksemplar
   - status otomatis (dipinjam / terlambat / selesai)
   - denda Rp1.000 per eksemplar per hari keterlambatan
============================================================ */
(function () {
  'use strict';

  const S = SIPUS.Storage, U = SIPUS.Util;
  const esc = U.esc;
  const MAX_LOAN = S.MAX_LOAN, LOAN_DAYS = S.LOAN_DAYS, FINE = S.FINE_PER_DAY;

  // State pencarian & filter halaman peminjaman
  const state = { q: '', status: '', dari: '', sampai: '' };

  /* ==========================================================
     PERHITUNGAN DASAR
  ========================================================== */
  /** Eksemplar pada suatu transaksi yang belum dikembalikan. */
  function sisaOf(tx) {
    return tx.items.reduce((n, it) =>
      n + Math.max(0, (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0)), 0);
  }

  /** Stok tersedia buku (total stok - eksemplar yang masih dipinjam). */
  function availableStock(bookId) {
    return SIPUS.Books.availableCount(S.getBook(bookId) || { id: bookId, stok: 0 });
  }

  /** Total eksemplar belum dikembalikan oleh satu anggota. */
  function unreturnedCount(memberId) {
    return SIPUS.Members.activeLoanCount(memberId);
  }

  /** Denda satu eksememplar yang dikembalikan pada tanggal tertentu. */
  function fineFor(jatuhTempo, tanggalKembali) {
    const late = U.daysBetween(jatuhTempo, tanggalKembali);
    return late > 0 ? late * FINE : 0;
  }

  /**
   * Turunan status & denda sebuah transaksi.
   * Status: selesai (semua eksemplar kembali), terlambat (melewati
   * jatuh tempo & belum kembali), dipinjam (lainnya).
   */
  function derived(tx, refDate) {
    const today = refDate || U.todayISO();
    const totalJumlah = tx.items.reduce((n, it) => n + (it.jumlah || 0), 0);
    const sisa = sisaOf(tx);
    const selesai = sisa === 0 && totalJumlah > 0;

    let dendaTerkini = 0;      // denda dari eksemplar yang sudah dikembalikan telat
    let dendaSementara = 0;    // denda perkiraan eksemplar yang belum kembali
    let pernahTelat = false;

    tx.items.forEach(it => {
      (it.kembali || []).forEach(tgl => {
        const f = fineFor(tx.jatuhTempo, tgl);
        dendaTerkini += f;
        if (f > 0) pernahTelat = true;
      });
      const sisaItem = Math.max(0, (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0));
      if (sisaItem > 0) {
        const telatHari = U.daysBetween(tx.jatuhTempo, today);
        if (telatHari > 0) {
          dendaSementara += telatHari * FINE * sisaItem;
          pernahTelat = true;
        }
      }
    });

    const status = selesai ? 'selesai' : (U.daysBetween(tx.jatuhTempo, today) > 0 ? 'terlambat' : 'dipinjam');
    return {
      totalJumlah, sisa, selesai, status,
      dendaTerkini, dendaSementara,
      denda: dendaTerkini + dendaSementara,
      pernahTelat: pernahTelat || (!selesai && status === 'terlambat')
    };
  }

  function statusBadge(tx) {
    const d = derived(tx);
    if (d.status === 'selesai') return '<span class="badge badge-selesai">Selesai</span>';
    if (d.status === 'terlambat') return '<span class="badge badge-terlambat">Terlambat</span>';
    return '<span class="badge badge-dipinjam">Sedang Dipinjam</span>';
  }

  /** Daftar transaksi yang belum selesai, jatuh tempo terdekat di atas. */
  function listActive() {
    return S.getTransactions()
      .filter(tx => sisaOf(tx) > 0)
      .sort((a, b) => (a.jatuhTempo < b.jatuhTempo ? -1 : 1));
  }

  /** Riwayat dengan pencarian (kode, anggota, judul) + filter status & rentang tanggal. */
  function history(filters) {
    const f = filters || state;
    const q = U.norm(f.q);
    const members = {};
    S.getMembers().forEach(m => { members[m.id] = m; });

    return S.getTransactions().filter(tx => {
      const d = derived(tx);
      if (f.status && d.status !== f.status) return false;
      if (f.dari && tx.tanggalPinjam < f.dari) return false;
      if (f.sampai && tx.tanggalPinjam > f.sampai) return false;
      if (!q) return true;
      const nama = members[tx.memberId] ? members[tx.memberId].nama : '';
      const judul = tx.items.map(i => i.judul || (S.getBook(i.bookId) || {}).judul || '').join(' ');
      return U.norm(tx.kode).includes(q) ||
             U.norm(tx.memberId).includes(q) ||
             U.norm(nama).includes(q) ||
             U.norm(judul).includes(q);
    }).sort((a, b) => (a.tanggalPinjam > b.tanggalPinjam ? -1 : 1));
  }

  /* ==========================================================
     PEMBUATAN TRANSAKSI PEMINJAMAN
  ========================================================== */
  /** Kode transaksi unik: PJM-yyyymmdd-NNN. */
  function generateKode(tanggalPinjam) {
    const prefix = 'PJM-' + tanggalPinjam.replace(/-/g, '') + '-';
    const existing = S.getTransactions()
      .filter(t => t.kode && t.kode.indexOf(prefix) === 0)
      .map(t => parseInt(t.kode.slice(prefix.length), 10) || 0);
    const next = (existing.length ? Math.max.apply(null, existing) : 0) + 1;
    return prefix + String(next).padStart(3, '0');
  }

  /**
   * Simpan peminjaman baru.
   * items: [{ bookId, qty }] — satu buku tidak boleh ganda (divalidasi).
   * Melempar Error bila validasi gagal; stok berkurang otomatis karena
   * stok tersedia dihitung dari transaksi aktif.
   */
  function createLoan(params) {
    SIPUS.Auth.requireRole('petugas');
    const errors = [];

    const member = S.getMember(params.memberId);
    if (!member) errors.push('Anggota tidak ditemukan.');

    // Gabungkan & validasi daftar buku (dua baris buku sama tidak dihitung dua kali)
    const merged = {};
    (params.items || []).forEach(it => {
      const qty = U.toInt(it.qty, 0);
      if (!it.bookId || qty < 1) return;
      merged[it.bookId] = (merged[it.bookId] || 0) + qty;
    });
    const items = Object.keys(merged).map(bookId => ({ bookId, qty: merged[bookId] }));
    const totalQty = items.reduce((n, it) => n + it.qty, 0);
    if (!totalQty) errors.push('Pilih setidaknya satu buku dengan jumlah minimal 1 eksemplar.');

    let tanggalPinjam = params.tanggalPinjam || U.todayISO();
    if (!U.parseISO(tanggalPinjam)) errors.push('Tanggal pinjam tidak valid.');
    else if (tanggalPinjam > U.todayISO()) errors.push('Tanggal pinjam tidak boleh melewati tanggal hari ini.');
    const jatuhTempo = U.parseISO(tanggalPinjam) ? U.addDays(tanggalPinjam, LOAN_DAYS) : null;

    if (errors.length) throw new Error(errors.join(' '));

    // Batas maksimal peminjaman per anggota
    const aktif = unreturnedCount(member.id);
    if (aktif + totalQty > MAX_LOAN) {
      throw new Error('Peminjaman ditolak: ' + member.nama + ' sudah meminjam ' + aktif +
        ' eksemplar dan batas maksimal adalah ' + MAX_LOAN + ' eksemplar yang belum dikembalikan.');
    }

    // Ketersediaan stok setiap buku
    const detail = [];
    items.forEach(it => {
      const book = S.getBook(it.bookId);
      if (!book) { errors.push('Buku "' + it.bookId + '" tidak ditemukan.'); return; }
      const tersedia = SIPUS.Books.availableCount(book);
      if (it.qty > tersedia) {
        errors.push('Stok "' + book.judul + '" tidak mencukupi (tersisa ' + tersedia + ' dari ' + it.qty + ' diminta).');
      }
      detail.push({ bookId: book.id, judul: book.judul, jumlah: it.qty, kembali: [] });
    });
    if (errors.length) throw new Error(errors.join(' '));

    const tx = {
      kode: generateKode(tanggalPinjam),
      memberId: member.id,
      items: detail,
      tanggalPinjam: tanggalPinjam,
      jatuhTempo: jatuhTempo,
      createdAt: new Date().toISOString()
    };
    const all = S.getTransactions();
    all.push(tx);
    S.saveTransactions(all);
    return tx;
  }

  /* ==========================================================
     PENGEMBALIAN
  ========================================================== */
  /**
   * Proses pengembalian sebagian atau seluruh eksemplar satu transaksi.
   * selections: [{ index, qty }] (index = indeks item pada tx.items)
   * Mencegah pengembalian ganda: qty dibatasi sisa eksemplar per item,
   * dan stok hanya "kembali" satu kali karena dihitung dari jumlah sisa.
   */
  function processReturn(kode, selections, tanggalKembali) {
    SIPUS.Auth.requireRole('petugas');
    const all = S.getTransactions();
    const tx = all.find(t => t.kode === kode);
    if (!tx) throw new Error('Transaksi tidak ditemukan.');
    if (sisaOf(tx) === 0) throw new Error('Transaksi ini sudah selesai dikembalikan.');

    const tgl = tanggalKembali || U.todayISO();
    if (!U.parseISO(tgl)) throw new Error('Tanggal pengembalian tidak valid.');
    if (tgl < tx.tanggalPinjam) throw new Error('Tanggal pengembalian tidak boleh sebelum tanggal pinjam.');
    if (tgl > U.todayISO()) throw new Error('Tanggal pengembalian tidak boleh melewati hari ini.');

    let denda = 0, jumlahKembali = 0;
    (selections || []).forEach(sel => {
      const it = tx.items[sel.index];
      if (!it) return;
      const qty = U.toInt(sel.qty, 0);
      if (qty < 1) return;
      const sisaItem = (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0);
      if (qty > sisaItem) {
        throw new Error('Jumlah dikembalikan melebihi sisa eksemplar "' + (it.judul || it.bookId) + '" (' + sisaItem + ').');
      }
      it.kembali = it.kembali || [];
      for (let i = 0; i < qty; i++) it.kembali.push(tgl);
      denda += fineFor(tx.jatuhTempo, tgl) * qty;
      jumlahKembali += qty;
    });

    if (!jumlahKembali) throw new Error('Tentukan jumlah buku yang dikembalikan.');

    S.saveTransactions(all);
    return { denda, jumlahKembali, selesai: sisaOf(tx) === 0, tx };
  }
  /* ==========================================================
     TAMPILAN — HALAMAN PEMINJAMAN
  ========================================================== */
  function render() {
    const root = document.getElementById('page-loans');
    if (!root) return;

    const st = SIPUS.Books.stats();
    const rows = history(state);
    const members = {};
    S.getMembers().forEach(m => { members[m.id] = m; });

    root.innerHTML =
      '<div class="page-head">' +
        '<div><h3>Peminjaman Buku</h3><p>Buat transaksi peminjaman dan telusuri riwayatnya.</p></div>' +
        '<button class="btn" id="btn-new-loan">＋ Peminjaman Baru</button>' +
      '</div>' +

      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-icon">🧾</div><div><div class="stat-value">' + S.getTransactions().length + '</div><div class="stat-label">Total Transaksi</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon warn">📖</div><div><div class="stat-value">' + listActive().length + '</div><div class="stat-label">Peminjaman Belum Selesai</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon danger">⏰</div><div><div class="stat-value">' + S.getTransactions().filter(t => derived(t).status === 'terlambat').length + '</div><div class="stat-label">Peminjaman Terlambat</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon ok">📦</div><div><div class="stat-value">' + st.tersedia + '</div><div class="stat-label">Eksemplar Tersedia</div></div></div>' +
      '</div>' +

      '<div class="card">' +
        '<h4 class="card-title">Riwayat Peminjaman</h4>' +
        '<div class="toolbar no-print">' +
          '<div class="field grow">' +
            '<label for="loan-search">Pencarian</label>' +
            '<input type="search" id="loan-search" placeholder="Cari kode transaksi, anggota, atau judul buku..." value="' + esc(state.q) + '">' +
          '</div>' +
          '<div class="field">' +
            '<label for="loan-status">Status</label>' +
            '<select id="loan-status">' +
              option('', 'Semua status', state.status) +
              option('dipinjam', 'Sedang Dipinjam', state.status) +
              option('terlambat', 'Terlambat', state.status) +
              option('selesai', 'Selesai', state.status) +
            '</select>' +
          '</div>' +
          '<div class="field"><label for="loan-from">Dari Tanggal</label><input type="date" id="loan-from" value="' + esc(state.dari) + '"></div>' +
          '<div class="field"><label for="loan-to">Sampai Tanggal</label><input type="date" id="loan-to" value="' + esc(state.sampai) + '"></div>' +
          '<button class="btn btn-outline" id="loan-reset">Reset</button>' +
        '</div>' +

        '<div class="table-wrap"><table class="table">' +
          '<thead><tr>' +
            '<th>Kode</th><th>Anggota</th><th>Buku</th><th>Tgl Pinjam</th>' +
            '<th>Jatuh Tempo</th><th>Sisa</th><th>Status</th><th>Denda</th><th class="no-print">Aksi</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (rows.length ? rows.map(tx => txRowHtml(tx, members)).join('') :
            '<tr><td class="empty" colspan="9">Tidak ada transaksi yang cocok dengan pencarian/filter.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
      '</div>';

    root.querySelector('#btn-new-loan').addEventListener('click', openLoanForm);
    const search = root.querySelector('#loan-search');
    search.addEventListener('input', () => {
      state.q = search.value;
      render();
      const s = root.querySelector('#loan-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
    root.querySelector('#loan-status').addEventListener('change', e => { state.status = e.target.value; render(); });
    root.querySelector('#loan-from').addEventListener('change', e => { state.dari = e.target.value; render(); });
    root.querySelector('#loan-to').addEventListener('change', e => { state.sampai = e.target.value; render(); });
    root.querySelector('#loan-reset').addEventListener('click', () => {
      state.q = ''; state.status = ''; state.dari = ''; state.sampai = '';
      render();
    });
    root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.getAttribute('data-action');
        const kode = btn.getAttribute('data-kode');
        if (act === 'detail') openTxDetail(kode);
        else if (act === 'return') SIPUS.UI.goTo('returns');
      });
    });
  }

  function option(value, label, current) {
    return '<option value="' + esc(value) + '"' + (current === value ? ' selected' : '') + '>' + esc(label) + '</option>';
  }

  function txRowHtml(tx, members) {
    const d = derived(tx);
    const m = members[tx.memberId];
    const buku = tx.items.map(it => esc(it.judul || it.bookId) + ' <span class="muted small">(x' + it.jumlah + ')</span>').join('<br>');
    return '<tr>' +
      '<td class="nowrap"><strong>' + esc(tx.kode) + '</strong></td>' +
      '<td>' + esc(m ? m.nama : tx.memberId) + '<div class="small muted">' + esc(tx.memberId) + '</div></td>' +
      '<td>' + buku + '</td>' +
      '<td class="nowrap">' + U.formatDate(tx.tanggalPinjam) + '</td>' +
      '<td class="nowrap">' + U.formatDate(tx.jatuhTempo) + '</td>' +
      '<td class="nowrap">' + d.sisa + ' eksemplar</td>' +
      '<td>' + statusBadge(tx) + '</td>' +
      '<td class="nowrap">' + (d.denda > 0 ? '<span style="color:var(--danger);font-weight:600;">' + U.rupiah(d.denda) + '</span>' : '<span class="muted">-</span>') +
        (d.dendaSementara > 0 ? '<div class="small muted">sementara</div>' : '') + '</td>' +
      '<td class="actions no-print">' +
        '<button class="btn btn-sm btn-outline" data-action="detail" data-kode="' + esc(tx.kode) + '">Lihat</button>' +
        (d.sisa > 0 ? ' <button class="btn btn-sm btn-success" data-action="return" data-kode="' + esc(tx.kode) + '">Kembalikan</button>' : '') +
      '</td>' +
    '</tr>';
  }

  /** Modal pembuatan peminjaman baru. */
  function openLoanForm() {
    const members = S.getMembers();
    const books = S.getBooks();
    if (!members.length) { SIPUS.UI.notify('Belum ada anggota. Tambahkan anggota terlebih dahulu.', 'error'); return; }
    if (!books.length) { SIPUS.UI.notify('Belum ada buku. Tambahkan buku terlebih dahulu.', 'error'); return; }

    const memberOpts = members.map(m =>
      '<option value="' + esc(m.id) + '">' + esc(m.nama) + ' — ' + esc(m.id) + ' (' + esc(m.nim) + ')</option>').join('');
    const bookOpts = books.map(b => {
      const avail = SIPUS.Books.availableCount(b);
      return '<option value="' + esc(b.id) + '"' + (avail < 1 ? ' disabled' : '') + '>' +
        esc(b.judul) + ' — tersedia ' + avail + '</option>';
    }).join('');

    const body =
      '<div class="form-error hidden" id="loan-form-error"></div>' +
      '<div class="form-group"><label>Anggota *</label>' +
        '<select id="l-member"><option value="">— Pilih anggota —</option>' + memberOpts + '</select>' +
        '<p class="hint">Maksimal ' + MAX_LOAN + ' eksemplar yang belum dikembalikan per anggota; masa peminjaman ' + LOAN_DAYS + ' hari kalender.</p>' +
      '</div>' +
      '<div class="form-group"><label>Tanggal Pinjam</label>' +
        '<input type="date" id="l-date" value="' + U.todayISO() + '" max="' + U.todayISO() + '">' +
        '<p class="hint">Jatuh tempo otomatis: <strong id="l-due">' + U.formatDate(U.addDays(U.todayISO(), LOAN_DAYS)) + '</strong></p>' +
      '</div>' +
      '<div class="form-group"><label>Buku yang Dipinjam *</label>' +
        '<div id="l-rows"></div>' +
        '<button type="button" class="btn btn-sm btn-outline" id="l-add-row">＋ Tambah Judul Buku</button>' +
      '</div>';

    SIPUS.UI.openModal({
      title: 'Peminjaman Baru',
      body: body,
      submitLabel: 'Simpan Peminjaman',
      size: 'lg',
      onOpen: () => {
        const rowsEl = document.getElementById('l-rows');
        const dateEl = document.getElementById('l-date');
        const dueEl = document.getElementById('l-due');

        function refreshDue() {
          const v = dateEl.value;
          dueEl.textContent = U.parseISO(v) ? U.formatDate(U.addDays(v, LOAN_DAYS)) : '-';
        }
        dateEl.addEventListener('change', refreshDue);

        function addRow() {
          const div = document.createElement('div');
          div.className = 'loan-row';
          div.innerHTML =
            '<div class="form-group" style="flex:1;margin:0;"><select class="l-book">' +
              '<option value="">— Pilih buku —</option>' + bookOpts + '</select></div>' +
            '<div class="form-group" style="margin:0;"><input class="l-qty" type="number" min="1" max="3" value="1" title="Jumlah eksemplar"></div>' +
            '<button type="button" class="btn btn-sm btn-outline l-remove">✕</button>';
          div.querySelector('.l-remove').addEventListener('click', () => div.remove());
          rowsEl.appendChild(div);
        }
        addRow();
        document.getElementById('l-add-row').addEventListener('click', addRow);
      },
      onSubmit: () => {
        const memberId = document.getElementById('l-member').value;
        const tanggal = document.getElementById('l-date').value;
        const items = [];
        const seen = {};
        let dupMsg = '';
        document.querySelectorAll('#l-rows .loan-row').forEach(row => {
          const bookId = row.querySelector('.l-book').value;
          const qty = U.toInt(row.querySelector('.l-qty').value, 0);
          if (!bookId || qty < 1) return;
          if (seen[bookId]) {
            const b = S.getBook(bookId);
            dupMsg = 'Buku "' + (b ? b.judul : bookId) + '" terdaftar dua kali. Gabungkan jumlah eksemplarnya dalam satu baris.';
            return;
          }
          seen[bookId] = true;
          items.push({ bookId, qty });
        });
        if (dupMsg) { SIPUS.UI.showFormError('loan-form-error', dupMsg); return false; }
        try {
          const tx = createLoan({ memberId, items, tanggalPinjam: tanggal });
          SIPUS.UI.notify('Peminjaman ' + tx.kode + ' berhasil disimpan. Stok buku berkurang otomatis.', 'success');
          SIPUS.App.refreshPage();
          return true;
        } catch (e) {
          SIPUS.UI.showFormError('loan-form-error', e.message);
          return false;
        }
      }
    });
  }

  /** Modal detail transaksi. */
  function openTxDetail(kode) {
    const tx = S.getTransactions().find(t => t.kode === kode);
    if (!tx) return;
    const m = S.getMember(tx.memberId);
    const d = derived(tx);
    const itemRows = tx.items.map(it => {
      const kembali = (it.kembali || []).map(U.formatDate).join(', ') || 'belum kembali';
      return '<tr>' +
        '<td>' + esc(it.judul || it.bookId) + '<div class="small muted">' + esc(it.bookId) + '</div></td>' +
        '<td>' + it.jumlah + '</td>' +
        '<td>' + (it.kembali ? it.kembali.length : 0) + '</td>' +
        '<td class="small">' + esc(kembali) + '</td>' +
      '</tr>';
    }).join('');
    const body =
      '<div class="detail-grid" style="margin-bottom:12px;">' +
        item('Kode Transaksi', tx.kode) +
        item('Anggota', (m ? m.nama + ' (' + m.id + ')' : tx.memberId)) +
        item('Tanggal Pinjam', U.formatDate(tx.tanggalPinjam)) +
        item('Jatuh Tempo', U.formatDate(tx.jatuhTempo)) +
        item('Status', d.status) +
        item('Total Denda', U.rupiah(d.denda) + (d.dendaSementara > 0 ? ' (sebagian sementara)' : '')) +
      '</div>' +
      '<div class="table-wrap"><table class="table">' +
        '<thead><tr><th>Buku</th><th>Jumlah</th><th>Dikembalikan</th><th>Tanggal Kembali</th></tr></thead>' +
        '<tbody>' + itemRows + '</tbody>' +
      '</table></div>';
    SIPUS.UI.openModal({ title: 'Detail Transaksi ' + tx.kode, body: body, submitLabel: null, size: 'lg' });
  }

  function item(k, v) {
    return '<div class="detail-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  /* ==========================================================
     TAMPILAN — HALAMAN PENGEMBALIAN
  ========================================================== */
  function renderReturns() {
    const root = document.getElementById('page-returns');
    if (!root) return;
    const members = {};
    S.getMembers().forEach(m => { members[m.id] = m; });
    const active = listActive();
    const today = U.todayISO();

    root.innerHTML =
      '<div class="page-head">' +
        '<div><h3>Pengembalian Buku</h3><p>Proses pengembalian seluruh atau sebagian eksemplar dari satu transaksi.</p></div>' +
      '</div>' +

      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-icon">📥</div><div><div class="stat-value">' + active.length + '</div><div class="stat-label">Peminjaman Aktif</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon danger">⏰</div><div><div class="stat-value">' + active.filter(t => derived(t).status === 'terlambat').length + '</div><div class="stat-label">Terlambat</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon warn">⌛</div><div><div class="stat-value">' + active.reduce((n, t) => n + sisaOf(t), 0) + '</div><div class="stat-label">Eksemplar Belum Kembali</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon danger">💸</div><div><div class="stat-value">' + U.rupiah(active.reduce((n, t) => n + derived(t).denda, 0)) + '</div><div class="stat-label">Denda Sementara</div></div></div>' +
      '</div>' +

      '<div class="card">' +
        '<h4 class="card-title">Daftar Peminjaman Belum Selesai</h4>' +
        '<div class="table-wrap"><table class="table">' +
          '<thead><tr>' +
            '<th>Kode</th><th>Anggota</th><th>Buku</th><th>Jatuh Tempo</th>' +
            '<th>Sisa Eksemplar</th><th>Status</th><th>Denda</th><th class="no-print">Aksi</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (active.length ? active.map(tx => {
            const d = derived(tx, today);
            const m = members[tx.memberId];
            const sisaItems = tx.items
              .map((it, idx) => ({ it, idx, sisa: (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0) }))
              .filter(x => x.sisa > 0)
              .map(x => esc(x.it.judul || x.it.bookId) + ' <span class="muted small">(sisa ' + x.sisa + ')</span>').join('<br>');
            const telat = U.daysBetween(tx.jatuhTempo, today);
            return '<tr>' +
              '<td class="nowrap"><strong>' + esc(tx.kode) + '</strong></td>' +
              '<td>' + esc(m ? m.nama : tx.memberId) + '<div class="small muted">' + esc(tx.memberId) + '</div></td>' +
              '<td>' + sisaItems + '</td>' +
              '<td class="nowrap">' + U.formatDate(tx.jatuhTempo) +
                (telat > 0 ? '<div class="small" style="color:var(--danger);">telat ' + telat + ' hari</div>' : '') + '</td>' +
              '<td class="nowrap">' + d.sisa + ' eksemplar</td>' +
              '<td>' + statusBadge(tx) + '</td>' +
              '<td class="nowrap">' + (d.denda > 0 ? '<span style="color:var(--danger);font-weight:600;">' + U.rupiah(d.denda) + '</span><div class="small muted">' + (d.dendaSementara > 0 ? 'sementara' : 'terbayar') + '</div>' : '<span class="muted">-</span>') + '</td>' +
              '<td class="actions no-print"><button class="btn btn-sm btn-success" data-return="' + esc(tx.kode) + '">Proses Pengembalian</button></td>' +
            '</tr>';
          }).join('') :
            '<tr><td class="empty" colspan="8">Semua peminjaman sudah dikembalikan. 🎉</td></tr>') +
          '</tbody>' +
        '</table></div>' +
      '</div>';

    root.querySelectorAll('[data-return]').forEach(btn => {
      btn.addEventListener('click', () => openReturnForm(btn.getAttribute('data-return')));
    });
  }

  /** Modal pemrosesan pengembalian (seluruh atau sebagian eksemplar). */
  function openReturnForm(kode) {
    const tx = S.getTransactions().find(t => t.kode === kode);
    if (!tx) return;
    const today = U.todayISO();
    const rows = tx.items.map((it, idx) => ({
      it, idx,
      sisa: (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0)
    })).filter(x => x.sisa > 0);

    const body =
      '<div class="form-error hidden" id="return-form-error"></div>' +
      '<p class="small muted" style="margin-bottom:10px;">' +
        'Transaksi <strong>' + esc(tx.kode) + '</strong> — jatuh tempo ' + U.formatDate(tx.jatuhTempo) +
        '. Denda ' + U.rupiah(FINE) + ' per eksemplar per hari keterlambatan.</p>' +
      '<div class="form-group"><label>Tanggal Pengembalian</label>' +
        '<input type="date" id="r-date" value="' + today + '" max="' + today + '" min="' + esc(tx.tanggalPinjam) + '">' +
      '</div>' +
      rows.map(x =>
        '<div class="form-group">' +
          '<label>' + esc(x.it.judul || x.it.bookId) + ' — sisa ' + x.sisa + ' eksemplar</label>' +
          '<input type="number" class="r-qty" data-index="' + x.idx + '" min="0" max="' + x.sisa + '" value="' + x.sisa + '">' +
        '</div>').join('') +
      '<div class="callout callout-info small">Isi 0 untuk eksemplar yang belum dikembalikan. Transaksi otomatis menjadi <strong>Selesai</strong> bila seluruh eksemplar kembali.</div>';

    SIPUS.UI.openModal({
      title: 'Proses Pengembalian',
      body: body,
      submitLabel: 'Simpan Pengembalian',
      onSubmit: () => {
        const tgl = document.getElementById('r-date').value;
        const selections = [];
        document.querySelectorAll('#modal-root .r-qty').forEach(el => {
          selections.push({ index: U.toInt(el.getAttribute('data-index'), -1), qty: U.toInt(el.value, 0) });
        });
        try {
          const res = processReturn(kode, selections, tgl);
          let msg = 'Pengembalian ' + res.jumlahKembali + ' eksemplar tersimpan.';
          if (res.denda > 0) msg += ' Denda keterlambatan: ' + U.rupiah(res.denda) + '.';
          else msg += ' Tidak ada denda.';
          if (res.selesai) msg += ' Transaksi selesai.';
          SIPUS.UI.notify(msg, res.denda > 0 ? 'info' : 'success');
          SIPUS.App.refreshPage();
          return true;
        } catch (e) {
          SIPUS.UI.showFormError('return-form-error', e.message);
          return false;
        }
      }
    });
  }

  /* ==========================================================
     TAMPILAN — RIWAYAT PEMINJAMAN SAYA (khusus anggota)
  ========================================================== */
  function renderMyHistory() {
    const root = document.getElementById('page-my-history');
    if (!root) return;
    const user = SIPUS.Auth.currentUser();
    if (!user || !user.memberId) {
      root.innerHTML = '<div class="card"><p>Akun ini tidak terhubung dengan data anggota.</p></div>';
      return;
    }
    const m = S.getMember(user.memberId);
    const rows = S.getTransactions()
      .filter(t => t.memberId === user.memberId)
      .sort((a, b) => (a.tanggalPinjam > b.tanggalPinjam ? -1 : 1));
    const aktif = unreturnedCount(user.memberId);

    root.innerHTML =
      '<div class="page-head"><div><h3>Riwayat Peminjaman Saya</h3>' +
      '<p>' + esc(m ? m.nama : user.memberId) + ' — ' + esc(user.memberId) + '</p></div></div>' +

      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-icon">🧾</div><div><div class="stat-value">' + rows.length + '</div><div class="stat-label">Total Transaksi</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon warn">📖</div><div><div class="stat-value">' + aktif + '</div><div class="stat-label">Eksemplar Dipinjam</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon ok">✅</div><div><div class="stat-value">' + rows.filter(t => derived(t).selesai).length + '</div><div class="stat-label">Sudah Selesai</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon danger">💸</div><div><div class="stat-value">' + U.rupiah(rows.reduce((n, t) => n + derived(t).denda, 0)) + '</div><div class="stat-label">Total Denda</div></div></div>' +
      '</div>' +

      '<div class="card">' +
        '<h4 class="card-title">Daftar Peminjaman</h4>' +
        '<p class="callout callout-info small">Peminjaman dicatat oleh petugas perpustakaan. Masa peminjaman ' + LOAN_DAYS + ' hari kalender, maksimal ' + MAX_LOAN + ' eksemplar.</p>' +
        '<div class="table-wrap"><table class="table">' +
          '<thead><tr><th>Kode</th><th>Buku</th><th>Tgl Pinjam</th><th>Jatuh Tempo</th><th>Status</th><th>Denda</th></tr></thead>' +
          '<tbody>' +
          (rows.length ? rows.map(tx => {
            const d = derived(tx);
            return '<tr>' +
              '<td class="nowrap"><strong>' + esc(tx.kode) + '</strong></td>' +
              '<td>' + tx.items.map(it => esc(it.judul || it.bookId) + ' <span class="muted small">(x' + it.jumlah + ')</span>').join('<br>') + '</td>' +
              '<td class="nowrap">' + U.formatDate(tx.tanggalPinjam) + '</td>' +
              '<td class="nowrap">' + U.formatDate(tx.jatuhTempo) + '</td>' +
              '<td>' + statusBadge(tx) + '</td>' +
              '<td class="nowrap">' + (d.denda > 0 ? U.rupiah(d.denda) : '<span class="muted">-</span>') + '</td>' +
            '</tr>';
          }).join('') :
            '<tr><td class="empty" colspan="6">Belum ada riwayat peminjaman.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
      '</div>';
  }

  /* ==========================================================
     EKSPOR API
  ========================================================== */
  SIPUS.Transactions = {
    render, renderReturns, renderMyHistory,
    createLoan, processReturn,
    derived, sisaOf, listActive, history, availableStock, unreturnedCount,
    fineFor, statusBadge, MAX_LOAN, LOAN_DAYS, FINE
  };
})();
