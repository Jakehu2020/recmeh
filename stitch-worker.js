import * as MP4Box from 'https://cdn.jsdelivr.net/npm/mp4box@2.3/+esm';
import {
    Output, Mp4OutputFormat, BufferTarget,
    EncodedVideoPacketSource, EncodedPacket
} from 'https://cdn.jsdelivr.net/npm/mediabunny/+esm';


self.onmessage = async (e) => {
    const { segments, tlFps } = e.data;
    const result = await stitchMp4Segments(segments, tlFps);

    self.postMessage({ buffer: result }, [result]);
};

async function stitchMp4Segments(segments) {
    if (!segments || segments.length === 0) return null;
    if (segments.length === 1) return segments[0].buffer;
    const { width, height } = segments[0];

    const videoSource = new EncodedVideoPacketSource('avc');

    const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
        target: new BufferTarget(),
    });

    output.addVideoTrack(videoSource, { frameRate: 30 });
    await output.start();

    const encoder = new VideoEncoder({
        output: (chunk, meta) => {
            videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta);
        },
        error: e => console.error('Stitch encoder error:', e)
    });

    encoder.configure({
        codec: 'avc1.640034',
        width, height,
        bitrate: 1_000_000,
        framerate: 30
    });

    let globalFrameCount = 0;

    for (const seg of segments) {
        await new Promise((resolve, reject) => {
            const decoder = new VideoDecoder({
                output: frame => {
                    const ts = Math.round((globalFrameCount / 30) * 1e6);
                    const reframed = new VideoFrame(frame, { timestamp: ts });
                    encoder.encode(reframed, { keyFrame: globalFrameCount % 30 === 0 });
                    reframed.close();
                    frame.close();
                    globalFrameCount++;
                },
                error: e => { console.error('Stitch decoder error:', e); reject(e); }
            });

            const mp4boxFile = MP4Box.createFile();

            mp4boxFile.onReady = info => {
                const track = info.videoTracks[0];
                if (!track) { resolve(); return; }

                decoder.configure({
                    codec: track.codec,
                    codedWidth: track.video.width,
                    codedHeight: track.video.height,
                    description: getAvcDescription(mp4boxFile, track),
                    optimizeForLatency: false,
                });

                mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: Infinity });
                mp4boxFile.start();

                const buf2 = seg.buffer.slice(0);
                buf2.fileStart = 0;
                mp4boxFile.appendBuffer(buf2);
                mp4boxFile.flush();
            };

            mp4boxFile.onSamples = async (_id, _user, samples) => {
                for (const sample of samples) {
                    decoder.decode(new EncodedVideoChunk({
                        type: sample.is_sync ? 'key' : 'delta',
                        timestamp: (sample.cts / sample.timescale) * 1e6,
                        duration: (sample.duration / sample.timescale) * 1e6,
                        data: sample.data.slice(0)
                    }));
                }

                await decoder.flush();
                resolve();
            };

            mp4boxFile.onError = e => { console.error('MP4Box error:', e); reject(e); };

            const buf = seg.buffer.slice(0);
            buf.fileStart = 0;
            mp4boxFile.appendBuffer(buf);
            mp4boxFile.flush();
        });
    }
    await encoder.flush();
    encoder.close();
    videoSource.close();
    await output.finalize();

    return output.target.buffer;
}

function getAvcDescription(mp4boxFile, track) {
    const trak = mp4boxFile.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const avcC = entry.avcC || entry.hvcC;
        if (avcC) {
            const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
            avcC.write(stream);
            // Skip the 8-byte box header (size + fourcc) to get the raw config bytes
            return new Uint8Array(stream.buffer, 8);
        }
    }
    return undefined;
}