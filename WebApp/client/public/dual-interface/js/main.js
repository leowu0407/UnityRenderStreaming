import { DualVideoPlayer } from "./video-player-dual.js";
import { createDisplayStringArray } from "../../js/stats.js";
import { registerGamepadEvents, registerKeyboardEvents, registerMouseEvents, sendClickEvent } from "../../videoplayer/js/register-events.js";

setup();

let videoPlayer = null;
let isConnected = false;
let statsIntervalId = null;
let lastStats = { embb: null, urllc: null };

// Expose to console for debugging
window.videoPlayer = null;

window.document.oncontextmenu = function () {
  return false;
};

window.addEventListener('resize', function () {
  if (videoPlayer) {
    videoPlayer.resizeVideo();
  }
}, true);

window.addEventListener('beforeunload', async () => {
  if (videoPlayer) {
    await videoPlayer.stop();
  }
}, true);

async function setup() {
  showPlayButton();
  addControlButtons();
}

function addControlButtons() {
  const configDiv = document.getElementById('config');
  
  const buttonDiv = document.createElement('div');
  buttonDiv.className = 'control-buttons';
  
  const connectBtn = document.createElement('button');
  connectBtn.id = 'connectBtn';
  connectBtn.textContent = 'Connect';
  connectBtn.onclick = onClickConnect;
  
  const disconnectBtn = document.createElement('button');
  disconnectBtn.id = 'disconnectBtn';
  disconnectBtn.textContent = 'Disconnect';
  disconnectBtn.disabled = true;
  disconnectBtn.onclick = onClickDisconnect;
  
  buttonDiv.appendChild(connectBtn);
  buttonDiv.appendChild(disconnectBtn);
  configDiv.appendChild(buttonDiv);
}

function showPlayButton() {
  if (!document.getElementById('playButton')) {
    let elementPlayButton = document.createElement('img');
    elementPlayButton.id = 'playButton';
    elementPlayButton.src = '../videoplayer/images/Play.png';
    elementPlayButton.alt = 'Start Streaming';
    const playButton = document.getElementById('player').appendChild(elementPlayButton);
    playButton.addEventListener('click', onClickPlayButton);
  }
}

function onClickPlayButton() {
  const playButton = document.getElementById('playButton');
  if (playButton) {
    playButton.style.display = 'none';
  }
  
  onClickConnect();
}

async function onClickConnect() {
  if (isConnected) {
    return;
  }
  
  // Get configuration from UI
  const config = {
    embbHost: document.getElementById('embbHost').value,
    embbPort: parseInt(document.getElementById('embbPort').value),
    urllcHost: document.getElementById('urllcHost').value,
    urllcPort: parseInt(document.getElementById('urllcPort').value),
    secure: document.getElementById('secureConnection').checked
  };
  
  // Update UI
  updateStatus('embbStatus', 'Connecting...', 'connecting');
  updateStatus('urllcStatus', 'Connecting...', 'connecting');
  document.getElementById('connectBtn').disabled = true;
  
  const playerDiv = document.getElementById('player');
  
  // Clear previous content
  clearChildren(playerDiv);
  
  // Create video element
  const elementVideo = document.createElement('video');
  elementVideo.id = 'Video';
  elementVideo.style.touchAction = 'none';
  elementVideo.autoplay = true;
  elementVideo.muted = true;  // Required for autoplay in most browsers
  elementVideo.playsInline = true;
  playerDiv.appendChild(elementVideo);

  // Create thumbnail video (optional)
  const elementVideoThumb = document.createElement('video');
  elementVideoThumb.id = 'VideoThumbnail';
  elementVideoThumb.style.touchAction = 'none';
  elementVideoThumb.style.display = 'none'; // Hidden by default
  playerDiv.appendChild(elementVideoThumb);

  try {
    videoPlayer = new DualVideoPlayer([elementVideo, elementVideoThumb], config);
    window.videoPlayer = videoPlayer; // Expose for debugging
    
    videoPlayer.ondisconnect = onDisconnect;
    
    videoPlayer.onconnected = () => {
      console.log('[Main] Data channel connected');
      isConnected = true;
      document.getElementById('disconnectBtn').disabled = false;
    };
    
    videoPlayer.onpaired = () => {
      console.log('[Main] Dual connection paired');
      updateStatus('embbStatus', 'Connected', 'connected');
      updateStatus('urllcStatus', 'Connected', 'connected');
    };
    
    await videoPlayer.setupConnection();
    
    // Register input events
    registerGamepadEvents(videoPlayer);
    registerKeyboardEvents(videoPlayer);
    registerMouseEvents(videoPlayer, elementVideo);
    
    // Add fullscreen button
    addFullscreenButton(playerDiv);

    showStatsMessage();
    
  } catch (error) {
    console.error('[Main] Connection failed:', error);
    updateStatus('embbStatus', 'Failed', 'disconnected');
    updateStatus('urllcStatus', 'Failed', 'disconnected');
    document.getElementById('connectBtn').disabled = false;
    showPlayButton();
  }
}

async function onClickDisconnect() {
  if (videoPlayer) {
    await videoPlayer.stop();
  }
  onDisconnect();
}

function onDisconnect() {
  isConnected = false;
  clearStatsMessage();
  
  updateStatus('embbStatus', 'Disconnected', 'disconnected');
  updateStatus('urllcStatus', 'Disconnected', 'disconnected');
  document.getElementById('pairIdDisplay').textContent = '-';
  document.getElementById('videoResolution').textContent = '-';
  document.getElementById('framesReceived').textContent = '0';
  document.getElementById('inputMessagesSent').textContent = '0';
  
  document.getElementById('connectBtn').disabled = false;
  document.getElementById('disconnectBtn').disabled = true;
  
  const playerDiv = document.getElementById('player');
  clearChildren(playerDiv);
  
  if (videoPlayer) {
    videoPlayer.stop();
    videoPlayer = null;
  }
  
  showPlayButton();
}

function updateStatus(elementId, text, state) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = text;
    element.className = `status-${state}`;
  }
}

function clearChildren(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function addFullscreenButton(playerDiv) {
  const elementFullscreenButton = document.createElement('img');
  elementFullscreenButton.id = 'fullscreenButton';
  elementFullscreenButton.src = '../videoplayer/images/FullScreen.png';
  playerDiv.appendChild(elementFullscreenButton);
  
  elementFullscreenButton.addEventListener('click', function () {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        document.documentElement.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
      } else {
        if (playerDiv.style.position == "absolute") {
          playerDiv.style.position = "relative";
        } else {
          playerDiv.style.position = "absolute";
        }
      }
    }
  });
  
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  function onFullscreenChange() {
    if (document.webkitFullscreenElement || document.fullscreenElement) {
      playerDiv.style.position = "absolute";
      elementFullscreenButton.style.display = 'none';
    } else {
      playerDiv.style.position = "relative";
      elementFullscreenButton.style.display = 'block';
    }
  }
}

function showStatsMessage() {
  clearStatsMessage();

  statsIntervalId = setInterval(async () => {
    if (videoPlayer == null) {
      return;
    }

    document.getElementById('inputMessagesSent').textContent = String(videoPlayer.inputMessagesSent);

    const stats = await videoPlayer.getStats();
    if (stats == null) {
      return;
    }

    const inboundVideo = findInboundVideoStat(stats.embb);
    if (inboundVideo) {
      updateResolution(inboundVideo);
      updateFramesReceived(inboundVideo);
    } else if (videoPlayer.videoWidth && videoPlayer.videoHeight) {
      document.getElementById('videoResolution').textContent = `${videoPlayer.videoWidth} x ${videoPlayer.videoHeight}`;
    }

    renderDetailedStats(stats);
    lastStats = stats;
  }, 1000);
}

function clearStatsMessage() {
  if (statsIntervalId != null) {
    clearInterval(statsIntervalId);
  }

  statsIntervalId = null;
  lastStats = { embb: null, urllc: null };

  const statsDetails = document.getElementById('statsDetails');
  statsDetails.hidden = true;
  statsDetails.innerHTML = '';
}

function findInboundVideoStat(report) {
  if (report == null) {
    return null;
  }

  for (const stat of report.values()) {
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
      return stat;
    }
  }

  return null;
}

function updateResolution(stat) {
  if (stat.frameWidth && stat.frameHeight) {
    document.getElementById('videoResolution').textContent = `${stat.frameWidth} x ${stat.frameHeight}`;
  }
}

function updateFramesReceived(stat) {
  if (typeof stat.framesReceived === 'number') {
    document.getElementById('framesReceived').textContent = String(stat.framesReceived);
  }
}

function renderDetailedStats(stats) {
  const statsDetails = document.getElementById('statsDetails');
  const lines = [];

  if (stats.embb != null) {
    const embbLines = createDisplayStringArray(stats.embb, lastStats.embb);
    if (embbLines.length > 0) {
      lines.push('<strong>eMBB Video Channel</strong>');
      lines.push(...embbLines);
    }
  }

  const urllcLines = createUrllcDisplayStringArray(stats.urllc, lastStats.urllc);
  if (urllcLines.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('<strong>URLLC Input Channel</strong>');
    lines.push(...urllcLines);
  }

  statsDetails.hidden = lines.length === 0;
  statsDetails.innerHTML = lines.join('<br>');
}

function createUrllcDisplayStringArray(report, lastReport) {
  if (report == null) {
    return [];
  }

  const lines = [];
  const dataChannelStats = [];
  let selectedCandidatePair = null;

  report.forEach(stat => {
    if (stat.type === 'data-channel') {
      dataChannelStats.push(stat);
    }

    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.nominated || stat.selected)) {
      selectedCandidatePair = stat;
    }
  });

  dataChannelStats.forEach(stat => {
    const label = stat.label || 'data';
    lines.push(`Data channel (${label}) state: ${stat.state}`);

    if (typeof stat.messagesSent === 'number') {
      lines.push(`Messages sent: ${stat.messagesSent}`);
    }

    if (typeof stat.bytesSent === 'number') {
      lines.push(`Bytes sent: ${stat.bytesSent}`);

      if (lastReport && lastReport.has(stat.id)) {
        const lastStat = lastReport.get(stat.id);
        const duration = (stat.timestamp - lastStat.timestamp) / 1000;
        if (duration > 0) {
          const bitrate = (8 * (stat.bytesSent - lastStat.bytesSent) / duration) / 1000;
          lines.push(`Bitrate: ${bitrate.toFixed(2)} kbit/sec`);
        }
      }
    }
  });

  if (selectedCandidatePair) {
    if (typeof selectedCandidatePair.availableOutgoingBitrate === 'number') {
      lines.push(`Available outgoing bitrate: ${(selectedCandidatePair.availableOutgoingBitrate / 1000).toFixed(2)} kbit/sec`);
    }
  }

  return lines;
}

// Expose for debugging
window.dualVideoPlayer = {
  getPlayer: () => videoPlayer,
  getStatus: () => ({
    isConnected,
    pairId: videoPlayer ? videoPlayer.getPairId() : null,
    isReady: videoPlayer ? videoPlayer.isReady() : false
  })
};
