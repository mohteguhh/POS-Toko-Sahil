const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

console.log('📦 Membuat paket patch update offline...');

const zip = new AdmZip();

// File dan folder penting yang perlu dimasukkan ke dalam patch
const filesToInclude = [
  'index.html',
  'app.js',
  'style.css',
  'manifest.json',
  'sw.js',
  'app-icon.ico',
  'app-icon.png'
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

// Format tanggal untuk penamaan file
const now = new Date();
const pad = n => String(n).padStart(2, '0');
const dateStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
const outputFileName = `patch_update_${dateStamp}.zip`;

zip.writeZip(outputFileName);

// Salin juga sebagai patch_latest.zip agar mudah digunakan
zip.writeZip('patch_latest.zip');

console.log('\n🎉 BERHASIL!');
console.log(`File patch telah dibuat:`);
console.log(` 1. ${outputFileName}`);
console.log(` 2. patch_latest.zip`);
console.log('\nKirim file tersebut ke klien, lalu klien cukup memilih file ini via menu Pengaturan -> Pilih File Update.');
