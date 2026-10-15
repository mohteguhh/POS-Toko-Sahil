const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// Ambil nomor versi dari argumen atau default
const version = process.argv[2] || 'v1.0.1';
const outputName = `update-${version}.patch`;

console.log(`📦 Membuat file patch pembaruan: ${outputName}...`);

const zip = new AdmZip();

// File-file inti yang dibutuhkan aplikasi lengkap
const filesToInclude = [
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icon-192.svg',
  'icon-512.svg'
];

filesToInclude.forEach(file => {
  const fullPath = path.join(__dirname, file);
  if (fs.existsSync(fullPath)) {
    zip.addLocalFile(fullPath);
    console.log(`  + Menambahkan ${file}`);
  }
});

// Tambahkan folder lib/ lengkap beserta seluruh pustaka
const libPath = path.join(__dirname, 'lib');
if (fs.existsSync(libPath)) {
  zip.addLocalFolder(libPath, 'lib');
  console.log('  + Menambahkan folder lib/');
}

zip.writeZip(path.join(__dirname, outputName));
console.log(`\n✅ File patch berhasil dibuat: ${outputName}`);
console.log(`💡 Cara Penggunaan:`);
console.log(`- Kirim file ${outputName} ini via WA / Flashdisk ke toko yang 100% offline.`);
console.log(`- Atau upload ${outputName} ke GitHub Releases untuk pengguna yang terkoneksi online.`);
