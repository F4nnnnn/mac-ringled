# Mac Ringlight v18 — visual-order-aware System Monitor placement

Versi ini memperbaiki v17 berdasarkan struktur System Monitor v20 yang dikirim dari laptop.

Perbaikan:
- Penentuan grup network menggunakan koordinat layar aktual dari `_upGroup.box` dan `_downGroup.box`.
- Arah urutan child (`left-to-right` atau terbalik) diukur dari posisi aktor di layar; tidak lagi menganggap indeks child selalu berarti kiri-ke-kanan.
- Ringlight disisipkan di sisi yang secara visual berada tepat di sebelah kiri grup Network.
- Saat login, jika aktor belum memiliki alokasi layar, ekstensi menunggu dan mencoba lagi; tidak memakai fallback indeks yang bisa menempatkan ikon di antara CPU/RAM.
- Mekanisme kompensasi koordinat X dari v17 dan offset 3 px ke kiri dipertahankan untuk menahan perubahan lebar angka Network.
- Fitur Ringlight, dock overlay, dan Preferences tetap dipertahankan.

## Instalasi

```bash
UUID='mac-ringlight@satria.local'
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID"
unzip -oq ~/Downloads/mac-ringlight-fixed-next-to-network-v18.zip -d "$EXT"
glib-compile-schemas "$EXT/schemas"
gnome-extensions enable "$UUID"
```

Logout lalu login kembali. Target visual: ikon Ringlight berada di sebelah kiri metrik Network, bukan di antara CPU/RAM. Jika layout belum siap ketika ekstensi mulai dimuat, penempatan menunggu koordinat aktual alih-alih menebak.
