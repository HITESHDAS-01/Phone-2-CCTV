// Phone Camera - WebRTC Client
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const socket = io({
    secure: true,
    rejectUnauthorized: isLocal,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000
});

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

let localStream = null;
let peerConnection = null;
let currentFacing = 'environment';
let isStreaming = false;
let pendingOfferRequest = null;

// DOM Elements
const localPreview = document.getElementById('local-preview');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnSwitch = document.getElementById('btn-switch');
const cameraNameInput = document.getElementById('camera-name');
const connectionInfo = document.getElementById('connection-info');

function setStatus(status, text) {
    statusDot.className = `dot ${status}`;
    statusText.textContent = text;
}

async function startCamera() {
    try {
        const constraints = {
            video: {
                facingMode: currentFacing,
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 }
            },
            audio: false
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localPreview.srcObject = localStream;

        btnStart.style.display = 'none';
        btnStop.style.display = 'inline-block';
        btnSwitch.style.display = 'inline-block';
        isStreaming = true;

        setStatus('connecting', 'Camera active, connecting to server...');
        joinAsCamera();

        // If there was a pending offer request, handle it now
        if (pendingOfferRequest) {
            handleOfferRequest(pendingOfferRequest);
            pendingOfferRequest = null;
        }
    } catch (err) {
        console.error('Camera error:', err);
        setStatus('error', `Camera error: ${err.message}`);
    }
}

function stopCamera() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    localPreview.srcObject = null;
    btnStart.style.display = 'inline-block';
    btnStop.style.display = 'none';
    btnSwitch.style.display = 'none';
    isStreaming = false;
    setStatus('offline', 'Camera stopped');
}

async function switchCamera() {
    currentFacing = currentFacing === 'environment' ? 'user' : 'environment';
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    await startCamera();
}

function joinAsCamera() {
    const name = cameraNameInput.value.trim() || `Camera ${Math.floor(Math.random() * 100)}`;
    socket.emit('camera:join', { name });
}

async function handleOfferRequest(data) {
    console.log('Handling offer request from:', data.dashboardSocketId);

    if (!localStream) {
        console.log('Camera not ready yet, storing request...');
        pendingOfferRequest = data;
        return;
    }

    // Close old connection if exists
    if (peerConnection) {
        peerConnection.close();
    }

    const pc = new RTCPeerConnection(ICE_CONFIG);

    // Add local tracks
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('camera:ice-candidate', {
                candidate: event.candidate,
                targetSocketId: data.dashboardSocketId
            });
        }
    };

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log('Phone peer connection state:', state);
        if (state === 'connected') {
            setStatus('online', 'Connected to dashboard');
        } else if (state === 'disconnected' || state === 'failed') {
            setStatus('error', 'Connection lost');
        }
    };

    peerConnection = pc;

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('camera:offer', {
        offer,
        targetSocketId: data.dashboardSocketId
    });

    console.log('Offer sent to dashboard');
}

// Socket Events
socket.on('connect', () => {
    console.log('Connected to server:', socket.id);
    setStatus('connecting', 'Connected to server, start camera...');
    if (isStreaming) {
        joinAsCamera();
    }
});

socket.on('disconnect', () => {
    setStatus('offline', 'Disconnected from server');
});

socket.on('camera:offer-request', async (data) => {
    console.log('Received offer request from dashboard:', data.dashboardSocketId);
    await handleOfferRequest(data);
});

socket.on('camera:answer', async (data) => {
    console.log('Received answer from dashboard');
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log('Remote description set successfully');
        } catch (err) {
            console.error('Error setting remote description:', err);
        }
    }
});

socket.on('camera:ice-candidate', async (data) => {
    if (peerConnection && data.candidate) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
            console.error('Error adding ICE candidate:', err);
        }
    }
});

// Button Events
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
btnSwitch.addEventListener('click', switchCamera);
