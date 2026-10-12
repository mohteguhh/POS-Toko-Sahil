const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log("Menyiapkan konversi video...");
const downloadsDir = path.join(process.env.USERPROFILE, 'Downloads');
const files = fs.readdirSync(downloadsDir);
const webmFile = files.filter(f => (f.includes('video-iklan-toko-sahil') || f.includes('video-iklan-kasirkilat')) && f.endsWith('.webm'))
                      .map(f => ({ name: f, time: fs.statSync(path.join(downloadsDir, f)).mtime.getTime() }))
                      .sort((a, b) => b.time - a.time)[0];

if (webmFile) {
  const inputPath = path.join(downloadsDir, webmFile.name);
  const outputPath = path.join(__dirname, 'video_iklan_toko_sahil_fb_ads.mp4');
  console.log(`Menemukan rekaman: ${inputPath}`);
  console.log(`Mengonversi ke MP4 H.264...`);
  execSync(`ffmpeg -y -i "${inputPath}" -c:v libx264 -pix_fmt yuv420p -preset fast -crf 22 "${outputPath}"`, { stdio: 'inherit' });
  console.log(`✅ BERHASIL! File MP4 tersimpan di: ${outputPath}`);
} else {
  console.log("Belum ada file webm unduhan di folder Downloads. Silakan klik tombol '🔴 Render & Download Video' di browser terlebih dahulu.");
}
