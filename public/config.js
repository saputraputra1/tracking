// Ubah SERVER_URL ke URL Railway setelah deploy
// Contoh: https://tracking-server.up.railway.app
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8080'
    : 'http://localhost:8080'; // GANTI: 'https://namaproject.up.railway.app'
