// Dashboard - WebRTC Receiver + Recording
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const socket = io({
    secure: isLocal ? false : true,
    rejectUnauthorized: false,
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000
});

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turns:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

// State
const peerConnections = new Map();  // socketId -> RTCPeerConnection
const cameraStreams = new Map();     // cameraId -> { stream, socketId, name }
const recorders = new Map();        // cameraId -> MediaRecorder
const recordedChunks = new Map();   // cameraId -> []

// DOM Elements
const cameraGrid = document.getElementById('camera-grid');
const emptyState = document.getElementById('empty-state');
const cameraCount = document.getElementById('camera-count');
const btnShowQR = document.getElementById('btn-show-qr');
const btnRecordAll = document.getElementById('btn-record-all');
const btnPlayback = document.getElementById('btn-playback');
const btnClosePlayback = document.getElementById('btn-close-playback');
const qrModal = document.getElementById('qr-modal');
const qrImage = document.getElementById('qr-image');
const qrUrl = document.getElementById('qr-url');
const closeModal = document.querySelector('.close-modal');
const playbackPanel = document.getElementById('playback-panel');
const recordingsList = document.getElementById('recordings-list');
const playbackVideo = document.getElementById('playback-video');

// Create camera card in grid
function createCameraCard(cameraId, name) {
    const card = document.createElement('div');
    card.className = 'camera-card';
    card.id = `camera-${cameraId}`;
    card.innerHTML = `
        <div class="camera-header">
            <span class="camera-name">${name || cameraId}</span>
            <span class="camera-status online">ONLINE</span>
        </div>
        <video id="video-${cameraId}" autoplay playsinline class="camera-video"></video>
        <div class="camera-controls">
            <button class="btn btn-small btn-record" onclick="toggleRecording('${cameraId}')">⏺ Record</button>
            <button class="btn btn-small btn-screenshot" onclick="takeScreenshot('${cameraId}')">📷 Screenshot</button>
        </div>
    `;
    cameraGrid.appendChild(card);
    emptyState.style.display = 'none';
    updateCameraCount();
}

// Remove camera card from grid
function removeCameraCard(cameraId) {
    const card = document.getElementById(`camera-${cameraId}`);
    if (card) card.remove();
    cameraStreams.delete(cameraId);
    peerConnections.delete(cameraId);
    updateCameraCount();

    if (cameraStreams.size === 0) {
        emptyState.style.display = 'flex';
    }
}

// Update camera count
function updateCameraCount() {
    cameraCount.textContent = `${cameraStreams.size} Camera${cameraStreams.size !== 1 ? 's' : ''}`;
    btnRecordAll.style.display = cameraStreams.size > 0 ? 'inline-block' : 'none';
}

// Show QR Code
async function showQR() {
    try {
        const res = await fetch('/api/qr');
        const data = await res.json();
        qrImage.src = data.qr;
        qrUrl.textContent = data.url;
        qrModal.style.display = 'flex';
    } catch (err) {
        console.error('QR error:', err);
    }
}

// Create peer connection for a camera
async function createPeerConnectionForCamera(cameraId, socketId) {
    const pc = new RTCPeerConnection(ICE_CONFIG);

    pc.ontrack = (event) => {
        console.log(`Got track from ${cameraId}`);
        const videoEl = document.getElementById(`video-${cameraId}`);
        if (videoEl && event.streams[0]) {
            videoEl.srcObject = event.streams[0];
            cameraStreams.set(cameraId, {
                stream: event.streams[0],
                socketId,
                name: cameraStreams.get(cameraId)?.name || cameraId
            });
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('camera:ice-candidate', {
                candidate: event.candidate,
                targetSocketId: socketId
            });
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            const status = document.querySelector(`#camera-${cameraId} .camera-status`);
            if (status) {
                status.textContent = 'OFFLINE';
                status.className = 'camera-status offline';
            }
        }
    };

    peerConnections.set(cameraId, pc);
    return pc;
}

// Toggle recording for a camera
function toggleRecording(cameraId) {
    if (recorders.has(cameraId)) {
        stopRecording(cameraId);
    } else {
        startRecording(cameraId);
    }
}

// Start recording
function startRecording(cameraId) {
    const camData = cameraStreams.get(cameraId);
    if (!camData || !camData.stream) return;

    const options = { mimeType: 'video/webm;codecs=vp9,opus' };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm';
    }

    const recorder = new MediaRecorder(camData.stream, options);
    recordedChunks.set(cameraId, []);

    recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
            recordedChunks.get(cameraId).push(e.data);
        }
    };

    recorder.onstop = () => {
        const blob = new Blob(recordedChunks.get(cameraId), { type: 'video/webm' });
        saveRecording(cameraId, blob);
        recordedChunks.delete(cameraId);
    };

    recorder.start(1000);
    recorders.set(cameraId, recorder);

    const btn = document.querySelector(`#camera-${cameraId} .btn-record`);
    if (btn) {
        btn.textContent = '⏹ Stop';
        btn.classList.add('recording');
    }
}

// Stop recording
function stopRecording(cameraId) {
    const recorder = recorders.get(cameraId);
    if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
    }
    recorders.delete(cameraId);

    const btn = document.querySelector(`#camera-${cameraId} .btn-record`);
    if (btn) {
        btn.textContent = '⏺ Record';
        btn.classList.remove('recording');
    }
}

// Save recording to IndexedDB
function saveRecording(cameraId, blob) {
    const id = `rec_${Date.now()}`;
    const entry = {
        id,
        cameraId,
        timestamp: new Date().toISOString(),
        size: blob.size,
        blob
    };

    const request = indexedDB.open('CCTV_Recordings', 1);
    request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('recordings')) {
            db.createObjectStore('recordings', { keyPath: 'id' });
        }
    };
    request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('recordings', 'readwrite');
        tx.objectStore('recordings').put(entry);
        tx.oncomplete = () => {
            console.log('Recording saved:', id);
            alert('Recording saved! Click "View Recordings" to play.');
        };
    };
}

// Take screenshot
function takeScreenshot(cameraId) {
    const video = document.getElementById(`video-${cameraId}`);
    if (!video) return;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    const link = document.createElement('a');
    link.download = `screenshot_${cameraId}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
}

// Record all cameras
function recordAll() {
    let allRecording = false;
    recorders.forEach(() => { allRecording = true; });

    if (allRecording) {
        cameraStreams.forEach((_, id) => stopRecording(id));
        btnRecordAll.textContent = 'Record All';
    } else {
        cameraStreams.forEach((_, id) => startRecording(id));
        btnRecordAll.textContent = 'Stop All';
    }
}

// Load recordings
function loadRecordings() {
    const request = indexedDB.open('CCTV_Recordings', 1);
    request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('recordings', 'readonly');
        const store = tx.objectStore('recordings');
        const getAll = store.getAll();

        getAll.onsuccess = () => {
            recordingsList.innerHTML = '';
            const recordings = getAll.result;

            if (recordings.length === 0) {
                recordingsList.innerHTML = '<p class="no-recordings">No recordings found</p>';
                return;
            }

            recordings.reverse().forEach(rec => {
                const item = document.createElement('div');
                item.className = 'recording-item';
                item.innerHTML = `
                    <span class="rec-info">${rec.cameraId} - ${new Date(rec.timestamp).toLocaleString()}</span>
                    <span class="rec-size">${(rec.size / 1024 / 1024).toFixed(2)} MB</span>
                    <button class="btn btn-small btn-play" onclick="playRecording('${rec.id}')">▶ Play</button>
                    <button class="btn btn-small btn-delete" onclick="deleteRecording('${rec.id}')">🗑</button>
                `;
                recordingsList.appendChild(item);
            });
        };
    };
}

// Play recording
window.playRecording = function(id) {
    const request = indexedDB.open('CCTV_Recordings', 1);
    request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('recordings', 'readonly');
        const get = tx.objectStore('recordings').get(id);
        get.onsuccess = () => {
            if (get.result) {
                playbackVideo.src = URL.createObjectURL(get.result.blob);
                playbackVideo.style.display = 'block';
                playbackVideo.play();
            }
        };
    };
};

// Delete recording
window.deleteRecording = function(id) {
    const request = indexedDB.open('CCTV_Recordings', 1);
    request.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('recordings', 'readwrite');
        tx.objectStore('recordings').delete(id);
        tx.oncomplete = () => loadRecordings();
    };
};

// Socket Events
socket.on('camera:joined', async (data) => {
    console.log('Camera joined:', data);
    createCameraCard(data.id, data.name);
    cameraStreams.set(data.id, { stream: null, socketId: data.socketId, name: data.name });

    // Wait a bit for phone camera to be ready, then request offer
    setTimeout(() => {
        console.log('Requesting offer from phone:', data.socketId);
        socket.emit('camera:offer-request', { targetSocketId: data.socketId });
    }, 1000);
});

socket.on('camera:left', (data) => {
    console.log('Camera left:', data);
    removeCameraCard(data.id);
});

socket.on('camera:offer', async (data) => {
    console.log('Got offer from camera:', data.cameraId);

    const pc = await createPeerConnectionForCamera(data.cameraId, data.socketId);
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('camera:answer', {
        answer,
        targetSocketId: data.socketId
    });
});

socket.on('camera:ice-candidate', async (data) => {
    // Find the correct peer connection for this socket
    for (const [cameraId, camData] of cameraStreams) {
        if (camData.socketId === data.socketId) {
            const pc = peerConnections.get(cameraId);
            if (pc && pc.remoteDescription) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (e) {
                    console.error('ICE error:', e);
                }
            }
            break;
        }
    }
});

socket.on('connect', () => {
    console.log('Dashboard connected to server');
});

// Button Events
btnShowQR.addEventListener('click', showQR);
closeModal.addEventListener('click', () => { qrModal.style.display = 'none'; });
btnRecordAll.addEventListener('click', recordAll);
btnPlayback.addEventListener('click', () => {
    playbackPanel.style.display = 'block';
    loadRecordings();
});
btnClosePlayback.addEventListener('click', () => {
    playbackPanel.style.display = 'none';
    playbackVideo.style.display = 'none';
    playbackVideo.pause();
});

// Close modal on outside click
qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) qrModal.style.display = 'none';
});
