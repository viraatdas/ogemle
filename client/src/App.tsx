import { useCallback, useEffect, useRef, useState } from 'react';

type SignalPayload =
  | { kind: 'offer'; data: RTCSessionDescriptionInit }
  | { kind: 'answer'; data: RTCSessionDescriptionInit }
  | { kind: 'ice'; data: RTCIceCandidateInit | null };

type ServerMessage =
  | { type: 'status'; payload: { message: string } }
  | { type: 'match'; payload: { partnerId: string; role: 'offerer' | 'answerer' } }
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'partner_left' }
  | { type: 'error'; payload: { message: string } };

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL ?? 'ws://localhost:8080';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export default function App() {
  const [status, setStatus] = useState('Connecting to signaling server...');
  const [serverState, setServerState] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [isFindingMatch, setIsFindingMatch] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [hasLocalMedia, setHasLocalMedia] = useState(false);
  const [hasRemoteMedia, setHasRemoteMedia] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roleRef = useRef<'offerer' | 'answerer' | null>(null);
  const mountedRef = useRef(true);

  const sendMessage = useCallback((payload: object) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    ws.send(JSON.stringify(payload));
  }, []);

  const sendSignal = useCallback(
    (payload: SignalPayload) => {
      sendMessage({ type: 'signal', payload });
    },
    [sendMessage],
  );

  const resetCall = useCallback(
    (options: { keepLocalMedia?: boolean } = {}) => {
      roleRef.current = null;
      setIsFindingMatch(false);
      setInCall(false);

      if (peerRef.current) {
        peerRef.current.ontrack = null;
        peerRef.current.onicecandidate = null;
        peerRef.current.onconnectionstatechange = null;
        peerRef.current.close();
        peerRef.current = null;
      }

      setHasRemoteMedia(false);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }

      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach((track) => track.stop());
        remoteStreamRef.current = null;
      }

      if (!options.keepLocalMedia && localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = null;
        }
        setCameraOn(true);
        setMicOn(true);
        setHasLocalMedia(false);
      }
    },
    [],
  );

  const ensureLocalStream = useCallback(async () => {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      setCameraOn(true);
      setMicOn(true);
      setHasLocalMedia(true);
      return stream;
    } catch (error) {
      console.error('Failed to get user media', error);
      throw error;
    }
  }, []);

  const ensurePeerConnection = useCallback(async () => {
    if (peerRef.current) {
      return peerRef.current;
    }

    const stream = await ensureLocalStream();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerRef.current = pc;

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ kind: 'ice', data: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [remote] = event.streams;
      if (!remote) return;
      remoteStreamRef.current = remote;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remote;
      }
      setHasRemoteMedia(true);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        setInCall(true);
        setStatus('Partner connected. Say hi!');
      } else if (state === 'failed' || state === 'disconnected') {
        setStatus('Connection lost. Click Start to try again.');
        resetCall({ keepLocalMedia: true });
      }
    };

    return pc;
  }, [ensureLocalStream, resetCall, sendSignal]);

  const handleRemoteSignal = useCallback(
    async (payload: SignalPayload) => {
      const pc = await ensurePeerConnection();

      try {
        if (payload.kind === 'offer' && payload.data) {
          await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ kind: 'answer', data: answer });
        } else if (payload.kind === 'answer' && payload.data) {
          if (!pc.currentRemoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
          }
        } else if (payload.kind === 'ice') {
          if (payload.data) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(payload.data));
            } catch (error) {
              console.warn('Failed to add ICE candidate', error);
            }
          }
        }
      } catch (error) {
        console.error('Error handling remote signal', error);
        setStatus('Something went wrong negotiating the call. Please try again.');
        resetCall({ keepLocalMedia: true });
      }
    },
    [ensurePeerConnection, resetCall, sendSignal],
  );

  const handleMatch = useCallback(
    async (role: 'offerer' | 'answerer') => {
      roleRef.current = role;
      setIsFindingMatch(false);
      setStatus('Partner found! Setting up the call...');
      const pc = await ensurePeerConnection();

      if (role === 'offerer') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({ kind: 'offer', data: offer });
      }
    },
    [ensurePeerConnection, sendSignal],
  );

  const startChat = useCallback(async () => {
    if (serverState !== 'online') {
      setStatus('Still connecting to the server. Please wait...');
      return;
    }

    setIsFindingMatch(true);
    setStatus('Requesting a partner...');

    try {
      await ensurePeerConnection();
      sendMessage({ type: 'ready' });
    } catch (error) {
      console.error('Unable to start chat', error);
      setStatus('Camera or microphone was blocked. Please allow access and try again.');
      setIsFindingMatch(false);
      resetCall();
    }
  }, [ensurePeerConnection, resetCall, sendMessage, serverState]);

  const leaveChat = useCallback(() => {
    sendMessage({ type: 'leave' });
    resetCall();
    setStatus('You left the chat. Click Start when ready again.');
  }, [resetCall, sendMessage]);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const [track] = stream.getVideoTracks();
    if (!track) return;
    track.enabled = !track.enabled;
    setCameraOn(track.enabled);
  }, []);

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const [track] = stream.getAudioTracks();
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
  }, []);

  const connectSocket = useCallback(() => {
    socketRef.current?.close();

    const ws = new WebSocket(SIGNAL_URL);
    socketRef.current = ws;
    setServerState('connecting');
    setStatus('Connecting to signaling server...');

    ws.onopen = () => {
      if (socketRef.current !== ws) return;
      setServerState('online');
      setStatus('Connected. Hit Start when you are ready.');
    };

    ws.onmessage = (event) => {
      if (socketRef.current !== ws) return;
      try {
        const message: ServerMessage = JSON.parse(event.data);
        switch (message.type) {
          case 'status':
            setStatus(message.payload.message);
            break;
          case 'error':
            setStatus(message.payload.message);
            break;
          case 'match':
            handleMatch(message.payload.role);
            break;
          case 'signal':
            handleRemoteSignal(message.payload);
            break;
          case 'partner_left':
            setStatus('Partner disconnected. Click Start to find someone new.');
            resetCall({ keepLocalMedia: true });
            break;
          default:
            break;
        }
      } catch (error) {
        console.error('Failed to parse server message', error);
      }
    };

    ws.onclose = () => {
      if (socketRef.current !== ws) return;
      if (!mountedRef.current) return;
      setServerState('offline');
      setStatus('Lost connection. Reconnecting...');
      resetCall();
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectSocket();
        }, 2000);
      }
    };

    ws.onerror = () => {
      if (socketRef.current !== ws) return;
      ws.close();
    };
  }, [handleMatch, handleRemoteSignal, resetCall]);

  useEffect(() => {
    connectSocket();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
      resetCall();
    };
  }, [connectSocket, resetCall]);

  useEffect(() => {
    if (hasLocalMedia && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [hasLocalMedia]);

  useEffect(() => {
    if (hasRemoteMedia && remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, [hasRemoteMedia]);

  const serverIndicatorLabel =
    serverState === 'online' ? 'Online' : serverState === 'connecting' ? 'Connecting' : 'Offline';

  const canStart = serverState === 'online' && !isFindingMatch && !inCall;
  const canLeave = inCall || isFindingMatch;
  const mediaReady = hasLocalMedia;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Realtime WebRTC demo</p>
          <h1>ogemle</h1>
          <p className="subtitle">Anonymous one-to-one video chats with a single click.</p>
        </div>
        <div className={`status-pill ${serverState}`}>
          <span className="dot" />
          {serverIndicatorLabel}
        </div>
      </header>

      <section className="video-grid">
        <div className="video-tile remote">
          {hasRemoteMedia ? (
            <video ref={remoteVideoRef} autoPlay playsInline />
          ) : (
            <div className="video-placeholder">
              <p>{isFindingMatch ? 'Looking for someone...' : 'Partner video will appear here.'}</p>
            </div>
          )}
        </div>
        <div className="video-tile local">
          {mediaReady ? (
            <video ref={localVideoRef} autoPlay muted playsInline />
          ) : (
            <div className="video-placeholder">
              <p>Grant camera & mic access when you click Start.</p>
            </div>
          )}
          <div className="preview-label">You</div>
        </div>
      </section>

      <section className="status-panel">
        <p>{status}</p>
      </section>

      <section className="controls">
        <button className="primary" onClick={startChat} disabled={!canStart}>
          {isFindingMatch ? 'Matching...' : 'Start'}
        </button>
        <button onClick={leaveChat} disabled={!canLeave}>
          Leave
        </button>
        <button onClick={toggleCamera} disabled={!mediaReady}>
          {cameraOn ? 'Turn Camera Off' : 'Turn Camera On'}
        </button>
        <button onClick={toggleMic} disabled={!mediaReady}>
          {micOn ? 'Mute' : 'Unmute'}
        </button>
      </section>

      <section className="tips">
        <h2>How it works</h2>
        <ul>
          <li>Your browser connects to a lightweight WebSocket signaling server.</li>
          <li>When you press Start we exchange WebRTC offers, answers, and ICE candidates.</li>
          <li>Media flows peer-to-peer directly between participants once connected.</li>
          <li>No chats are stored. Refresh the page if anything looks off.</li>
        </ul>
      </section>
    </div>
  );
}
