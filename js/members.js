/* ============================================================
   js/members.js — SIPUS
   Manajemen anggota: tambah, ubah, hapus, detail, pencarian
   (nama, NIM, ID anggota), dan validasi ID/NIM ganda.
============================================================ */
(function () {
  'use strict';

  const S = SIPUS.Storage, U = SIPUS.Util;
  const esc = U.esc;

  const state = { q: '' };

  /** Jumlah eksemplar yang belum dikembalikan oleh anggota. */
  function activeLoanCount(memberId) {
    let n = 0;
    S.getTransactions().forEach(tx => {
      if (tx.memberId !== memberId) return;
      tx.items.forEach(it => {
        n += Math.max(0, (it.jumlah || 0) - (it.kembali ? it.kembali.length : 0));
      });
    });
    return n;
  }

  /* ==========================================================
     VALIDASI & CRUD
  ========================================================== */
  function validate(input, editingId) {
    const errors = [];
    const id = String(input.id || '').trim().toUpperCase();
    const nama = String(input.nama || '').trim();
    const nim = String(input.nim || '').trim();

    if (!id) errors.push('ID anggota wajib diisi.');
    else if (!/^[A-Z0-9-]+$/.test(id)) errors.push('ID anggota hanya boleh huruf, angka, dan tanda hubung.');
    else if (S.getMembers().some(m => m.id === id && m.id !== editingId)) errors.push('ID anggota "' + id + '" sudah digunakan.');

    if (!nama) errors.push('Nama lengkap wajib diisi.');
    if (!nim) errors.push('NIM wajib diisi.');
    else if (S.getMembers().some(m => m.nim === nim && m.id !== editingId)) errors.push('NIM "' + nim + '" sudah terdaftar.');

    if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) errors.push('Format email tidak valid.');
    if (input.telepon && !/^[0-9+\-\s()]{6,20}$/.test(input.telepon)) errors.push('Nomor telepon tidak valid.');
    return errors;
  }

  function createMember(input) {
    SIPUS.Auth.requireRole('petugas');
    const errors = validate(input, null);
    if (errors.length) throw new Error(errors.join(' '));
    const members = S.getMembers();
    const now = new Date().toISOString();
    members.push({
      id: String(input.id).trim().toUpperCase(),
      nama: String(input.nama).trim(),
      nim: String(input.nim).trim(),
      prodi: String(input.prodi || '').trim(),
      telepon: String(input.telepon || '').trim(),
      email: String(input.email || '').trim(),
      createdAt: now,
      updatedAt: now
    });
    S.saveMembers(members);
    return members[members.length - 1];
  }

  function updateMember(id, input) {
    SIPUS.Auth.requireRole('petugas');
    const errors = validate(input, id);
    if (errors.length) throw new Error(errors.join(' '));
    const members = S.getMembers();
    const member = members.find(m => m.id === id);
    if (!member) throw new Error('Anggota tidak ditemukan.');
    Object.assign(member, {
      nama: String(input.nama).trim(),
      nim: String(input.nim).trim(),
      prodi: String(input.prodi || '').trim(),
      telepon: String(input.telepon || '').trim(),
      email: String(input.email || '').trim(),
      updatedAt: new Date().toISOString()
    });
    S.saveMembers(members);
    return member;
  }

  function deleteMember(id) {
    SIPUS.Auth.requireRole('petugas');
    const aktif = activeLoanCount(id);
    if (aktif > 0) {
      throw new Error('Anggota masih memiliki peminjaman aktif (' + aktif + ' eksemplar) dan tidak dapat dihapus.');
    }
    S.saveMembers(S.getMembers().filter(m => m.id !== id));
    return true;
  }

  /* ==========================================================
     PENCARIAN
  ========================================================== */
  function filtered() {
    const q = U.norm(state.q);
    return S.getMembers().filter(m =>
      !q || U.norm(m.nama).includes(q) || U.norm(m.nim).includes(q) || U.norm(m.id).includes(q));
  }

  /* ==========================================================
     TAMPILAN
  ========================================================== */
  function render() {
    const root = document.getElementById('page-members');
    if (!root) return;
    const members = S.getMembers();
    const rows = filtered();
    let totalAktif = 0, denganPinjaman = 0;
    members.forEach(m => {
      const n = activeLoanCount(m.id);
      totalAktif += n;
      if (n > 0) denganPinjaman++;
    });

    root.innerHTML =
      '<div class="page-head">' +
        '<div><h3>Data Anggota</h3><p>Kelola data mahasiswa peminjam perpustakaan.</p></div>' +
        '<button class="btn" id="btn-add-member">＋ Tambah Anggota</button>' +
      '</div>' +

      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-icon">👥</div><div><div class="stat-value">' + members.length + '</div><div class="stat-label">Total Anggota</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon warn">📖</div><div><div class="stat-value">' + totalAktif + '</div><div class="stat-label">Eksemplar Sedang Dipinjam</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon ok">🔄</div><div><div class="stat-value">' + denganPinjaman + '</div><div class="stat-label">Anggota Sedang Meminjam</div></div></div>' +
        '<div class="stat-card"><div class="stat-icon">🎓</div><div><div class="stat-value">' + new Set(members.map(m => m.prodi)).size + '</div><div class="stat-label">Program Studi</div></div></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="toolbar no-print">' +
          '<div class="field grow">' +
            '<label for="member-search">Pencarian</label>' +
            '<input type="search" id="member-search" placeholder="Cari nama, NIM, atau ID anggota..." value="' + esc(state.q) + '">' +
          '</div>' +
          '<button class="btn btn-outline" id="member-reset">Reset</button>' +
        '</div>' +
        '<div class="table-wrap"><table class="table">' +
          '<thead><tr>' +
            '<th>ID Anggota</th><th>Nama Lengkap</th><th>NIM</th><th>Program Studi</th>' +
            '<th>Telepon</th><th>Email</th><th>Pinjam Aktif</th><th class="no-print">Aksi</th>' +
          '</tr></thead>' +
          '<tbody>' +
          (rows.length ? rows.map(m => {
            const aktif = activeLoanCount(m.id);
            return '<tr>' +
              '<td class="nowrap"><strong>' + esc(m.id) + '</strong></td>' +
              '<td>' + esc(m.nama) + '</td>' +
              '<td class="nowrap">' + esc(m.nim) + '</td>' +
              '<td>' + esc(m.prodi || '-') + '</td>' +
              '<td class="nowrap">' + esc(m.telepon || '-') + '</td>' +
              '<td>' + esc(m.email || '-') + '</td>' +
              '<td>' + (aktif > 0 ? '<span class="badge badge-dipinjam">' + aktif + ' eksemplar</span>' : '<span class="muted small">—</span>') + '</td>' +
              '<td class="actions no-print">' +
                '<button class="btn btn-sm btn-outline" data-action="view" data-id="' + esc(m.id) + '">Lihat</button> ' +
                '<button class="btn btn-sm btn-outline" data-action="edit" data-id="' + esc(m.id) + '">Ubah</button> ' +
                '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + esc(m.id) + '">Hapus</button>' +
              '</td>' +
            '</tr>';
          }).join('') :
            '<tr><td class="empty" colspan="8">Tidak ada anggota yang cocok dengan pencarian.</td></tr>') +
          '</tbody>' +
        '</table></div>' +
        '<p class="small muted" style="margin-top:10px;">Menampilkan ' + rows.length + ' dari ' + members.length + ' anggota.</p>' +
      '</div>';

    root.querySelector('#btn-add-member').addEventListener('click', () => openForm(null));
    const search = root.querySelector('#member-search');
    search.addEventListener('input', () => {
      state.q = search.value;
      render();
      const s = root.querySelector('#member-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    });
    root.querySelector('#member-reset').addEventListener('click', () => { state.q = ''; render(); });
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

  function openForm(id) {
    const m = id ? S.getMember(id) : null;
    const body =
      '<div class="form-error hidden" id="member-form-error"></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>ID Anggota *</label>' +
          '<input id="m-id" value="' + esc(m ? m.id : '') + '" placeholder="mis. AG006"' + (m ? ' readonly' : '') + '>' +
          (m ? '<p class="hint">ID anggota tidak dapat diubah.</p>' : '<p class="hint">Harus unik, mis. AG006.</p>') +
        '</div>' +
        '<div class="form-group"><label>NIM *</label><input id="m-nim" value="' + esc(m ? m.nim : '') + '" placeholder="mis. 2110512006"></div>' +
      '</div>' +
      '<div class="form-group"><label>Nama Lengkap *</label><input id="m-nama" value="' + esc(m ? m.nama : '') + '"></div>' +
      '<div class="form-group"><label>Program Studi</label><input id="m-prodi" value="' + esc(m ? m.prodi : '') + '" placeholder="mis. Teknik Informatika"></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>Nomor Telepon</label><input id="m-telepon" value="' + esc(m ? m.telepon : '') + '" placeholder="mis. 081234567890"></div>' +
        '<div class="form-group"><label>Email</label><input id="m-email" type="email" value="' + esc(m ? m.email : '') + '" placeholder="nama@mahasiswa.ac.id"></div>' +
      '</div>';

    SIPUS.UI.openModal({
      title: m ? 'Ubah Anggota' : 'Tambah Anggota',
      body: body,
      submitLabel: m ? 'Simpan Perubahan' : 'Tambah',
      onSubmit: () => {
        const input = {
          id: (document.getElementById('m-id').value || '').trim().toUpperCase(),
          nama: document.getElementById('m-nama').value,
          nim: document.getElementById('m-nim').value,
          prodi: document.getElementById('m-prodi').value,
          telepon: document.getElementById('m-telepon').value,
          email: document.getElementById('m-email').value
        };
        try {
          if (m) updateMember(m.id, input);
          else createMember(input);
          SIPUS.UI.notify(m ? 'Data anggota berhasil diperbarui.' : 'Anggota berhasil ditambahkan.', 'success');
          SIPUS.App.refreshPage();
          return true;
        } catch (e) {
          SIPUS.UI.showFormError('member-form-error', e.message);
          return false;
        }
      }
    });
  }

  function openDetail(id) {
    const m = S.getMember(id);
    if (!m) return;
    const aktif = activeLoanCount(m.id);
    const riwayat = S.getTransactions().filter(t => t.memberId === m.id);
    const body =
      '<div class="detail-grid">' +
        item('ID Anggota', m.id) +
        item('Nama Lengkap', m.nama) +
        item('NIM', m.nim) +
        item('Program Studi', m.prodi || '-') +
        item('Nomor Telepon', m.telepon || '-') +
        item('Email', m.email || '-') +
        item('Peminjaman Aktif', aktif + ' eksemplar') +
        item('Total Riwayat Transaksi', riwayat.length + ' transaksi') +
      '</div>';
    SIPUS.UI.openModal({ title: 'Detail Anggota', body: body, submitLabel: null });
  }

  function item(k, v) {
    return '<div class="detail-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>';
  }

  function confirmDelete(id) {
    const m = S.getMember(id);
    if (!m) return;
    SIPUS.UI.confirmDialog('Hapus anggota "' + m.nama + '" (' + m.id + ')? Tindakan ini tidak dapat dibatalkan.').then(ok => {
      if (!ok) return;
      try {
        deleteMember(id);
        SIPUS.UI.notify('Anggota berhasil dihapus.', 'success');
        SIPUS.App.refreshPage();
      } catch (e) {
        SIPUS.UI.notify(e.message, 'error');
      }
    });
  }

  SIPUS.Members = { render, activeLoanCount, createMember, updateMember, deleteMember, validate };
})();
