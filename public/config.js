// Auto-detect: local pakai localhost:8080, produksi pakai domain sendiri
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:8080'
    : window.location.origin;
