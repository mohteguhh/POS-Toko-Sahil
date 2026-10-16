@echo off
title GENERATOR KUNCI AKTIVASI KASIR POS SAHIL
color 0A
mode con: cols=65 lines=22

:MENU
cls
echo =================================================================
echo        KUNCI AKTIVASI RESMI - KASIR TOKO SAHIL (DEVELOPER)
echo =================================================================
echo.
echo Masukkan Hardware ID yang dikirim oleh pembeli.
echo (Klik kanan untuk Paste / Tempel di jendela ini)
echo.
set /p HWID=">> Hardware ID Pembeli: "

if "%HWID%"=="" (
    echo.
    echo [!] Hardware ID tidak boleh kosong!
    timeout /t 2 >nul
    goto MENU
)

echo.
node generate-key.js %HWID%

echo.
echo =================================================================
echo Tekan tombol apapun untuk membuat Kunci Aktivasi untuk toko lain...
pause >nul
goto MENU
