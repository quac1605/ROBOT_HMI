// Minimal receive-only WHEP reader for the pinned MediaMTX camera server.
// One CameraPanel owns one reader. Closing it aborts signaling, terminates
// the peer connection and deletes the WHEP session when one was created.
export function createWhepReader({ url, token, onStream, onError }) {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const abort = new AbortController();
  let closed = false;
  let sessionUrl = null;
  let stream = null;
  let phase = 'OFFER';
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const timeout = setTimeout(() => fail(new Error('CAMERA_WHEP_TIMEOUT')), 15_000);

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    abort.abort();
    pc.close();
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    if (sessionUrl) {
      // The server also tears down the session when the peer disappears.
      void fetch(sessionUrl, { method: 'DELETE', headers, credentials: 'omit' })
        .catch(() => {});
    }
  }

  function fail(error) {
    if (closed) return;
    close();
    onError(error);
  }

  pc.ontrack = event => {
    if (closed) return;
    stream = event.streams[0] ?? new MediaStream([event.track]);
    onStream(stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !closed) fail(new Error('CAMERA_ICE_FAILED'));
  };

  async function connect() {
    try {
      phase = 'OFFER';
      pc.addTransceiver('video', { direction: 'recvonly' });
      await pc.setLocalDescription(await pc.createOffer());
      // Send a complete offer: no PATCH/trickle ICE session is needed.
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const onState = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', onState);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', onState);
          abort.signal.addEventListener('abort', () => reject(new Error('CAMERA_CLOSED')),
            { once: true });
        });
      }
      if (closed) return;
      phase = 'SIGNALING';
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
        credentials: 'omit',
        redirect: 'error',
        signal: abort.signal,
      });
      if (response.status !== 201) throw new Error(`CAMERA_WHEP_HTTP_${response.status}`);
      const location = response.headers.get('Location');
      if (!location) throw new Error('CAMERA_WHEP_NO_SESSION');
      const resolved = new URL(location, url);
      if (resolved.origin !== new URL(url).origin) throw new Error('CAMERA_WHEP_CROSS_ORIGIN_SESSION');
      sessionUrl = resolved.href;
      phase = 'ANSWER_BODY';
      const answer = await response.text();
      if (closed) return;
      phase = 'REMOTE_DESCRIPTION';
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      clearTimeout(timeout);
    } catch (error) {
      if (!closed) {
        // Identify the failed WebRTC step without interpolating the grant,
        // request URL or full SDP into the UI error.
        fail(new Error(`CAMERA_WHEP_${phase}: ${error.message}`, { cause: error }));
      }
    }
  }

  void connect();
  return { close };
}
