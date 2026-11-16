// Offscreen frame capture for GFormToGPT.
//
// chrome.tabs.captureVisibleTab() can only photograph the window's *active*
// tab, so capturing a Messenger/Facebook tab the user isn't looking at needs a
// real stream: the service worker asks chrome.tabCapture for a stream id tied
// to the target tab, this document consumes it, grabs exactly one frame, and
// hands a JPEG back. The stream is stopped immediately afterwards.

const FRAME_TIMEOUT_MS = 4000;

function grabFrame(video) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no frame within " + FRAME_TIMEOUT_MS + "ms")),
      FRAME_TIMEOUT_MS,
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(done);
    } else if (video.readyState >= 2) {
      done();
    } else {
      video.addEventListener("loadeddata", done, { once: true });
    }
  });
}

async function captureFrame(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  const video = document.createElement("video");
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.appendChild(video);

  try {
    await video.play();
    await grabFrame(video);

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);
    // JPEG keeps webhook payloads well under Discord's attachment cap.
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.8), width, height };
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    video.remove();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.action !== "offscreenCapture") return false; // not for us

  captureFrame(msg.streamId)
    .then((frame) => sendResponse({ ok: true, ...frame }))
    .catch((e) =>
      sendResponse({ ok: false, error: String((e && e.message) || e) }),
    );
  return true; // keep the channel open for the async reply
});
