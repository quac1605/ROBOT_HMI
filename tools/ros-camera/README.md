# ROS 2 camera gateway (read-only)

`ros_camera_gateway.py` subscribes `/image_front` and `/image_rear` with
`BEST_EFFORT` QoS, checks `bgr8`/640×360/stride/frame ID, and keeps only the
latest frame per camera. Two GStreamer child processes encode VP8/RTP for local
MediaMTX. This gateway never publishes ROS commands. The backend retains
`ROBOT_ADAPTER=mock`; real motor control is outside this integration.

## Local startup

Prerequisites: ROS 2 Jazzy and the camera node already running, GStreamer
plugins `rawvideoparse`, `videoconvert`, `vp8enc`, `rtpvp8pay`, the Stage 9
PostgreSQL database/user, and Node from the repository `.nvmrc`. All four
services run on the **same Ubuntu machine**.

From `/home/vistar/projects/ROBOT_HMI`, once:

```bash
bash tools/ros-camera/install_mediamtx.sh
bash tools/ros-camera/create_dev_cert.sh
```

The installer pins MediaMTX v1.21.2 and checks the downloaded archive SHA-256.
The binary and development TLS private key live in Git-ignored directories.
The certificate script refuses to overwrite an existing key.

The checkout does not include `backend/.env`. Create it before starting the
backend (the copy command leaves an existing file untouched):

```bash
cd /home/vistar/projects/ROBOT_HMI/backend
test -e .env || cp .env.example .env
chmod 600 .env
```

Edit it locally. Set `DATABASE_URL` for your existing **development** database,
a distinct 64–128-character hex `SESSION_SECRET` (generate locally with
`openssl rand -hex 32`) and an absolute `DATA_DIR`. Do not paste secrets into
chat or use `backend/.env.test` for the Web Application. No new migration is
required for camera streaming. Then set these values in that same file:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3001
APP_ORIGIN=https://127.0.0.1:5173
ROBOT_ADAPTER=mock
CAMERA_MEDIA_MODE=ros
CAMERA_WHEP_BASE_URL=https://127.0.0.1:8889
TRUST_LOOPBACK_PROXY=false
```

Run these in **four separate terminals**, after confirming that the existing
ROS camera node publishes both topics. Do not launch a second camera driver.

```bash
# Terminal 1: backend, from repository root
nvm use
node --env-file=backend/.env backend/src/server.js
```

```bash
# Terminal 2: media server, from repository root
bash tools/ros-camera/run_mediamtx.sh
```

```bash
# Terminal 3: ROS subscriber and encoders, from repository root
source /opt/ros/jazzy/setup.bash
source /home/vistar/projects/ros2_ws/install/setup.bash
python3 -u tools/ros-camera/ros_camera_gateway.py
```

```bash
# Terminal 4: frontend, start from repository root
nvm use
cd frontend
HTTPS=true VITE_ROBOT_CLIENT=remote HMI_BACKEND_URL=http://127.0.0.1:3001 \
  npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

In the browser, visit `https://127.0.0.1:8889/` once to accept the
**development** media certificate (the root page may return 404). Then visit
`https://127.0.0.1:5173/login` **exactly**, accept the Vite development
certificate, and log in using an existing HMI account. `localhost` is a
different Origin and the backend will reject its login with `ORIGIN_FORBIDDEN`
while `APP_ORIGIN` is set to `https://127.0.0.1:5173`. Both Navigation and Mapping should show
`Camera ROS trực tiếp`; select **Cam trước** and **Cam sau** and check that the
video moves. The gateway logs per-camera frame counters every 10 seconds.
The backend gives a short-lived, camera-bound WHEP grant to logged-in users;
MediaMTX checks it via a localhost callback. Direct unauthenticated access to
`https://127.0.0.1:8889/front/` must return 401.

Firefox may report `NetworkError when attempting to fetch resource` in the
camera panel if its profile trusts the Vite certificate but has not yet trusted
the separate MediaMTX certificate. Open the media origin in that **same Firefox
profile**, review and accept only this local development certificate, then
reload the HMI camera page. Keep browser certificate verification enabled.
If the WHEP `POST` returns `201` but Firefox logs `WebRTC: ICE failed`, inspect
`about:webrtc`. Firefox normally excludes loopback ICE candidates, while this
development MediaMTX advertises only `127.0.0.1:8189`. Changing
`media.peerconnection.ice.loopback` did not produce a loopback candidate in
the Firefox profile used for this project, so do not treat that preference as
a verified fix. Restore its original value if you changed it. Do not add a
public STUN server for this local path. To view from another LAN machine, use
the LAN guide below: it advertises the reachable interface address for ICE.

For troubleshooting, see the local, more detailed
`../../docs/HUONG_DAN_CHAY_CAMERA_ROS_LIVE_CHANG_10.md`. This setup is only
for a browser on the same machine. It does not prove source capture age, LAN
ICE connectivity or hardware teleoperation readiness.

For the HTTPS/ICE configuration that lets another LAN computer open HMI and
both cameras, see `../../docs/HUONG_DAN_HMI_CAMERA_LAN_CHANG_10.md`.
