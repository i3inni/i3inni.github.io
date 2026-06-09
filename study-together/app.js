/* ════════════════════════════════════════════════════════════════
   같이 공부 (Study Flight) — 프론트엔드
   백엔드(Spring Boot)와 통신:
     · REST  : 로비(공개 방 목록), 방 생성
     · WS    : /ws/signal — WebRTC 시그널링 + presence
     · WebRTC: 네이티브 RTCPeerConnection 풀메시 (카메라만)
   백엔드 주소는 화면 하단에서 설정(기본 http://localhost:8080).
   ════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  // ── 백엔드 주소 ──
  // Railway 배포 후 아래에 도메인을 붙여넣으면 GitHub Pages에서 자동으로 사용됨.
  //   예: "https://study-together-server-production.up.railway.app"
  // 비워두면 localhost:8080 (로컬 개발). 화면 하단 입력칸으로 언제든 덮어쓸 수 있음.
  const RAILWAY_API = "https://i3innigithubio-production.up.railway.app";

  function apiBase() {
    const saved = localStorage.getItem("sf_api");
    const onLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);
    // 라이브 사이트인데 저장된 주소가 localhost면 무시(예전 로컬 테스트 잔재 자동 치유)
    const savedIsLocal = saved && /localhost|127\.0\.0\.1/.test(saved);
    if (saved && !(savedIsLocal && !onLocalhost)) return saved.replace(/\/+$/, "");
    if (RAILWAY_API) return RAILWAY_API.replace(/\/+$/, "");
    return "http://localhost:8080";
  }
  function wsUrl() {
    const base = apiBase();
    const ws = base.replace(/^http/, "ws"); // http→ws, https→wss
    return ws + "/ws/signal";
  }

  // 다른 네트워크 연결엔 TURN이 필요. 데모는 STUN만(같은 망 OK).
  // TURN 추가 지점 ↓ (예: {urls:"turn:...", username:"...", credential:"..."})
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  // ── DOM ──
  const $ = (id) => document.getElementById(id);
  const lobbyView = $("lobby-view");
  const roomView = $("room-view");
  const grid = $("video-grid");
  const toastEl = $("toast");

  // ── 상태 ──
  let myName = "";
  let isHost = false;
  let roomCode = null;
  let meta = null; // {code,title,hostName,departure,destination,durationMinutes,status,startedAt}
  let ws = null;
  let selfId = null;
  let localStream = null;
  let inRoom = false;
  let joinPassword = "";

  // 카메라 / 음악
  let camOn = true;
  let musicMuted = false; // 개인별 음소거 (로컬)
  let ytPlayer = null;
  let ytReady = false;
  let currentVideoId = null;
  let pendingMusic = null; // 플레이어 준비 전 도착한 상태

  const pcs = {}; // peerId → RTCPeerConnection
  const peerNames = {}; // peerId → name
  const remoteStreams = {}; // peerId → MediaStream
  const pendingIce = {}; // peerId → [candidate,...] (remoteDescription 전 버퍼)
  const tileEls = {}; // id → {root, video, label, badge, empty}

  let timerInt = null;
  let lobbyInt = null;

  // ════════════════ 유틸 ════════════════
  let toastT;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }
  async function getMedia() {
    try {
      // 카메라만! 오디오 미캡처 → 마이크 OFF 보장
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      return true;
    } catch (e) {
      toast("카메라 권한이 필요해요 📷");
      return false;
    }
  }

  // ════════════════ 로비 (공개 방 목록) ════════════════
  async function refreshLobby() {
    const box = $("room-list");
    try {
      const res = await fetch(apiBase() + "/api/rooms");
      if (!res.ok) throw new Error("bad status");
      const rooms = await res.json();
      if (!rooms.length) {
        box.innerHTML =
          '<p class="text-sm text-light-subtext dark:text-dark-subtext">열려있는 방이 없어요. 먼저 만들어보세요!</p>';
        return;
      }
      box.innerHTML = "";
      rooms.forEach((r) => {
        const flying = r.status === "FLYING";
        const row = document.createElement("div");
        row.className =
          "flex items-center justify-between gap-2 p-3 rounded-xl bg-light-bg dark:bg-dark-bg border border-gray-200 dark:border-gray-700";
        row.innerHTML = `
          <div class="min-w-0">
            <p class="font-semibold text-sm truncate">${r.locked ? "🔒 " : ""}${escapeHtml(r.title)}
              <span class="ml-1 align-middle inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${
                flying
                  ? "bg-primary/15 text-primary"
                  : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
              }">${flying ? "비행중" : "대기중"}</span>
            </p>
            <p class="text-xs text-light-subtext dark:text-dark-subtext truncate">
              ${escapeHtml(r.departure)} → ${escapeHtml(r.destination)} · ${r.durationMinutes}분 · 👤 ${r.participantCount} · <span class="font-mono text-primary">${r.code}</span>
            </p>
          </div>
          <button class="join-room px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary-hover transition flex-shrink-0">입장</button>`;
        row.querySelector(".join-room").onclick = () => joinRoom(r.code);
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = `<p class="text-sm text-red-500">서버에 연결할 수 없어요. 하단의 백엔드 주소를 확인해주세요. (${escapeHtml(apiBase())})</p>`;
    }
  }
  function startLobbyPolling() {
    refreshLobby();
    if (lobbyInt) clearInterval(lobbyInt);
    lobbyInt = setInterval(refreshLobby, 4000);
  }
  function stopLobbyPolling() {
    if (lobbyInt) clearInterval(lobbyInt);
    lobbyInt = null;
  }

  // ════════════════ 방 생성 (방장) ════════════════
  async function createRoom() {
    myName = $("nickname").value.trim();
    if (!myName) return toast("닉네임을 입력해주세요");

    const body = {
      title: $("r-title").value.trim() || "같이 공부 비행",
      hostName: myName,
      departure: $("r-from").value.trim() || "출발지",
      destination: $("r-to").value.trim() || "목적지",
      durationMinutes: Math.min(600, Math.max(1, parseInt($("r-duration").value || "50", 10))),
      password: $("r-password").value.trim(),
    };

    // 카메라 먼저 확보 (거부 시 빈 방이 안 생기도록)
    if (!(await getMedia())) return;

    let created;
    try {
      const res = await fetch(apiBase() + "/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("create failed");
      created = await res.json();
    } catch (e) {
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      return toast("방 생성 실패 — 백엔드 주소를 확인해주세요");
    }

    isHost = true;
    roomCode = created.code;
    meta = created;
    joinPassword = body.password || ""; // 방장은 자기가 정한 비번으로 입장
    connectWs();
  }

  // ════════════════ 방 입장 (참가자) ════════════════
  async function joinRoom(code) {
    myName = $("nickname").value.trim();
    if (!myName) return toast("닉네임을 입력해주세요");
    code = (code || "").trim().toUpperCase();
    if (!code) return toast("방 코드를 입력해주세요");

    // 방 정보 확인 (잠김 여부)
    let info = null;
    try {
      const res = await fetch(apiBase() + "/api/rooms/" + code);
      if (res.ok) info = await res.json();
    } catch {}
    if (info === null) {
      // 상세 조회 실패해도 진행은 시도 (서버가 최종 판단)
    } else if (!info) {
      return toast("방을 찾을 수 없어요");
    }

    let password = "";
    if (info && info.locked) {
      password = prompt("🔒 비밀번호를 입력하세요");
      if (password === null) return; // 취소
    }

    if (!(await getMedia())) return;
    isHost = false;
    roomCode = code;
    joinPassword = password;
    meta = { code, title: "입장 중…", departure: "", destination: "", durationMinutes: 0, status: "WAITING", startedAt: null };
    connectWs();
  }

  // ════════════════ WebSocket 시그널링 ════════════════
  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function connectWs() {
    enterRoom();
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      wsSend({ type: "join", roomCode, name: myName, password: joinPassword || "" });
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleSignal(msg);
    };
    ws.onclose = (ev) => {
      console.warn("[ws closed] code=", ev.code, "reason=", ev.reason, "url=", wsUrl());
      if (inRoom) {
        toast(`서버 연결 끊김 (code ${ev.code}) — ${wsUrl()}`);
        setTimeout(() => leaveRoom(), 1500);
      }
    };
    ws.onerror = () => {
      console.warn("[ws error] url=", wsUrl());
      toast("시그널링 연결 실패: " + wsUrl());
    };
  }

  function handleSignal(msg) {
    switch (msg.type) {
      case "joined":
        selfId = msg.selfId;
        meta = msg.meta;
        toast("방에 입장했어요 ✅");
        applyMeta();
        renderTiles();
        // 내가 새로 들어왔으니 기존 참가자들에게 내가 offer를 건다
        (msg.peers || []).forEach((p) => {
          peerNames[p.id] = p.name;
          callPeer(p.id);
        });
        applyMusic(msg.nowPlaying, msg.queue);
        break;
      case "music-state":
        applyMusic(msg.nowPlaying, msg.queue);
        break;
      case "peer-join":
        // 새 사람이 들어옴 → 그가 나에게 offer 할 것. 이름만 기록.
        peerNames[msg.id] = msg.name;
        toast(`${msg.name}님이 입장했어요 👋`);
        renderTiles();
        break;
      case "offer":
        onOffer(msg.from, msg.payload);
        break;
      case "answer":
        onAnswer(msg.from, msg.payload);
        break;
      case "ice":
        onIce(msg.from, msg.payload);
        break;
      case "peer-leave":
        removePeer(msg.id);
        break;
      case "state":
        meta = msg.meta;
        applyMeta();
        break;
      case "error":
        toast(msg.message || "오류가 발생했어요");
        setTimeout(() => leaveRoom(), 1000);
        break;
    }
  }

  // ════════════════ WebRTC ════════════════
  function makePeer(peerId) {
    if (pcs[peerId]) return pcs[peerId];
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcs[peerId] = pc;
    pendingIce[peerId] = pendingIce[peerId] || [];

    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.onicecandidate = (ev) => {
      if (ev.candidate) wsSend({ type: "ice", to: peerId, payload: ev.candidate });
    };
    pc.ontrack = (ev) => {
      remoteStreams[peerId] = ev.streams[0];
      renderTiles();
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      console.log(`[pc ${peerId}] ${st}`);
      if (st === "failed") {
        const tile = tileEls[peerId];
        if (tile && !remoteStreams[peerId]) tile.empty.textContent = "연결 실패 ✕";
      }
    };
    return pc;
  }

  async function callPeer(peerId) {
    const pc = makePeer(peerId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: "offer", to: peerId, payload: offer });
    } catch (e) {
      console.warn("offer error", e);
    }
  }

  async function onOffer(from, payload) {
    const pc = makePeer(from);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      await flushIce(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: "answer", to: from, payload: answer });
    } catch (e) {
      console.warn("answer error", e);
    }
  }

  async function onAnswer(from, payload) {
    const pc = pcs[from];
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(payload));
      await flushIce(from);
    } catch (e) {
      console.warn("setRemote(answer) error", e);
    }
  }

  async function onIce(from, payload) {
    const pc = pcs[from];
    if (!pc || !payload) return;
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
      (pendingIce[from] = pendingIce[from] || []).push(payload);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(payload));
    } catch (e) {
      console.warn("addIce error", e);
    }
  }

  async function flushIce(peerId) {
    const pc = pcs[peerId];
    const queue = pendingIce[peerId] || [];
    pendingIce[peerId] = [];
    for (const cand of queue) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {
        console.warn("flushIce error", e);
      }
    }
  }

  function removePeer(id) {
    if (pcs[id]) {
      try {
        pcs[id].close();
      } catch {}
      delete pcs[id];
    }
    delete remoteStreams[id];
    delete peerNames[id];
    delete pendingIce[id];
    renderTiles();
  }

  // ════════════════ 렌더링 ════════════════
  function participantIds() {
    // 나 + 알려진 피어들(이름 또는 pc 존재)
    const ids = [selfId].filter(Boolean);
    const peers = new Set([...Object.keys(peerNames), ...Object.keys(pcs)]);
    peers.forEach((id) => {
      if (id !== selfId) ids.push(id);
    });
    return ids;
  }

  function createTile() {
    const root = document.createElement("div");
    root.className = "video-tile";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // 스피커 OFF
    const empty = document.createElement("div");
    empty.className = "tile-empty";
    empty.textContent = "연결 중…";
    const label = document.createElement("div");
    label.className = "tile-label";
    const badge = document.createElement("div");
    badge.className = "tile-badge";
    badge.textContent = "방장";
    badge.style.display = "none";
    root.append(video, empty, label, badge);
    return { root, video, label, badge, empty };
  }

  function renderTiles() {
    const ids = participantIds();
    Object.keys(tileEls).forEach((id) => {
      if (!ids.includes(id)) {
        tileEls[id].root.remove();
        delete tileEls[id];
      }
    });
    const hostName = meta ? meta.hostName : null;
    ids.forEach((id) => {
      let tile = tileEls[id];
      if (!tile) {
        tile = createTile();
        tileEls[id] = tile;
      }
      grid.appendChild(tile.root);

      const isMe = id === selfId;
      const name = isMe ? myName : peerNames[id] || "친구";
      tile.label.innerHTML = `📷 ${escapeHtml(isMe ? "나" : name)}`;
      tile.badge.style.display = hostName && name === hostName ? "block" : "none";

      const stream = isMe ? localStream : remoteStreams[id];
      if (stream && tile.video.srcObject !== stream) tile.video.srcObject = stream;
      if (isMe && !camOn) {
        tile.empty.textContent = "📷 꺼짐";
        tile.empty.style.display = "flex";
      } else if (stream) {
        tile.empty.style.display = "none";
      } else {
        tile.empty.textContent = "연결 중…";
        tile.empty.style.display = "flex";
      }
    });
    $("people-count").textContent = ids.length;
  }

  function applyMeta() {
    if (!meta) return;
    $("room-title").textContent = meta.title;
    $("room-from").textContent = meta.departure;
    $("room-to").textContent = meta.destination;

    const badge = $("room-status");
    roomView.classList.remove("flying", "arrived");
    if (meta.status === "FLYING") {
      badge.textContent = "✈️ 비행 중 (집중!)";
      badge.className = "inline-block px-3 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary";
      roomView.classList.add("flying");
    } else if (meta.status === "FINISHED") {
      badge.textContent = "🛬 도착! 수고했어요";
      badge.className = "inline-block px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      roomView.classList.add("arrived");
    } else {
      badge.textContent = "🕒 대기 중";
      badge.className = "inline-block px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
    }
    // 이륙 버튼: 방장 + 대기 중
    $("takeoff-btn").classList.toggle("hidden", !(isHost && meta.status === "WAITING"));
    // 함께 듣기: 이륙(비행/도착) 후 표시
    $("music-panel").classList.toggle("hidden", meta.status === "WAITING");
    tick();
  }

  function tick() {
    if (!meta) return;
    const total = (meta.durationMinutes || 0) * 60;
    let remain = total;
    let pct = 0;
    if (meta.status === "FLYING" && meta.startedAt) {
      const elapsed = (Date.now() - meta.startedAt) / 1000;
      remain = total - elapsed;
      pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
      if (remain <= 0) {
        remain = 0;
        pct = 100;
        meta.status = "FINISHED";
        applyMeta();
        return;
      }
    } else if (meta.status === "FINISHED") {
      remain = 0;
      pct = 100;
    }
    $("room-timer").textContent = fmt(remain);
    $("flight-progress").style.width = pct + "%";
    $("flight-plane").style.left = pct + "%";
  }

  // ════════════════ 화면 전환 ════════════════
  function enterRoom() {
    inRoom = true;
    stopLobbyPolling();
    lobbyView.classList.add("hidden");
    roomView.classList.remove("hidden");
    $("room-code").textContent = roomCode;
    applyMeta();
    renderTiles();
    if (timerInt) clearInterval(timerInt);
    timerInt = setInterval(tick, 1000);
    window.scrollTo(0, 0);
  }

  function leaveRoom() {
    inRoom = false;
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
    try {
      if (ws) {
        wsSend({ type: "leave" });
        ws.close();
      }
    } catch {}
    Object.values(pcs).forEach((pc) => {
      try {
        pc.close();
      } catch {}
    });
    try {
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    } catch {}

    ws = null;
    selfId = null;
    localStream = null;
    isHost = false;
    roomCode = null;
    meta = null;
    joinPassword = "";
    camOn = true;
    currentVideoId = null;
    pendingMusic = null;
    try {
      if (ytPlayer && ytReady) ytPlayer.stopVideo();
    } catch {}
    $("cam-toggle").textContent = "📷 카메라 끄기";
    for (const k in pcs) delete pcs[k];
    for (const k in peerNames) delete peerNames[k];
    for (const k in remoteStreams) delete remoteStreams[k];
    for (const k in pendingIce) delete pendingIce[k];
    Object.values(tileEls).forEach((t) => t.root.remove());
    for (const k in tileEls) delete tileEls[k];
    grid.innerHTML = "";

    roomView.classList.add("hidden");
    lobbyView.classList.remove("hidden");
    startLobbyPolling();
  }

  // ════════════════ 카메라 on/off ════════════════
  function toggleCamera() {
    camOn = !camOn;
    if (localStream) localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    const btn = $("cam-toggle");
    btn.textContent = camOn ? "📷 카메라 끄기" : "🚫 카메라 켜기";
    btn.classList.toggle("bg-red-100", !camOn);
    btn.classList.toggle("dark:bg-red-900/40", !camOn);
    btn.classList.toggle("text-red-600", !camOn);
    renderTiles();
  }

  // ════════════════ 함께 듣기 (유튜브 큐) ════════════════
  function parseYouTubeId(input) {
    if (!input) return null;
    const s = input.trim();
    const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return null;
  }

  function addSong() {
    const id = parseYouTubeId($("music-url").value);
    if (!id) return toast("유효한 유튜브 링크가 아니에요");
    wsSend({ type: "music-add", videoId: id, addedBy: myName });
    $("music-url").value = "";
    toast("🎵 대기열에 추가했어요");
  }

  function skipSong() {
    wsSend({ type: "music-skip" });
  }

  function toggleMusicMute() {
    musicMuted = !musicMuted;
    applyMusicMute();
    $("music-mute").textContent = musicMuted ? "🔇 내 소리 꺼짐" : "🔊 내 소리 켜짐";
  }
  function applyMusicMute() {
    if (!ytReady) return;
    try {
      if (musicMuted) ytPlayer.mute();
      else ytPlayer.unMute();
    } catch {}
  }

  function applyMusic(nowPlaying, queue) {
    renderQueue(queue || []);
    if (!ytReady) {
      pendingMusic = { nowPlaying, queue };
      return;
    }
    if (nowPlaying && nowPlaying.videoId) {
      if (nowPlaying.videoId !== currentVideoId) {
        currentVideoId = nowPlaying.videoId;
        const elapsed = Math.max(0, (Date.now() - (nowPlaying.startedAt || Date.now())) / 1000);
        try {
          ytPlayer.loadVideoById({ videoId: currentVideoId, startSeconds: elapsed });
        } catch {}
        applyMusicMute();
        // 영상은 숨기고 음악 카드(썸네일+제목)만 표시
        $("yt-thumb").src = `https://img.youtube.com/vi/${currentVideoId}/hqdefault.jpg`;
        $("yt-eq").classList.add("show");
        updateNowTitle(nowPlaying.addedBy);
      }
    } else {
      currentVideoId = null;
      try {
        ytPlayer.stopVideo();
      } catch {}
      $("yt-thumb").removeAttribute("src");
      $("yt-title").textContent = "재생 중인 곡이 없어요";
      $("yt-by").textContent = "";
      $("yt-eq").classList.remove("show");
    }
  }

  function updateNowTitle(addedBy) {
    $("yt-by").textContent = addedBy ? `${addedBy}님 신청` : "";
    setTimeout(() => {
      let t = "♪ 재생 중";
      try {
        const d = ytPlayer.getVideoData();
        if (d && d.title) t = d.title;
      } catch {}
      $("yt-title").textContent = t;
    }, 900);
  }

  function renderQueue(queue) {
    $("queue-count").textContent = queue.length;
    const box = $("music-queue");
    if (!queue.length) {
      box.innerHTML =
        '<p class="text-sm text-light-subtext dark:text-dark-subtext">대기열이 비어있어요.</p>';
      return;
    }
    box.innerHTML = "";
    queue.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-2";
      row.innerHTML = `
        <span class="text-xs w-4 text-center text-light-subtext dark:text-dark-subtext">${i + 1}</span>
        <img src="https://img.youtube.com/vi/${it.videoId}/default.jpg" class="w-12 h-9 object-cover rounded flex-shrink-0" alt="" />
        <span class="text-xs flex-1 truncate">🎵 <b>${escapeHtml(it.addedBy || "게스트")}</b> 님 신청</span>`;
      box.appendChild(row);
    });
  }

  // YouTube IFrame API 준비되면 호출됨 (전역 콜백)
  window.onYouTubeIframeAPIReady = function () {
    ytPlayer = new YT.Player("yt-player", {
      width: "100%",
      height: "100%",
      playerVars: { autoplay: 1, playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          applyMusicMute();
          if (pendingMusic) {
            const p = pendingMusic;
            pendingMusic = null;
            applyMusic(p.nowPlaying, p.queue);
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && currentVideoId) {
            wsSend({ type: "music-ended", videoId: currentVideoId });
          }
        },
      },
    });
  };

  // ════════════════ 이벤트 ════════════════
  $("create-btn").onclick = () => createRoom();
  $("join-btn").onclick = () => joinRoom($("join-code").value);
  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom($("join-code").value);
  });
  $("refresh-rooms").onclick = () => refreshLobby();
  $("cam-toggle").onclick = () => toggleCamera();
  $("music-add").onclick = () => addSong();
  $("music-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSong();
  });
  $("music-skip").onclick = () => skipSong();
  $("music-mute").onclick = () => toggleMusicMute();
  $("leave-btn").onclick = () => {
    if (confirm("방에서 나갈까요?")) leaveRoom();
  };
  $("takeoff-btn").onclick = () => {
    if (!isHost) return;
    wsSend({ type: "start" });
    toast("🛫 이륙! 지금부터 집중 시작");
  };
  $("copy-code").onclick = () => {
    navigator.clipboard?.writeText(roomCode);
    toast("방 코드를 복사했어요");
  };
  $("copy-link").onclick = () => {
    const link = `${location.origin}${location.pathname}?room=${roomCode}`;
    navigator.clipboard?.writeText(link);
    toast("초대 링크를 복사했어요");
  };
  $("theme-toggle").onclick = () => {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.theme = dark ? "dark" : "light";
  };
  $("save-server").onclick = () => {
    const v = $("server-url").value.trim();
    if (v) {
      localStorage.setItem("sf_api", v);
      toast("백엔드 주소를 저장했어요");
      refreshLobby();
    }
  };

  // ── 초기화 ──
  $("server-url").value = apiBase();
  const params = new URLSearchParams(location.search);
  const invited = params.get("room");
  if (invited) {
    $("join-code").value = invited.toUpperCase();
    setTimeout(() => $("nickname").focus(), 100);
    toast("초대받은 방이에요! 닉네임 입력 후 입장하세요");
  }

  window.addEventListener("beforeunload", () => {
    try {
      if (ws) ws.close();
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    } catch {}
  });

  startLobbyPolling();
})();
