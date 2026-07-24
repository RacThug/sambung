/**
 * Bahasa Indonesia copy for the public funnel (ADR-0024). Typed as `Messages`, so
 * a key missing here (or a stray extra one) fails `tsc` - new copy cannot ship
 * EN-only. `{token}` placeholders must match `en.ts` exactly.
 */
import type { Messages } from "./en";

export const id: Messages = {
  "switcher.label": "Bahasa",

  "landing.navLogin": "Masuk",
  "landing.getStarted": "Mulai",
  "landing.heroTitle": "Pemesanan langsung tanpa komisi untuk penginapan di Bali.",
  "landing.heroBody":
    "Terima pembayaran langsung dan jaga setiap kalender OTA tetap sinkron lewat iCal - jadi kamar yang terjual di Airbnb tidak bisa terjual lagi di sini. Kanal pemesanan milik Anda sendiri, berjalan berdampingan dengan kanal yang sudah Anda pakai.",
  "landing.viewDemo": "Lihat demo langsung",
  "landing.hardTitle": "Lima bagian tersulit",
  "landing.hardBody":
    "Perangkat lunak pemesanan hidup atau mati pada segelintir kasus pelik. Beginilah cara Sambung menanganinya.",
  "landing.hard1Title": "Tidak pernah pesan ganda",
  "landing.hard1Body":
    "Exclusion constraint Postgres - bukan kode aplikasi - yang menentukan siapa memenangkan malam terakhir.",
  "landing.hard2Title": "Ketersediaan diturunkan",
  "landing.hard2Body":
    "Malam kosong dihitung dari pemesanan nyata, sehingga kalender tidak pernah menyimpang dari dirinya sendiri.",
  "landing.hard3Title": "Sinkronisasi iCal dua arah",
  "landing.hard3Body":
    "Kalender OTA tetap selaras, dan feed yang rusak tidak pernah membatalkan menginap nyata secara massal.",
  "landing.hard4Title": "Pembayaran idempoten",
  "landing.hard4Body":
    "Webhook pembayaran yang terkirim ulang tidak pernah bisa mengonfirmasi atau menagih sebuah pemesanan dua kali.",
  "landing.hard5Title": "Isolasi multi-tenant",
  "landing.hard5Body":
    "Data setiap pemilik terpisah di dalam basis data dengan row-level security.",
  "landing.stackTitle": "Dibangun dengan",
  "landing.forGuests":
    "Ingin memesan penginapan? Buka tautan pemesanan yang dikirim tuan rumah Anda.",
  "landing.footerTagline":
    "Mesin pemesanan langsung + pengelola kanal yang ringan.",

  "property.notFoundTitle": "Halaman ini tidak ada",
  "property.notFoundBody":
    "Tautannya mungkin salah ketik, atau properti sudah tidak terdaftar.",
  "property.errorTitle": "Terjadi kesalahan",
  "property.errorBody": "Kami tidak dapat memuat properti ini. Silakan coba lagi.",
  "property.metaNotFound": "Properti tidak ditemukan - Sambung",
  "property.rooms": "Kamar",
  "property.noRooms": "Belum ada kamar yang terdaftar. Silakan cek kembali nanti.",
  "property.verified": "Terverifikasi",
  "property.photoMain": "{name} - foto utama",
  "property.photoN": "{name} - foto {n}",

  "unit.capacity": "Hingga {guests}",
  "unit.minStayNote": "Minimal {nights}",
  "unit.perNight": "/ malam",
  "unit.priceOnRequest": "Harga sesuai permintaan",
  "unit.notBookable": "Belum dapat dipesan.",
  "unit.checkAvailability": "Cek ketersediaan",
  "unit.close": "Tutup",

  "picker.selectDates":
    "Pilih tanggal check-in dan check-out untuk melihat ketersediaan dan harga.",
  "picker.checkError": "Tidak dapat memeriksa tanggal tersebut. Silakan coba lagi.",
  "picker.retry": "Coba lagi",
  "picker.checking": "Memeriksa ketersediaan…",
  "picker.available": "Tersedia",
  "picker.book": "Pesan tanggal ini",
  "picker.notAvailable": "Tidak tersedia untuk tanggal ini",
  "picker.reasonMinStay": "Kamar ini memiliki masa inap minimum {nights}.",
  "picker.reasonOverlap": "Sebagian malam tersebut sudah dipesan.",
  "picker.bookedLabel": "Terpesan:",

  "checkout.title": "Ajukan pemesanan",
  "checkout.back": "← Kembali ke properti",
  "checkout.chooseDates":
    "Pilih tanggal Anda di halaman properti untuk memulai pemesanan.",
  "checkout.yourStay": "Menginap Anda",
  "checkout.depositDueNow": "Deposit dibayar sekarang: {amount}",
  "checkout.balanceAtProperty": "Sisa {amount} dibayar di properti",
  "checkout.pickOtherDates": "Pilih tanggal lain",
  "checkout.holdLapsedTitle": "Penahanan Anda telah berakhir",
  "checkout.holdLapsedBody":
    "Kami hanya menahan tanggal selama beberapa menit. Silakan pilih tanggal Anda lagi untuk memulai dari awal.",
  "checkout.pickDatesAgain": "Pilih tanggal lagi",
  "checkout.yourDetails": "Data Anda",
  "checkout.fullName": "Nama lengkap",
  "checkout.whatsapp": "Nomor WhatsApp",
  "checkout.country": "Negara",
  "checkout.loading": "Memuat…",
  "checkout.unavailable": "Tidak tersedia",
  "checkout.countryLoadFailed": "Kami tidak dapat memuat daftar negara.",
  "checkout.emailOptional": "Email (opsional)",
  "checkout.guests": "Tamu",
  "checkout.invalidPhone":
    "Masukkan nomor WhatsApp yang valid untuk negara yang dipilih",
  "checkout.genericError": "Terjadi kesalahan - silakan coba lagi.",
  "checkout.continueToPayment": "Lanjutkan ke pembayaran",
  "checkout.startingPayment": "Memulai pembayaran aman…",
  "checkout.heldTitle": "Tanggal Anda ditahan",
  "checkout.heldBodyPre":
    "Kami tidak dapat menghubungi penyedia pembayaran. Pemesanan Anda ditahan selama",
  "checkout.heldBodyPost": "- coba lagi pembayaran sebelum berakhir.",
  "checkout.paymentCouldntStart": "Pembayaran tidak dapat dimulai. Silakan coba lagi.",
  "checkout.retryPayment": "Coba lagi pembayaran",

  "conflict.overlap": "Tanggal tersebut baru saja dipesan. Silakan segarkan dan coba lagi.",
  "conflict.minStay": "Menginap tersebut lebih singkat dari minimum unit ini.",
  "conflict.maxGuests": "Jumlah tamu melebihi kapasitas unit ini.",
  "conflict.unavailable": "Unit ini tidak lagi tersedia untuk pemesanan baru.",
  "conflict.generic": "Tanggal tersebut tidak dapat dipesan.",

  "confirm.title": "Pemesanan Anda",
  "confirm.notFoundTitle": "Pemesanan tidak ditemukan",
  "confirm.notFoundBody":
    "Kami tidak dapat menemukan pemesanan ini. Periksa tautannya, atau hubungi tuan rumah Anda.",
  "confirm.errorTitle": "Terjadi kesalahan",
  "confirm.errorBody":
    "Kami tidak dapat memuat pemesanan Anda saat ini. Silakan coba lagi.",
  "confirm.allSet": "Anda sudah siap",
  "confirm.confirmedBody":
    "Pemesanan Anda telah dikonfirmasi. Salinannya sedang dikirim ke email Anda.",
  "confirm.stay": "Menginap",
  "confirm.checkIn": "Check-in",
  "confirm.checkOut": "Check-out",
  "confirm.paidOnline": "Dibayar online",
  "confirm.balanceAtProperty": "Sisa di properti",
  "confirm.sendWhatsapp": "Kirim konfirmasi WhatsApp",
  "confirm.pendingTitle": "Mengonfirmasi pembayaran Anda…",
  "confirm.pendingAria": "Mengonfirmasi pembayaran Anda",
  "confirm.pendingBody":
    "Ini bisa memakan waktu sejenak. Halaman ini diperbarui otomatis - tidak perlu menyegarkan.",
  "confirm.expiredTitle": "Penahanan Anda telah berakhir",
  "confirm.expiredBody":
    "Kami hanya menahan tanggal selama beberapa menit, dan penahanan ini telah berakhir. Tidak ada biaya yang dikenakan - silakan mulai pemesanan baru.",
  "confirm.cancelledTitle": "Pemesanan ini dibatalkan",
  "confirm.cancelledBody": "Jika menurut Anda ini keliru, hubungi tuan rumah Anda.",
  "confirm.backHome": "← Kembali ke beranda",

  "auth.signInSubtitle": "Masuk ke dasbor Anda",
  "auth.email": "Email",
  "auth.password": "Kata sandi",
  "auth.signingIn": "Masuk…",
  "auth.signIn": "Masuk",
  "auth.invalidCredentials": "Email atau kata sandi salah",
  "auth.genericError": "Terjadi kesalahan - silakan coba lagi",
  "auth.newToSambung": "Baru di Sambung?",
  "auth.createAccount": "Buat akun",
  "auth.registerSubtitle": "Buat akun pemilik Anda",
  "auth.businessName": "Nama bisnis",
  "auth.creatingAccount": "Membuat akun…",
  "auth.createAccountBtn": "Buat akun",
  "auth.emailTaken": "Email sudah terdaftar",
  "auth.alreadyHaveAccount": "Sudah punya akun?",
  "auth.signInLink": "Masuk",
};
