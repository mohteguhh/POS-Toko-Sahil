const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

console.log('📦 Membuat paket patch update offline...');

const zip = new AdmZip();

// File dan folder penting yang perlu dimasukkan ke dalam patch
const filesToInclude = [
  'version.json',
  'index.html',
  'app.js',
  'style.css',
  'manifest.json',
  'sw.js',
  'app-icon.ico',
  'default-product.jpg',
  'portal.html',
  'price-checker.html'
];

const foldersToInclude = [
  'lib',
  'assets'
];

// Tambahkan file individual
filesToInclude.forEach(file => {
  if (fs.existsSync(file)) {
    zip.addLocalFile(file);
    console.log(`  ✓ Menambahkan file: ${file}`);
  }
});

// Tambahkan folder secara rekursif
foldersToInclude.forEach(folder => {
  if (fs.existsSync(folder)) {
    zip.addLocalFolder(folder, folder);
    console.log(`  ✓ Menambahkan folder: ${folder}/`);
  }
});

// Ambil versi dari version.json atau argumen terminal jika ada (contoh: node make-patch.js v1.0.2)
let versionTag = '';
let versionData = {};
try {
  if (fs.existsSync('version.json')) {
    versionData = JSON.parse(fs.readFileSync('version.json', 'utf8'));
    versionTag = versionData.version || '';
  }
} catch (e) {}

// Cek jika pengguna memasukkan argumen versi di terminal
const argVer = process.argv[2];
if (argVer) {
  versionTag = argVer.replace(/^v/i, '');
  versionData.version = versionTag;
  versionData.releaseName = `v${versionTag}`;
  versionData.releasedAt = new Date().toISOString().split('T')[0];
  fs.writeFileSync('version.json', JSON.stringify(versionData, null, 2), 'utf8');
  console.log(`  ✓ Versi diperbarui ke: v${versionTag}`);
}

const finalReleaseTag = versionTag ? `v${versionTag}` : 'v1.0.1';
const outputReleaseFileName = `patch_${finalReleaseTag}.zip`;

zip.writeZip(outputReleaseFileName);

// Salin juga sebagai patch_latest.zip agar mudah digunakan
zip.writeZip('patch_latest.zip');

console.log('\n🎉 BERHASIL!');
console.log(`File patch telah dibuat:`);
console.log(` 1. ${outputReleaseFileName} (Sesuai Rilis GitHub: ${finalReleaseTag})`);
console.log(` 2. patch_latest.zip`);
console.log('\nKirim file tersebut ke klien, lalu klien cukup memilih file ini via menu Pengaturan -> Pilih File Update.');
