/* ============================================================
   js/reports.js — SIPUS
   Dashboard dan Laporan:
   - statistik ringkas yang diperbarui otomatis dari data terkini
   - transaksi terbaru & buku paling sering dipinjam
   - laporan peminjaman/pengembalian/keterlambatan/denda
     dengan filter rentang tanggal, status, dan tombol cetak
============================================================ */
(function () {
  'use strict';

  const S = SIPUS.Storage, U = SIPUS.Util, T = SIPUS.Transactions;
  const esc = U.esc;

  // Filter halaman laporan
  const reportState = { dari: '', sampai: '', status: '' };

  /* ==========================================================
     STATISTIK DASHBOARD
  ========================================================== */
  function dashboardStats() {
    const books = SIPUS.Books.stats();
    const txs = S.getTransactions();
    const today = U.todayISO();
    let dipinjam = 0, terlambat = 0;
    txs.forEach(tx => {
      const d = T.derived(tx, today);
      dipinjam += d.sisa;
      if (d.status === 'terlambat') terlambat++;
    });
    return {
      judul: books.judul,
      eksemplar: books.eksemplar,
      tersedia: books.tersedia,
      anggota: S.getMembers().length,
      dipinjam: dipinjam,
      terlambat: terlambat,
      totalTransaksi: txs.length
    };
  }

  /** Buku paling sering dipinjam (berdasarkan total eksemplar dipinjam). */
  function topBooks(limit) {
    const counts = {};
    S.getTransactions().forEach(tx => {
      tx.items.forEach(it => { counts[it.bookId] = (counts[it.bookId] || 0) + (it.jumlah || 0); });
    });
    return Object.keys(counts).map(id => {
      const b = S.getBook(id);
      return { bookId: id, judul: b ? b.judul : id, jumlah: counts[id] };
    }).sort((a, b) => b.jumlah - a.jumlah).slice(0, limit || 5);
  }

  /* ==========================================================
     HALAMAN DASHBOARD
  ========================================================== */
  function renderDashboard() {
    const root = document.getElementById('page-dashboard');
    if (!root) return;
    const st = dashboardStats();
    const today = U.todayISO();

    const terbaru = S.getTransactions()
      .slice()
      .sort((a, b) => ((b.createdAt || b.tanggalPinjam) > (a.createdAt || a.tanggalPinjam) ? 1 : -1))
      .slice(0, 5);

    const members = {};
    S.getMembers().forEach(m => { members[m.id] = m; });

    root.innerHTML =
      '<div class="page-head"><div><h3>Dashboard</h3>' +
      '<p>Ringkasan aktivitas perpustakaan per ' + U.formatDate(today) + '.</p></div></div>' +

      '<div class="stats-grid">' +
        stat('📚', 'Total Judul Buku', st.judul, '') +
        stat('👥', 'Total Anggota', st.anggota, '') +
        stat('📖', 'Buku Sedang Dipinjam', st.dipinjam + ' eksemplar', 'warn') +
        stat('⏰', 'Peminjaman Terlambat', st.terlambat, st.terlambat > 0 ? 'danger' : 'ok') +
      '</div>' +

      '<div class="card">' +
        '<h4 class="card-title">Menu Utama</h4>' +
        '<div class="shortcut-grid">' +
          shortcut('books', '📚', 'Data Buku') +
          shortcut('members', '👥', 'Data Anggota') +
          shortcut('catalog', '📖', 'Katalog Buku') +
          shortcut('loans', '🔄', 'Peminjaman') +
          shortcut('returns', '↩️', 'Pengembalian') +
          shortcut('reports', '🧾', 'Laporan') +
          shortcut('settings', '⚙️', 'Pengaturan') +
          shortcut('logout', '🚪', 'Keluar') +
        '</div>' +
      '</div>' +

      '<div class="grid-2">' +
        '<div class="card">' +
          '<h4 class="card-title">Transaksi Terbaru</h4>' +
          '<div class="table-wrap"><table class="table">' +
            '<thead><tr><th>Kode</th><th>Anggota</th><th>Tgl Pinjam</th><th>Status</th><th>Denda</th></tr></thead>' +
            '<tbody>' +
            (terbaru.length ? terbaru.map(tx => {
              const d = T.derived(tx, today);
              const m = members[tx.memberId];
              return '<tr>' +
                '<td class="nowrap"><strong>' + esc(tx.kode) + '</strong></td>' +
                '<td>' + esc(m ? m.nama : tx.memberId) + '</td>' +
                '<td class="nowrap">' + U.formatDate(tx.tanggalPinjam) + '</td>' +
                '<td>' + T.statusBadge(tx) + '</td>' +
                '<td class="nowrap">' + (d.denda > 0 ? U.rupiah(d.denda) : '<span class="muted">-</span>') + '</td>' +
              '</tr>';
            }).join('') :
              '<tr><td class="empty" colspan="5">Belum ada transaksi. Muat data contoh di menu Pengaturan.</td></tr>') +
            '</tbody>' +
          '</table></div>' +
        '</div>' +

        '<div class="card">' +
          '<h4 class="card-title">Buku Paling Sering Dipinjam</h4>' +
          '<div class="table-wrap"><table class="table">' +
            '<thead><tr><th>#</th><th>Judul</th><th>Total Dipinjam</th></tr></thead>' +
            '<tbody>' +
            (topBooks(5).length ? topBooks(5).map((b, i) =>
              '<tr><td>' + (i + 1) + '</td><td>' + esc(b.judul) + '</td><td>' + b.jumlah + ' eksemplar</td></tr>'
            ).join('') :
              '<tr><td class="empty" colspan="3">Belum ada data peminjaman.</td></tr>') +
            '</tbody>' +
          '</table></div>' +
          '<p class="small muted" style="margin-top:10px;">Total ' + st.totalTransaksi + ' transaksi tercatat; ' +
            st.tersedia + ' dari ' + st.eksemplar + ' eksemplar tersedia.</p>' +
        '</div>' +
      '</div>';

    root.querySelectorAll('[data-go]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-go');
        if (target === 'logout') SIPUS.App.logout();
        else SIPUS.UI.goTo(target);
      });
    });
  }

  function stat(icon, label, value, kind) {
    return '<div class="stat-card">' +
      '<div class="stat-icon ' + (kind || '') + '">' + icon + '</div>' +
      '<div><div class="stat-value">' + value + '</div><div class="stat-label">' + esc(label) + '</div></div>' +
    '</div>';
  }

  function shortcut(page, icon, label) {
    return '<button class="shortcut" data-go="' + page + '"><span>' + icon + '</span>' + esc(label) + '</button>';
  }

  /* ==========================================================
     HALAMAN LAPORAN
  ========================================================== */
  /** Baris laporan: satu per transaksi, sesuai data transaksi sebenarnya. */
  function reportRows() {
    const members = {};
    S.getMembers().forEach(m => { members[m.id] = m; });
    return T.history({
      q: '', status: reportState.status,
      dari: reportState.dari, sampai: reportState.sampai
    }).map(tx => {
      const d = T.derived(tx);
      const m = members[tx.memberId];
      const judul = tx.items.map(it =>
        esc(it.judul || it.bookId) + ' <span class="muted small">(x' + it.jumlah + ')</span>').join('<br>');
      const tglKembali = tx.items.map(it =>
        (it.kembali && it.kembali.length) ? it.kembali.map(U.formatDate).join(', ') : null
      ).filter(Boolean);
      return {
        kode: esc(tx.kode),
        anggota: esc(m ? m.nama : tx.memberId) + ' <span class="small muted">(' + esc(tx.memberId) + ')</span>',
        judul: judul,
        pinjam: U.formatDate(tx.tanggalPinjam),
        jatuhTempo: U.formatDate(tx.jatuhTempo),
        kembali: tglKembali.length ? esc(tglKembali.join('; ')) : '-',
        status: T.statusBadge(tx),
        denda: d.denda > 0 ? U.rupiah(d.denda) : '-',
        dendaValue: d.denda,
        jumlahEksemplar: d.totalJumlah,
        selesai: d.selesai,
        pernahTelat: d.pernahTelat
      };
    });
  }

  function renderReports() {
    const root = document.getElementById('page-reports');
    if (!root) return;
    const rows = reportRows();

    const totalDenda = rows.reduce((n, r) => n + r.dendaValue, 0);
    const totalEksemplar = rows.reduce((n, r) => n + r.jumlahEksemplar, 0);
    const jumlahSelesai = rows.filter(r => r.selesai).length;
    const jumlahTelat = rows.filter(r => r.pernahTelat).length;

    root.innerHTML =
      '<div class=\"page-head\">' +
        '<div><h3>Laporan Perpustakaan</h3><p>Laporan peminjaman, pengembalian, keterlambatan, dan denda.</p></div>' +
        '<button class=\"btn no-print\" id=\"btn-print\">🖨️ Cetak Laporan</button>' +
      '</div>' +

      '<div class=\"card no-print\">' +
        '<div class=\"toolbar\">' +
          '<div class=\"field\"><label for=\"rep-from\">Dari Tanggal Pinjam</label><input type=\"date\" id=\"rep-from\" value=\"' + esc(reportState.dari) + '\"></div>' +
          '<div class=\"field\"><label for=\"rep-to\">Sampai Tanggal Pinjam</label><input type=\"date\" id=\"rep-to\" value=\"' + esc(reportState.sampai) + '\"></div>' +
          '<div class=\"field\"><label for=\"rep-status\">Status Transaksi</label>' +
            '<select id=\"rep-status\">' +
              '<option value=\"\">Semua status</option>' +
              '<option value=\"dipinjam\"' + (reportState.status === 'dipinjam' ? ' selected' : '') + '>Sedang Dipinjam</option>' +
              '<option value=\"terlambat\"' + (reportState.status === 'terlambat' ? ' selected' : '') + '>Terlambat</option>' +
              '<option value=\"selesai\"' + (reportState.status === 'selesai' ? ' selected' : '') + '>Selesai</option>' +
            '</select>' +
          '</div>' +
          '<button class=\"btn\" id=\"rep-apply\">Terapkan</button>' +
          '<button class=\"btn btn-outline\" id=\"rep-reset\">Reset</button>' +
        '</div>' +
      '</div>' +

      '<div class=\"print-header\">' +
        '<h2>SIPUS — Laporan Perpustakaan Kampus</h2>' +
        '<p>Periode: ' + (reportState.dari ? U.formatDate(reportState.dari) : 'semua') + ' s.d. ' +
          (reportState.sampai ? U.formatDate(reportState.sampai) : 'semua') +
          ' · Status: ' + (reportState.status || 'semua') +
          ' · Dicetak: ' + U.formatDate(U.todayISO()) + '</p>' +
      '</div>' +

      '<div class=\"stats-grid\">' +
        stat('🧾', 'Total Transaksi', rows.length, '') +
        stat('📦', 'Total Eksemplar Dipinjam', totalEksemplar, '') +
        stat('✅', 'Pengembalian Selesai', jumlahSelesai, 'ok') +
        stat('⚠️', 'Pernah Terlambat', jumlahTelat, 'danger') +
      '</div>' +

      '<div class=\"card\">' +
        '<h4 class=\"card-title\">Rincian Transaksi</h4>' +
        '<div class=\"table-wrap\"><table class=\"table\" id=\"report-table\">' +
          '<thead><tr>' +
            '<th>Kode Transaksi</th><th>Anggota</th><th>Judul Buku</th>' +
            '<th>Tgl Pinjam</th><th>Jatuh Tempo</th><th>Tgl Kembali</th>' +
            '<th>Status</th><th>Denda</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (rows.length ? rows.map(r =>
            '<tr>' +
              '<td class=\"nowrap\"><strong>' + r.kode + '</strong></td>' +
              '<td>' + r.anggota + '</td>' +
              '<td>' + r.judul + '</td>' +
              '<td class=\"nowrap\">' + r.pinjam + '</td>' +
              '<td class=\"nowrap\">' + r.jatuhTempo + '</td>' +
              '<td class=\"nowrap\">' + r.kembali + '</td>' +
              '<td>' + r.status + '</td>' +
              '<td class=\"nowrap\">' + r.denda + '</td>' +
            '</tr>').join('') :
            '<tr><td class=\"empty\" colspan=\"8\">Tidak ada transaksi pada filter yang dipilih.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
        '<p class=\"small muted\" style=\"margin-top:10px;\">Total denda pada filter ini: <strong>' + U.rupiah(totalDenda) + '</strong> ' +
          '(denda Rp' + S.FINE_PER_DAY + ' per eksemplar per hari keterlambatan).</p>' +
      '</div>' +

      '<div class=\"card\">' +
        '<h4 class=\"card-title\">Buku Paling Sering Dipinjam</h4>' +
        '<div class=\"table-wrap\"><table class=\"table\">' +
          '<thead><tr><th>#</th><th>Judul Buku</th><th>Kode</th><th>Total Eksemplar Dipinjam</th></tr></thead>' +
          '<tbody>' +
          (topBooks(10).length ? topBooks(10).map((b, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + esc(b.judul) + '</td><td class=\"nowrap\">' + esc(b.bookId) + '</td><td>' + b.jumlah + '</td></tr>'
          ).join('') :
            '<tr><td class=\"empty\" colspan=\"4\">Belum ada data peminjaman.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
      '</div>';

    root.querySelector('#btn-print').addEventListener('click', () => window.print());
    root.querySelector('#rep-apply').addEventListener('click', () => {
      reportState.dari = root.querySelector('#rep-from').value;
      reportState.sampai = root.querySelector('#rep-to').value;
      reportState.status = root.querySelector('#rep-status').value;
      if (reportState.dari && reportState.sampai && reportState.dari > reportState.sampai) {
        SIPUS.UI.notify('Rentang tanggal tidak valid: tanggal mulai setelah tanggal akhir.', 'error');
        return;
      }
      renderReports();
    });
    root.querySelector('#rep-reset').addEventListener('click', () => {
      reportState.dari = ''; reportState.sampai = ''; reportState.status = '';
      renderReports();
    });
  }

  SIPUS.Reports = { renderDashboard, renderReports, dashboardStats, topBooks };
})();
