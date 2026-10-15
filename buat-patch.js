const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// Ambil nomor versi dari argumen atau default
const version = process.argv[2] || 'v1.0.1';
const outputName = `update-${version}.patch`;

console.log(`📦 Membuat file patch pembaruan: ${outputName}...`);

const zip = new AdmZip();

// File-file inti yang sering diperbarui
const filesToInclude = [
  'index.html',
  'style.css',
  'app.js',
  'manifest.json'
];

filesToInclude.forEach(file => {
  const fullPath = path.join(__dirname, file);
  if (fs.existsSync(fullPath)) {
    zip.addLocalFile(fullPath);
    console.log(`  + Menambahkan ${file}`);
  }
});

// Tambahkan folder lib jika ada perubahan pustaka
if (fs.existsSync(path.join(__dirname, 'lib'))) {
  zip.addLocalFolder(path.join(__dirname, 'lib'), 'lib');
  console.log('  + Menambahkan folder lib/');
}

zip.writeZip(path.join(__dirname, outputName));
console.log(`\n✅ File patch berhasil dibuat: ${outputName}`);
console.log(`💡 Cara Penggunaan:`);
console.log(`- Kirim file ${outputName} ini via WA / Flashdisk ke toko yang 100% offline.`);
console.log(`- Atau upload ${outputName} ke GitHub Releases untuk pengguna yang terkoneksi online.`);
