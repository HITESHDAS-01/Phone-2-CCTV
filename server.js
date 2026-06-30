const express = require('express');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const forge = require('node-forge');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PRODUCTION = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RENDER || process.env.HEROKU_APP_NAME);

// Get local IP address
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Generate self-signed SSL certificate (local development only)
function generateCertificate() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const attrs = [
        { name: 'commonName', value: 'Phone CCTV' },
        { name: 'organizationName', value: 'Phone CCTV Local' },
        { name: 'countryName', value: 'IN' }
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);

    const localIP = getLocalIP();
    cert.setExtensions([{
        name: 'subjectAltName',
        altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: localIP }
        ]
    }]);

    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
        key: forge.pki.privateKeyToPem(keys.privateKey),
        cert: forge.pki.certificateToPem(cert)
    };
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API: Get QR code data
app.get('/api/qr', async (req, res) => {
    let url;
    if (IS_PRODUCTION) {
        url = `https://${req.headers.host}/phone.html`;
    } else {
        url = `https://${getLocalIP()}:${PORT}/phone.html`;
    }
    try {
        const qr = await QRCode.toDataURL(url, { width: 256, margin: 2 });
        res.json({ url, qr });
    } catch (err) {
        res.status(500).json({ error: 'QR generation failed' });
    }
});

// API: Get server info
app.get('/api/info', (req, res) => {
    res.json({
        ip: getLocalIP(),
        port: PORT,
        production: IS_PRODUCTION,
        cameras: Array.from(cameras.values()).map(c => ({
            id: c.id,
            name: c.name,
            connected: c.connected
        }))
    });
});

// Store connected cameras
const cameras = new Map();
let cameraCounter = 0;

// Create server
let server;
if (IS_PRODUCTION) {
    server = http.createServer(app);
    console.log('[Server] Using HTTP (platform handles SSL)');
} else {
    const httpsOptions = generateCertificate();
    server = https.createServer(httpsOptions, app);
    console.log('[Server] Using HTTPS with self-signed certificate');
}

// Socket.IO signaling
const io = new Server(server, {
    cors: { origin: '*' }
});

io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    socket.on('camera:join', (data) => {
        cameraCounter++;
        const cameraId = data.cameraId || `CAM_${String(cameraCounter).padStart(2, '0')}`;
        const cameraName = data.name || cameraId;

        cameras.set(socket.id, {
            id: cameraId,
            name: cameraName,
            socketId: socket.id,
            connected: true
        });

        socket.cameraId = cameraId;
        console.log(`[Camera] ${cameraId} joined`);

        io.emit('camera:joined', {
            id: cameraId,
            name: cameraName,
            socketId: socket.id
        });
    });

    socket.on('camera:offer', (data) => {
        console.log(`[Signal] Offer from ${socket.cameraId}`);
        socket.broadcast.emit('camera:offer', {
            offer: data.offer,
            cameraId: socket.cameraId,
            socketId: socket.id
        });
    });

    socket.on('camera:answer', (data) => {
        console.log(`[Signal] Answer to ${data.targetSocketId}`);
        io.to(data.targetSocketId).emit('camera:answer', {
            answer: data.answer,
            socketId: socket.id
        });
    });

    socket.on('camera:offer-request', (data) => {
        console.log(`[Signal] Offer request to ${data.targetSocketId}`);
        io.to(data.targetSocketId).emit('camera:offer-request', {
            dashboardSocketId: socket.id
        });
    });

    socket.on('camera:ice-candidate', (data) => {
        io.to(data.targetSocketId).emit('camera:ice-candidate', {
            candidate: data.candidate,
            socketId: socket.id
        });
    });

    socket.on('disconnect', () => {
        if (socket.cameraId) {
            cameras.delete(socket.id);
            console.log(`[Camera] ${socket.cameraId} disconnected`);
            io.emit('camera:left', { id: socket.cameraId });
        }
    });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log('\n========================================');
    console.log('  Phone CCTV Server Started!');
    console.log('========================================');
    if (IS_PRODUCTION) {
        console.log('  Mode: PRODUCTION');
        console.log(`  URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app.up.railway.app'}`);
    } else {
        console.log('  Mode: LOCAL');
        console.log(`  Dashboard: https://${localIP}:${PORT}/dashboard.html`);
        console.log(`  Phone:     https://${localIP}:${PORT}/phone.html`);
        console.log(`  Local:     https://localhost:${PORT}/dashboard.html`);
    }
    console.log('========================================\n');
});
