import { Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacket } from 'https://cdn.jsdelivr.net/npm/mediabunny/+esm';
const camWorker = new Worker('stitch-worker.js', { type: 'module' });
const scrWorker = new Worker('stitch-worker.js', { type: 'module' });
const $ = id => document.getElementById(id);

const TL_FPS = 30;         // Output target framerate
let desiredSeconds = 30;
let tlTimer = null;

let camStream = null, scrStream = null, camRec = null, scrRec = null;
let camChunks = [], scrChunks = [];
let state = 'idle', startTime = 0, elapsed = 0, pauseStart = 0, totalPaused = 0;
let timer = null, snapCount = 0;

let recordCamera = true;
let recordScreen = true;

let camLive = null, scrLive = null;
let camTlSegments = [];
let scrTlSegments = [];

function fmt(ms) { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` }
function setStatus(t, d) { $('status').textContent = t; $('dot').className = 'dot ' + (d || '') }

function tick() {
    if (state !== 'recording') return;

    elapsed = (Date.now() - startTime) - totalPaused;
    $('elapsed').textContent = fmt(elapsed);

    const elapsedSeconds = elapsed / 1000;
    const progressPercent = Math.min(100, (elapsedSeconds / window.estimatedMaxSec) * 100);

    const hue = (Date.now() / 200) % 360;
    const alternatingColor = `hsl(${hue}, 80%, 35%)`;

    const toolbar = document.querySelector('.fixed');
    if (toolbar) {
        toolbar.style.setProperty('--progress-width', `${progressPercent}%`);
        toolbar.style.setProperty('--progress-color', alternatingColor);
    }
}

function initLiveEncoder(width, height) {
    if (!window.VideoEncoder) return null;

    const alignedWidth = width - (width % 2);
    const alignedHeight = height - (height % 2);

    const videoSource = new EncodedVideoPacketSource('avc');

    const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new BufferTarget(),
    });

    output.addVideoTrack(videoSource, { frameRate: TL_FPS });

    output.start();

    const encoder = new VideoEncoder({
        output: (chunk, meta) => {
            videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta).catch(e =>
                console.error('VideoSource backpressure error:', e)
            );
        },
        error: e => console.error("WebCodecs Live Error:", e)
    });

    encoder.configure({
        codec: 'avc1.640034',
        width: alignedWidth,
        height: alignedHeight,
        bitrate: 3_000_000,
        framerate: TL_FPS
    });

    return { output, videoSource, encoder, frameCount: 0, _w: alignedWidth, _h: alignedHeight };
}

async function promptMetrics() {
    var { value: firstFormValues, isConfirmed: firstConfirmed } = await Swal.fire({
        title: 'Timelapse Output Duration',
        html: `
            <div style="display:flex;align-items:center;justify-content:center;gap:8px">
                <div>
                    <label style="display:block;font-size:12px;margin-bottom:4px">Hours</label>
                    <input id="swal-hour" type="number" min="0" max="999" value="0"
                        class="swal2-input" style="width:80px;margin:0">
                </div>
                <span style="font-size:20px;padding-top:16px">:</span>
                <div>
                    <label style="display:block;font-size:12px;margin-bottom:4px">Minutes</label>
                    <input id="swal-min" type="number" min="0" max="59" value="1"
                        class="swal2-input" style="width:80px;margin:0">
                </div>
                <span style="font-size:20px;padding-top:16px">:</span>
                <div>
                    <label style="display:block;font-size:12px;margin-bottom:4px">Seconds</label>
                    <input id="swal-sec" type="number" min="0" max="59" value="30"
                        class="swal2-input" style="width:80px;margin:0">
                </div>
            </div>
            <div style="margin-top: 20px; text-align: left; display: inline-block; width: 240px;">
                <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 14px; cursor: pointer;">
                    <input type="checkbox" id="swal-cam" checked style="cursor: pointer;"> Record Camera View
                </label>
                <label style="display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer;">
                    <input type="checkbox" id="swal-scr" checked style="cursor: pointer;"> Record Screen Share
                </label>
            </div><br>`,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Continue...',
        preConfirm: () => {
            const hours = parseInt(document.getElementById('swal-hour').value) || 0;
            const mins = parseInt(document.getElementById('swal-min').value) || 0;
            const secs = parseInt(document.getElementById('swal-sec').value) || 0;
            const targetSec = hours * 3600 + mins * 60 + secs;

            const camChecked = document.getElementById('swal-cam').checked;
            const scrChecked = document.getElementById('swal-scr').checked;

            if (targetSec <= 0) {
                Swal.showValidationMessage('Please enter a duration greater than 0');
                return false;
            }
            if (!camChecked && !scrChecked) {
                Swal.showValidationMessage('Please select at least one media channel!');
                return false;
            }

            return { targetSec, camChecked, scrChecked };
        }
    });

    if (!firstConfirmed || !firstFormValues) return;
    const targetSec = firstFormValues.targetSec;

    var { value: secondFormValues, isConfirmed: secondConfirmed } = await Swal.fire({
        title: 'How long do you plan to timelapse?',
        html: `
            <p style="margin-bottom:12px;font-size:14px;color:#666">
                <b style="font-weight: 600">You can record more than this amount (try to avoid recording significantly less). </b><br>
            </p>
            <div style="display:flex;align-items:center;justify-content:center;gap:8px">
                <div>
                    <label style="display:block;font-size:12px;margin-bottom:4px">Hours</label>
                    <input id="swal-hour" type="number" min="0" max="999" value="0"
                        class="swal2-input" style="width:80px;margin:0">
                </div>
                <span style="font-size:20px;padding-top:16px">:</span>
                <div>
                    <label style="display:block;font-size:12px;margin-bottom:4px">Minutes</label>
                    <input id="swal-min" type="number" min="0" max="999" value="3"
                        class="swal2-input" style="width:80px;margin:0">
                </div>
                <span style="font-size:20px;padding-top:16px">:</span>
                <div>
                    <label style="display:block;font-size:12px;margin-bottom:4px">Seconds</label>
                    <input id="swal-sec" type="number" min="0" max="59" value="0"
                        class="swal2-input" style="width:80px;margin:0">
                </div>
            </div>
            <br>
            <p style="margin-bottom:12px;font-size:14px;color:#666">
                A better estimation helps with minimizing computational memory/storage.
            </p>`,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Make timelapse',
        preConfirm: () => {
            const hours = parseInt(document.getElementById('swal-hour').value) || 0;
            const mins = parseInt(document.getElementById('swal-min').value) || 0;
            const secs = parseInt(document.getElementById('swal-sec').value) || 0;
            const targetSec = hours * 3600 + mins * 60 + secs;

            if (targetSec <= 0) {
                Swal.showValidationMessage('Please enter a duration greater than 0');
                return false;
            }

            return { targetSec };
        }
    });

    if (!secondConfirmed || !secondFormValues) return;

    return {
        desiredSeconds: targetSec,
        targetSec: secondFormValues.targetSec,
        recordCamera: firstFormValues.camChecked,
        recordScreen: firstFormValues.scrChecked
    }
}

$('btn-start').addEventListener('click', async () => {
    if (state == 'idle') {
        const metrics = await promptMetrics();
        if (!metrics) return;

        const { targetSec, desiredSeconds: userDesired, recordCamera: wantCam, recordScreen: wantScr } = metrics;
        desiredSeconds = parseInt(userDesired, 10);
        recordCamera = wantCam;
        recordScreen = wantScr;

        window.estimatedMaxSec = targetSec;
        const totalFramesNeeded = desiredSeconds * TL_FPS;
        const grabInterval = (parseInt(targetSec, 10) * 1000) / totalFramesNeeded;

        const cv = $('cam-vid');
        const sv = $('scr-vid');

        $('cam-box').style.display = recordCamera ? '' : 'none';
        $('scr-box').style.display = recordScreen ? '' : 'none';

        camChunks = []; scrChunks = [];
        camLive = null; scrLive = null;
        camStream = null; scrStream = null;
        camRec = null; scrRec = null;
        camTlSegments = []; scrTlSegments = [];

        if (recordCamera) {
            setStatus('Camera…', '');
            camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            cv.srcObject = camStream; cv.style.display = 'block'; $('cam-ph').style.display = 'none'; $('cam-lbl').style.display = 'block';

            cv.onloadedmetadata = () => {
                camLive = initLiveEncoder(cv.videoWidth, cv.videoHeight);
                camLive._w = cv.videoWidth; camLive._h = cv.videoHeight;
            };
        }

        if (recordScreen) {
            setStatus('Screen…', '');
            scrStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
            sv.srcObject = scrStream; sv.style.display = 'block'; $('scr-ph').style.display = 'none'; $('scr-lbl').style.display = 'block';

            sv.onloadedmetadata = () => {
                scrLive = initLiveEncoder(sv.videoWidth, sv.videoHeight);
                scrLive._w = sv.videoWidth; scrLive._h = sv.videoHeight;
            };
            scrStream.getVideoTracks()[0].onended = () => { if (state === 'recording' || state === 'paused') softStop() };
        }

        const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
        const opts = mime ? { mimeType: mime, videoBitsPerSecond: 600000 } : { videoBitsPerSecond: 600000 };

        if (recordCamera && camStream) {
            camRec = new MediaRecorder(camStream, opts);
            camRec.ondataavailable = e => e.data.size && camChunks.push(e.data);
            camRec.start(1000);
        }
        if (recordScreen && scrStream) {
            scrRec = new MediaRecorder(scrStream, opts);
            scrRec.ondataavailable = e => e.data.size && scrChunks.push(e.data);
            scrRec.start(1000);
        }

        state = 'recording'; startTime = Date.now(); totalPaused = 0;
        timer = setInterval(tick, 500);

        tlTimer = setInterval(() => {
            if (state !== 'recording') return;

            if (recordCamera && camLive && camLive.encoder && camLive.encoder.state === 'configured' && cv.readyState >= 2) {
                try {
                    let frame = new VideoFrame(cv, { timestamp: Math.round((camLive.frameCount / TL_FPS) * 1e6) });
                    camLive.encoder.encode(frame, { keyFrame: camLive.frameCount % 60 === 0 });
                    frame.close();
                    camLive.frameCount++;
                } catch (e) { console.warn("Cam frame dropped:", e); }
            }

            if (recordScreen && scrLive && scrLive.encoder && scrLive.encoder.state === 'configured' && sv.readyState >= 2) {
                try {
                    let frame = new VideoFrame(sv, { timestamp: Math.round((scrLive.frameCount / TL_FPS) * 1e6) });
                    scrLive.encoder.encode(frame, { keyFrame: scrLive.frameCount % 60 === 0 });
                    frame.close();
                    scrLive.frameCount++;
                } catch (e) { console.warn("Screen frame dropped:", e); }
            }
        }, grabInterval);

        setStatus('Recording…', 'rec');
        document.getElementById('btn-start').innerHTML = `<ion-icon name="pause-circle-outline"></ion-icon>`;
    } else if (state === 'recording') {
        // Safe context checking prevents runtime pause failures on single options
        if (camRec && camRec.state === 'recording') camRec?.pause();
        if (scrRec && scrRec.state === 'recording') scrRec?.pause();
        state = 'paused'; pauseStart = Date.now();
        setStatus('Paused', 'pau');
        document.getElementById('btn-start').innerHTML = `<ion-icon name="play-circle-outline"></ion-icon>`;
    } else if (state === 'paused') {
        // Safe validation logic checks prior to issuing native resumes
        if (camRec && camRec.state === 'paused') camRec?.resume();
        if (scrRec && scrRec.state === 'paused') scrRec?.resume();
        totalPaused += Date.now() - pauseStart; state = 'recording';
        setStatus('Recording…', 'rec');
        document.getElementById('btn-start').innerHTML = `<ion-icon name="pause-circle-outline"></ion-icon>`;
    }
});

$('btn-pip').addEventListener('click', async () => {
    if (!camStream) return;
    const cv = $('cam-vid');
    if (cv.requestPictureInPicture) {
        try {
            if (document.pictureInPictureElement) { await document.exitPictureInPicture(); $('btn-pip').innerHTML = '<ion-icon name="copy-outline"></ion-icon>'; }
            else { await cv.requestPictureInPicture(); $('btn-pip').innerHTML = '<ion-icon name="square-outline"></ion-icon>'; }
        } catch (e) { setStatus('PiP not supported in this browser') }
    } else { setStatus('Picture-in-picture not supported in this browser') }
});

document.addEventListener('leavepictureinpicture', () => { $('btn-pip').innerHTML = '<i class="ti ti-picture-in-picture" aria-hidden="true"></i> PiP camera' });

$('btn-export').addEventListener('click', takeSnapshot);

function stitchMp4Segments(worker, segments) {
    return new Promise((resolve, reject) => {
        const handler = e => {
            worker.removeEventListener('message', handler);
            worker.removeEventListener('error', errorHandler);
            resolve(e.data.buffer);
        };
        const errorHandler = e => {
            worker.removeEventListener('message', handler);
            worker.removeEventListener('error', errorHandler);
            reject(e);
        };
        worker.addEventListener('message', handler);
        worker.addEventListener('error', errorHandler);

        const copies = segments.map(s => ({ ...s, buffer: s.buffer.slice(0) }));
        const transferables = copies.map(s => s.buffer);

        worker.postMessage({ segments: copies, tlFps: TL_FPS }, transferables);
    });
}

async function takeSnapshot() {
    if (state === 'idle') return;
    const snapElapsed = elapsed;

    $("btn-export").innerHTML = `<ion-icon name="repeat-outline" class="reverseanimation"></ion-icon>`;
    const snapNum = ++snapCount;
    let activeColumns = 0;

    const [camSegment, scrSegment] = await Promise.all([
        (async () => {
            if (!recordCamera || !camChunks.length) return null;
            if (!camLive || camLive.encoder.state !== 'configured') return null;
            const activeCam = camLive;
            camLive = initLiveEncoder(activeCam._w, activeCam._h);
            await activeCam.encoder.flush();
            activeCam.videoSource.close();
            await activeCam.output.finalize();
            return { buffer: activeCam.output.target.buffer, width: activeCam._w, height: activeCam._h };
        })(),
        (async () => {
            if (!recordScreen || !scrChunks.length) return null;
            if (!scrLive || scrLive.encoder.state !== 'configured') return null;
            const activeScr = scrLive;
            scrLive = initLiveEncoder(activeScr._w, activeScr._h);
            await activeScr.encoder.flush();
            activeScr.videoSource.close();
            await activeScr.output.finalize();
            return { buffer: activeScr.output.target.buffer, width: activeScr._w, height: activeScr._h };
        })()
    ]);

    if (camSegment) camTlSegments.push(camSegment);
    if (scrSegment) scrTlSegments.push(scrSegment);

    let cameraHtml = '';
    let screenHtml = '';

    if (recordCamera && camChunks.length > 0) {
        activeColumns++;
        const mime = camChunks[0]?.type || 'video/webm';
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const camBlob = new Blob([...camChunks], { type: mime });
        const camUrl = URL.createObjectURL(camBlob);
        const sizeCam = (camBlob.size / 1048576).toFixed(1);
        const tlSegLabel = camTlSegments.length > 1 ? `Timelapse (${camTlSegments.length} segments)` : 'Timelapse';

        cameraHtml = `
        <div style="background:rgba(0,0,0,0.02);padding:10px;border-radius:6px;">
            <div style="font-size:13px;font-weight:bold;margin-bottom:8px;color:#1e40af;"><i class="ti ti-camera"></i> CAMERA CHANNELS</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <div style="font-size:11px;color:gray;">Real-time (${sizeCam}MB)</div>
                <video src="${camUrl}" controls style="width:100%;border-radius:4px;background:#000;max-height:300px;"></video>
                <a href="${camUrl}" download="snap${snapNum}-camera-real.${ext}"><button class="snapshotbtn" style="width:100%;margin-top:4px;font-size:11px;">Download</button></a>
              </div>
              <div id="cam-tl-${snapNum}">
                <div style="font-size:11px;color:#2563eb;font-weight:bold;">${tlSegLabel}</div>
                <div style="width:100%;border-radius:4px;background:#000;max-height:300px;min-height:120px;display:flex;align-items:center;justify-content:center;">
                  <ion-icon name="repeat-outline" class="reverseanimation" style="font-size:28px;color:#fff;opacity:0.5;"></ion-icon>
                </div>
                <button class="snapshotbtn" disabled style="width:100%;margin-top:4px;font-size:11px;background:#2563eb;color:#fff;opacity:0.5;">Processing...</button>
              </div>
            </div>
        </div>`;
    }

    if (recordScreen && scrChunks.length > 0) {
        activeColumns++;
        const mime = scrChunks[0]?.type || 'video/webm';
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const scrBlob = new Blob([...scrChunks], { type: mime });
        const scrUrl = URL.createObjectURL(scrBlob);
        const sizeScr = (scrBlob.size / 1048576).toFixed(1);
        const tlSegLabel = scrTlSegments.length > 1 ? `Timelapse (${scrTlSegments.length} segments)` : 'Timelapse';

        screenHtml = `
        <div style="background:rgba(0,0,0,0.02);padding:10px;border-radius:6px;">
            <div style="font-size:13px;font-weight:bold;margin-bottom:8px;color:#065f46;"><i class="ti ti-screen-share"></i> SCREEN CHANNELS</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <div style="font-size:11px;color:gray;">Real-time (${sizeScr}MB)</div>
                <video src="${scrUrl}" controls style="width:100%;border-radius:4px;background:#000;max-height:300px;"></video>
                <a href="${scrUrl}" download="snap${snapNum}-screen-real.${ext}"><button class="snapshotbtn" style="width:100%;margin-top:4px;font-size:11px;">Download</button></a>
              </div>
              <div id="scr-tl-${snapNum}">
                <div style="font-size:11px;color:#059669;font-weight:bold;">${tlSegLabel}</div>
                <div style="width:100%;border-radius:4px;background:#000;max-height:300px;min-height:120px;display:flex;align-items:center;justify-content:center;">
                  <ion-icon name="repeat-outline" class="reverseanimation" style="font-size:28px;color:#fff;opacity:0.5;"></ion-icon>
                </div>
                <button class="snapshotbtn" disabled style="width:100%;margin-top:4px;font-size:11px;background:#059669;color:#fff;opacity:0.5;">Processing...</button>
              </div>
            </div>
        </div>`;
    }

    $('snaps-wrap').style.display = 'block';
    const item = document.createElement('div');
    item.className = 'snap-item';
    item.style = 'margin-bottom:24px; padding:16px; border:1px solid var(--border-color); border-radius:8px;';
    item.innerHTML = `
    <div class="snap-header" style="margin-bottom:12px;">
      <div class="snap-title"><strong><i class="ti ti-bookmark"></i> Snapshot ${snapNum}</strong></div>
      <span style="font-size:12px;color:var(--color-text-tertiary)">Segment Runtime: ${fmt(snapElapsed)}</span>
    </div>
    <div style="display:grid;grid-template-columns:${activeColumns === 2 ? '1fr 1fr' : '1fr'};gap:20px;">
      ${cameraHtml}
      ${screenHtml}
    </div>`;
    $('snap-list').prepend(item);
    $("btn-export").innerHTML = `<ion-icon name="download-outline"></ion-icon>`;

    const swapTimelapse = (placeholderId, buffer, ext, filename, accentColor) => {
        const el = document.getElementById(placeholderId);
        if (!el) return;
        if (!buffer) {
            el.innerHTML = `<div style="font-size:11px;color:gray;">Timelapse unavailable</div>`;
            return;
        }
        const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
        const label = el.querySelector('div').textContent; // preserve segment label
        el.innerHTML = `
            <div style="font-size:11px;color:${accentColor};font-weight:bold;">${label}</div>
            <video src="${url}" controls style="width:100%;border-radius:4px;background:#000;max-height:300px;"></video>
            <a href="${url}" download="${filename}"><button class="snapshotbtn" style="width:100%;margin-top:4px;font-size:11px;background:${accentColor};color:#fff;">Download</button></a>`;
    };

    // Fire both stitches without awaiting together so each swaps as soon as it's ready
    if (camSegment) {
        stitchMp4Segments(camWorker, camTlSegments).then(buf =>
            swapTimelapse(`cam-tl-${snapNum}`, buf, 'mp4', `snap${snapNum}-camera-timelapse.mp4`, '#2563eb')
        );
    }
    if (scrSegment) {
        stitchMp4Segments(scrWorker, scrTlSegments).then(buf =>
            swapTimelapse(`scr-tl-${snapNum}`, buf, 'mp4', `snap${snapNum}-screen-timelapse.mp4`, '#059669')
        );
    }
}

function softStop() {
    clearInterval(timer);
    clearInterval(tlTimer);
    $('btn-pip').disabled = true;
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => { });

    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    if (scrStream) { scrStream.getTracks().forEach(t => t.stop()); scrStream = null; }

    $('cam-vid').style.display = 'none'; $('cam-ph').style.display = 'block'; $('cam-lbl').style.display = 'none';
    $('scr-vid').style.display = 'none'; $('scr-ph').style.display = 'block'; $('scr-lbl').style.display = 'none';
    $('cam-box').style.display = '';
    $('scr-box').style.display = '';

    setStatus('Recording session ended', '');
    state = 'idle';
    window._releaseLock?.();
    document.getElementById('btn-start').innerHTML = `<ion-icon name="play-circle-outline"></ion-icon>`;
}

// wakeLock API, Web Lock API, and other modern browser features can be used to enhance the recording experience and prevent interruptions. Here's an example of how to implement a wake lock to keep the screen on during recording sessions:
if ("wakeLock" in navigator) {
    async function attemptWakeLock() {
        try {
            let wakeLock = await navigator.wakeLock.request("screen");
            wakeLock.addEventListener('release', () => {
                // if wake lock is released alter the button accordingly
                console.log("released..")
            });
        } catch (err) {
            console.log(`Wakelock request failed: ${err.name}, ${err.message}`);
        }
    }
    document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === 'visible') attemptWakeLock();
    });
    document.addEventListener("DOMContentLoaded", attemptWakeLock);
}

let ctx = null;

$('btn-start').addEventListener('click', () => {
    if (!ctx) {
        ctx = new AudioContext();
        const silent = ctx.createGain();
        silent.gain.value = 0;
        silent.connect(ctx.destination);
        const osc = ctx.createOscillator();
        osc.connect(silent);
        osc.start();
    } else if (ctx.state === 'suspended') {
        ctx.resume();
    }
    
    if ('locks' in navigator && state === 'idle') {
        navigator.locks.request('recording-session', { mode: 'exclusive' }, lock => {
            return new Promise(resolve => { window._releaseLock = resolve; });
        });
    }
});