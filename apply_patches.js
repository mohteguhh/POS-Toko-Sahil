const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// 1. Tambah tombol Hapus Produk Terpilih
const oldBulkBtn = `<button class="btn btn-secondary btn-sm" id="btn-bulk-print-labels" onclick="openBulkPrintLabelModal()" style="display: none; background-color: #ea580c; border-color: #ea580c; color: white;">
                  <svg viewBox="0 0 24 24" class="icon-sm"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
                  <span>Cetak Label Massal (<span id="bulk-select-count">0</span>)</span>
                </button>`;

const newBulkBtn = `<button class="btn btn-secondary btn-sm" id="btn-bulk-print-labels" onclick="openBulkPrintLabelModal()" style="display: none; background-color: #ea580c; border-color: #ea580c; color: white;">
                  <svg viewBox="0 0 24 24" class="icon-sm"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2m-10 0v4h8v-4"/></svg>
                  <span>Cetak Label Massal (<span id="bulk-select-count">0</span>)</span>
                </button>
                <button class="btn btn-danger btn-sm" id="btn-bulk-delete-products" onclick="deleteSelectedProducts()" style="display: none; background-color: #dc2626; border-color: #dc2626; color: white; align-items: center; gap: 0.35rem;" title="Hapus semua produk yang dicentang">
                  <svg viewBox="0 0 24 24" class="icon-sm" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  <span>Hapus Produk Terpilih (<span id="bulk-delete-count">0</span>)</span>
                </button>`;

if (html.includes(oldBulkBtn)) {
  html = html.replace(oldBulkBtn, newBulkBtn);
  console.log('Bulk delete button restored');
} else {
  console.log('oldBulkBtn not found!');
}

// 2. Cek checkbox master tabel produk
if (!html.includes('id="select-all-products"')) {
  const targetHeader = `<th style="width: 40px; text-align: center; padding: 0.5rem;"><input type="checkbox" id="select-all-products" onclick="toggleSelectAllProducts(this)" style="cursor: pointer; transform: scale(1.15);"></th>`;
  const oldHeader = `<th>Pilih</th>`;
  if (html.includes(oldHeader)) {
    html = html.replace(oldHeader, targetHeader);
    console.log('select-all-products header restored from oldHeader');
  } else {
    // Cari table head produk
    const oldThead = `<th>Gambar</th>`;
    if (html.includes(oldThead)) {
      html = html.replace(oldThead, `${targetHeader}\n                    <th>Gambar</th>`);
      console.log('select-all-products header prepended before Gambar');
    }
  }
}

// 3. Tambah dropdown / filter spesifik nama voucher pada halaman Anggota
// Tempatkan tepat setelah filter kategori voucher di voucher-filter-tabs-container
const oldCatSelect = `<select id="voucher-filter-category-select" class="form-control" style="font-size: 0.82rem; font-weight: 700; padding: 0.35rem 0.65rem; border-radius: 8px; width: auto; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--text-main);" onchange="renderCustomersTable()">
                      <option value="All">-- Semua Kategori --</option>
                    </select>`;

const newCatAndVoucherSelect = `<select id="voucher-filter-category-select" class="form-control" style="font-size: 0.82rem; font-weight: 700; padding: 0.35rem 0.65rem; border-radius: 8px; width: auto; border: 1px solid var(--border-color); background: var(--bg-surface); color: var(--text-main);" onchange="onVoucherCategoryFilterChange()">
                      <option value="All">-- Semua Kategori --</option>
                    </select>

                    <!-- Filter Spesifik Nama Voucher (e.g. Voucher Ramadhan) -->
                    <select id="voucher-filter-name-select" class="form-control" style="font-size: 0.82rem; font-weight: 700; padding: 0.35rem 0.65rem; border-radius: 8px; width: auto; border: 1.5px solid #ea580c; background: #fff; color: #ea580c;" onchange="renderCustomersTable()" title="Pilih Nama Voucher Spesifik (Misal: Voucher Ramadhan)">
                      <option value="All">-- Semua Nama Voucher --</option>
                    </select>`;

if (html.includes(oldCatSelect)) {
  html = html.replace(oldCatSelect, newCatAndVoucherSelect);
  console.log('Voucher name filter select added to index.html');
} else {
  console.log('oldCatSelect not found!');
}

// 4. Modal Daftar Penerima Voucher Spesifik (Siapa yang sudah klaim vs belum klaim)
const voucherSummaryModal = `
  <!-- MODAL: DAFTAR DETAIL STATUS KLAIM VOUCHER SPESIFIK -->
  <div class="modal-overlay" id="voucher-claim-detail-modal" style="z-index: 100060;">
    <div class="modal-card" style="max-width: 750px; width: 95%; max-height: 90vh; display: flex; flex-direction: column; border-radius: 20px; overflow: hidden; background: var(--bg-surface); box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);">
      <div style="padding: 1.25rem 1.5rem; background: linear-gradient(135deg, #ea580c, #c2410c); color: #fff; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h3 id="voucher-claim-modal-title" style="margin: 0; font-size: 1.15rem; font-weight: 800; display: flex; align-items: center; gap: 0.5rem;">
            🎫 Status Klaim: <span id="voucher-claim-modal-vname">Voucher Ramadhan</span>
          </h3>
          <p id="voucher-claim-modal-subtitle" style="margin: 0.25rem 0 0 0; font-size: 0.8rem; opacity: 0.9;">
            Daftar lengkap anggota yang berhak, siapa saja yang sudah klaim & belum klaim.
          </p>
        </div>
        <button type="button" onclick="closeVoucherClaimDetailModal()" style="background: rgba(255,255,255,0.2); border: none; font-size: 1.3rem; color: #fff; border-radius: 50%; width: 34px; height: 34px; cursor: pointer; display: flex; align-items: center; justify-content: center;">&times;</button>
      </div>

      <!-- Quick KPI Counters -->
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; padding: 1rem 1.5rem; background: var(--bg-body); border-bottom: 1px solid var(--border-color);">
        <div style="background: var(--bg-surface); padding: 0.65rem 1rem; border-radius: 10px; border: 1px solid var(--border-color); text-align: center;">
          <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">Total Penerima</div>
          <div id="vclaim-stat-total" style="font-size: 1.35rem; font-weight: 900; color: #ea580c; margin-top: 2px;">0</div>
        </div>
        <div style="background: #ecfdf5; padding: 0.65rem 1rem; border-radius: 10px; border: 1px solid #a7f3d0; text-align: center;">
          <div style="font-size: 0.75rem; font-weight: 700; color: #047857; text-transform: uppercase;">Sudah Klaim (Ambil)</div>
          <div id="vclaim-stat-used" style="font-size: 1.35rem; font-weight: 900; color: #059669; margin-top: 2px;">0</div>
        </div>
        <div style="background: #fff7ed; padding: 0.65rem 1rem; border-radius: 10px; border: 1px solid #fed7aa; text-align: center;">
          <div style="font-size: 0.75rem; font-weight: 700; color: #c2410c; text-transform: uppercase;">Belum Klaim</div>
          <div id="vclaim-stat-unused" style="font-size: 1.35rem; font-weight: 900; color: #ea580c; margin-top: 2px;">0</div>
        </div>
      </div>

      <!-- Tabs Filter & Search in Modal -->
      <div style="padding: 0.85rem 1.5rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.65rem; border-bottom: 1px solid var(--border-color);">
        <div style="display: flex; gap: 0.35rem;">
          <button type="button" id="btn-vclaim-all" onclick="filterVoucherClaimModalTab('all')" style="border-radius: 20px; font-weight: 700; font-size: 0.78rem; padding: 0.3rem 0.8rem; background: #ea580c; color: #fff; border: none; cursor: pointer;">Semua</button>
          <button type="button" id="btn-vclaim-used" onclick="filterVoucherClaimModalTab('used')" style="border-radius: 20px; font-weight: 700; font-size: 0.78rem; padding: 0.3rem 0.8rem; background: var(--bg-body); color: var(--text-muted); border: 1px solid var(--border-color); cursor: pointer;">Sudah Klaim</button>
          <button type="button" id="btn-vclaim-unused" onclick="filterVoucherClaimModalTab('unused')" style="border-radius: 20px; font-weight: 700; font-size: 0.78rem; padding: 0.3rem 0.8rem; background: var(--bg-body); color: var(--text-muted); border: 1px solid var(--border-color); cursor: pointer;">Belum Klaim</button>
        </div>
        <input type="text" id="vclaim-modal-search" placeholder="Cari nama anggota..." oninput="renderVoucherClaimModalList()" style="padding: 0.35rem 0.75rem; border-radius: 20px; border: 1px solid var(--border-color); font-size: 0.82rem; width: 200px;">
      </div>

      <!-- Table Body -->
      <div style="flex: 1; overflow-y: auto; padding: 0 1.5rem;">
        <table class="data-table" style="width: 100%; border-collapse: collapse; margin-top: 0.5rem;">
          <thead>
            <tr style="background: var(--bg-body); position: sticky; top: 0; z-index: 5;">
              <th style="padding: 0.6rem; text-align: left; font-size: 0.8rem;">No</th>
              <th style="padding: 0.6rem; text-align: left; font-size: 0.8rem;">Nama Anggota</th>
              <th style="padding: 0.6rem; text-align: left; font-size: 0.8rem;">Instansi / Domisili</th>
              <th style="padding: 0.6rem; text-align: right; font-size: 0.8rem;">Nominal</th>
              <th style="padding: 0.6rem; text-align: center; font-size: 0.8rem;">Status Klaim</th>
              <th style="padding: 0.6rem; text-align: left; font-size: 0.8rem;">Waktu Klaim</th>
            </tr>
          </thead>
          <tbody id="voucher-claim-modal-tbody">
            <!-- Diisi dinamis via JS -->
          </tbody>
        </table>
      </div>

      <!-- Modal Footer -->
      <div style="padding: 1rem 1.5rem; background: var(--bg-body); border-top: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
        <button type="button" class="btn btn-secondary btn-sm" onclick="exportVoucherClaimReportToJPG()" style="display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 700; background: #0284c7; color: #fff; border: none;">
          🖼️ Simpan Laporan Klaim JPG
        </button>
        <button type="button" class="btn btn-secondary" onclick="closeVoucherClaimDetailModal()">Tutup</button>
      </div>
    </div>
  </div>
`;

if (!html.includes('id="voucher-claim-detail-modal"')) {
  // Sisipkan sebelum penutup body
  html = html.replace('</body>', `${voucherSummaryModal}\n</body>`);
  console.log('voucher-claim-detail-modal inserted before body close');
}

// 5. Tambah tombol Akses Cepat Cek Status Voucher Spesifik di toolbar Anggota
const oldBulkIdCardBtn = `<button type="button" class="btn btn-sm" onclick="openBulkIdCardModal()"`;
const newStatusVoucherBtn = `<button type="button" class="btn btn-sm" onclick="openVoucherClaimDetailModal()" title="Cek siapa saja yang sudah / belum klaim voucher tertentu (misal: Voucher Ramadhan)" style="background: linear-gradient(135deg, #059669 0%, #10b981 100%); color: #fff; border: none; font-weight: 800; font-size: 0.82rem; padding: 0.5rem 0.95rem; border-radius: 50px; cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; box-shadow: 0 2px 6px rgba(16,185,129,0.25);">
                  <i data-lucide="award" style="width: 15px; height: 15px;"></i>
                  <span>🎯 Cek Status Klaim Voucher</span>
                </button>\n                ${oldBulkIdCardBtn}`;

if (html.includes(oldBulkIdCardBtn) && !html.includes('openVoucherClaimDetailModal()')) {
  html = html.replace(oldBulkIdCardBtn, newStatusVoucherBtn);
  console.log('Cek Status Klaim Voucher button added to member toolbar');
}

fs.writeFileSync('index.html', html, 'utf8');
console.log('index.html saved successfully');
