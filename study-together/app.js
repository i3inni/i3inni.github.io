/* ════════════════════════════════════════════════════════════════
   같이 공부 (Study Flight) — 프론트엔드
   백엔드(Spring Boot)와 통신:
     · REST  : 로비(공개 방 목록), 방 생성
     · WS    : /ws/signal — WebRTC 시그널링 + presence
     · WebRTC: 네이티브 RTCPeerConnection 풀메시 (카메라만)
   백엔드 주소: localhost에서 열면 로컬(:8080), 배포 사이트에선 Railway.
   ════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  // ── 백엔드 주소 ──
  // 우선순위: localStorage.sf_api(직접 지정) → localhost면 로컬 백엔드(:8080) → 배포 서버.
  // 배포(GitHub Pages)에서는 아래 도메인을 사용.
  const DEPLOY_API = "https://i3inni-study-together.onrender.com"; // Render(무료) + Neon(Postgres)

  function apiBase() {
    const saved = localStorage.getItem("sf_api");
    const onLocalhost = ["localhost", "127.0.0.1"].includes(location.hostname);
    // 라이브 사이트인데 저장된 주소가 localhost면 무시(예전 로컬 테스트 잔재 자동 치유)
    const savedIsLocal = saved && /localhost|127\.0\.0\.1/.test(saved);
    if (saved && !(savedIsLocal && !onLocalhost)) return saved.replace(/\/+$/, "");
    // 로컬에서 열면 로컬 백엔드 (배포 서버를 쓰고 싶으면 localStorage.sf_api로 덮어쓰기)
    if (onLocalhost) return `http://${location.hostname}:8080`;
    if (DEPLOY_API) return DEPLOY_API.replace(/\/+$/, "");
    return "http://localhost:8080";
  }
  // 브라우저별 고정 ID (중복 입장 방지용 — 같은 브라우저의 다른 탭과 동일)
  function clientId() {
    let id = localStorage.getItem("sf_client");
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || "c" + Date.now() + Math.random().toString(36).slice(2);
      localStorage.setItem("sf_client", id);
    }
    return id;
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
    {
      // ExpressTURN 무료 TURN (다른 네트워크 간 영상 중계)
      urls: [
        "turn:free.expressturn.com:3478",
        "turn:free.expressturn.com:3478?transport=tcp",
      ],
      username: "000000002096372215",
      credential: "WQQ3WtFYdMTa1erC93yTBLkDuMI=",
    },
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
  let busy = false; // 입장/생성 처리 중 (중복 클릭 방지 — 멱등성)
  let joinPassword = "";

  // 같은 브라우저 다른 탭이 이미 방에 있는지 감지 (중복 입장 방지를 깔끔하게)
  let bc = null;
  try {
    bc = new BroadcastChannel("sf_tabs");
    bc.onmessage = (e) => {
      if (e.data === "in-room?" && (inRoom || soloFlying())) bc.postMessage("in-room!");
    };
  } catch {}
  function anotherTabInRoom() {
    return new Promise((resolve) => {
      if (!bc) return resolve(false);
      let found = false;
      const h = (e) => {
        if (e.data === "in-room!") found = true;
      };
      bc.addEventListener("message", h);
      bc.postMessage("in-room?");
      setTimeout(() => {
        bc.removeEventListener("message", h);
        resolve(found);
      }, 200);
    });
  }

  // 카메라 / 음악
  let camOn = true;
  let musicMuted = false; // 개인별 음소거 (로컬)
  let ytPlayer = null;
  let ytReady = false;
  let ytApiLoading = false;
  let currentVideoId = null;
  let pendingMusic = null; // 플레이어 준비 전 도착한 상태

  const pcs = {}; // peerId → RTCPeerConnection
  const peerNames = {}; // peerId → name
  const remoteStreams = {}; // peerId → MediaStream
  const pendingIce = {}; // peerId → [candidate,...] (remoteDescription 전 버퍼)
  const peerCam = {}; // peerId → false 이면 카메라 꺼짐 (꺼진 트랙은 검은 화면이라 상태를 따로 받음)
  const tileEls = {}; // id → {root, pane, video, label, badge, empty}
  // 좌석 배정용 입장 순서 (id → 순번). 좌석번호 12A,12B,12C,13A…
  const joinSeq = {};
  let joinSeqN = 0;
  function seatOrder(id) {
    if (!(id in joinSeq)) joinSeq[id] = joinSeqN++;
    return joinSeq[id];
  }
  function resetSeats() {
    for (const k in joinSeq) delete joinSeq[k];
    joinSeqN = 0;
  }
  function seatLabel(i) {
    return `${12 + Math.floor(i / 3)}${"ABC"[i % 3]}`;
  }

  let timerInt = null;
  let lobbyInt = null;

  // ════════════════ 유틸 ════════════════
  // lucide 아이콘 (stroke SVG) — 템플릿 문자열에서 사용
  const ICONS = {
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bellOff:
      '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
    video: '<path d="m16 13 5.2 3.1a.5.5 0 0 0 .8-.4V8.3a.5.5 0 0 0-.8-.4L16 11"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
    videoOff:
      '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.25-3.06A.5.5 0 0 1 22 7.87v8.2"/><path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/><path d="m2 2 20 20"/>',
    volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>',
    volumeX: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    play: '<path d="M6 3l14 9-14 9V3z"/>',
  };
  function icon(name, size = 16, cls = "") {
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  }
  // 편명/방 코드 → 플립 칸
  function flipChars(code, small) {
    return String(code || "")
      .split("")
      .map((c) => `<span class="flip${small ? " flip-sm" : ""}">${escapeHtml(c)}</span>`)
      .join("");
  }

  let toastT;
  function toast(msg) {
    // 서버/기존 문구의 이모지는 걸러서 표시 (아이콘은 SVG만 사용)
    toastEl.textContent = String(msg)
      .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
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
      camOn = true;
      return true;
    } catch (e) {
      // 권한 거부/카메라 없음 → 카메라 꺼진 채로 진행 (입장은 가능)
      localStream = null;
      camOn = false;
      return false;
    }
  }

  // ── 탑승할 때 카메라 (로비 스위치, 이 브라우저에 기억) ──
  let camPref = localStorage.getItem("sf_cam_pref") !== "off";
  function updateCamPref() {
    const b = $("cam-pref");
    if (!b) return;
    b.setAttribute("aria-checked", String(camPref));
    b.querySelector(".cam-switch-text").textContent = camPref ? "ON" : "OFF";
  }
  function toggleCamPref() {
    camPref = !camPref;
    localStorage.setItem("sf_cam_pref", camPref ? "on" : "off");
    updateCamPref();
  }
  // 입장 직전 카메라 준비: OFF를 골랐으면 권한 요청 없이 꺼진 채 탑승 (방 안에서 언제든 켤 수 있음)
  async function prepareMedia(rejoin) {
    if (!camPref) {
      localStream = null;
      camOn = false;
      return;
    }
    if (!(await getMedia()))
      toast(rejoin ? "카메라 없이 다시 입장해요" : "카메라 없이 입장해요 (나중에 켤 수 있어요)");
  }

  // ════════════════ 로비 (공개 방 목록) ════════════════
  let lobbyWs = null;

  function renderRooms(rooms) {
    const box = $("room-list");
    const count = $("room-count");
    if (count) count.textContent = rooms ? rooms.length : 0;
    if (!rooms || !rooms.length) {
      box.innerHTML =
        '<p class="px-6 py-8 text-sm text-subtext text-center">열려있는 방이 없어요. 먼저 만들어보세요!</p>';
      return;
    }
    box.innerHTML = "";
    rooms.forEach((r) => {
      const flying = r.status === "FLYING";
      const [status, statusCls] = flying
        ? ["IN FLIGHT", "bg-accent-soft text-accent"]
        : r.locked
          ? ["PRIVATE", "bg-card-2 text-subtext"]
          : ["BOARDING", "bg-ok-soft text-ok"];
      // 행 전체가 탑승 버튼 (xl↑ 표 / 그 아래 카드형 — style.css .board-row)
      const row = document.createElement("button");
      row.type = "button";
      row.className =
        "join-room board-row w-full text-left px-4 sm:px-6 py-3.5 border-t border-line-soft first:border-t-0 hover:bg-card/60 transition";
      row.innerHTML = `
          <span class="order-1 xl:order-none flex gap-[3px]">${flipChars(r.code)}</span>
          <span class="order-3 xl:order-none basis-full xl:basis-auto text-[15px] font-medium truncate">${escapeHtml(r.departure)} → ${escapeHtml(r.destination)}</span>
          <span class="order-4 xl:order-none flex-1 min-w-0 flex items-center gap-2 text-[15px] text-text/80">${
            r.locked ? icon("lock", 14, "shrink-0 text-subtext") : ""
          }<span class="truncate">${escapeHtml(r.title)}</span></span>
          <span class="order-5 xl:order-none font-mono text-[15px] text-text/80">${r.durationMinutes}분</span>
          <span class="order-6 xl:order-none font-mono text-[15px] text-text/80">${r.participantCount}명</span>
          <span class="order-2 xl:order-none ml-auto xl:ml-0 justify-self-start inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-md font-mono text-xs font-semibold tracking-[0.08em] ${statusCls}">${
            r.locked && !flying ? icon("lock", 12) : ""
          }${status}</span>`;
      row.onclick = () => joinRoom(r.code);
      box.appendChild(row);
    });
  }

  // 무료 서버는 한동안 요청이 없으면 잠들고, 깨는 데 최대 1분 정도 걸림.
  // 첫 응답 전까지는 에러 대신 "깨우는 중"을 보여주고 폴링으로 계속 재시도한다.
  const pageLoadedAt = Date.now();
  const WAKE_GRACE_MS = 90000;
  let serverUp = false;
  function markServerUp() {
    if (serverUp) return;
    serverUp = true;
    loadHistory(); // 깨기 전에 실패했던 기록도 다시 불러옴
  }
  function stillWaking() {
    return !serverUp && Date.now() - pageLoadedAt < WAKE_GRACE_MS;
  }
  const WAKING_HTML = (cls) =>
    `<p class="${cls} text-sm text-subtext"><span class="text-accent font-semibold">서버를 깨우는 중이에요…</span><br />무료 서버라 첫 접속에 최대 1분 정도 걸려요.</p>`;

  async function refreshLobby() {
    const box = $("room-list");
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(apiBase() + "/api/rooms", { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error("bad status");
      renderRooms(await res.json());
      markServerUp();
    } catch (e) {
      box.innerHTML = stillWaking()
        ? WAKING_HTML("px-6 py-8 text-center")
        : `<p class="px-6 py-8 text-sm text-danger-fg text-center">서버에 연결할 수 없어요. (${escapeHtml(apiBase())})</p>`;
    }
  }

  // 로비 실시간 푸시 (방 생성/삭제/입장/이륙 즉시 반영)
  function connectLobbyWs() {
    try {
      if (lobbyWs) lobbyWs.close();
    } catch {}
    const url = apiBase().replace(/^http/, "ws") + "/ws/lobby";
    lobbyWs = new WebSocket(url);
    lobbyWs.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "rooms") {
          renderRooms(m.rooms);
          markServerUp();
        }
      } catch {}
    };
    lobbyWs.onclose = () => {
      lobbyWs = null;
      if (!inRoom) setTimeout(() => { if (!inRoom) connectLobbyWs(); }, 3000);
    };
    lobbyWs.onerror = () => {};
  }

  function startLobbyPolling() {
    loadHistory();
    refreshLobby(); // 즉시 1회 = "새로고침" 동작
    connectLobbyWs(); // 실시간 푸시
    // 콜드스타트/첫 호출 누락 대비 여러 번 확실히 재시도
    [300, 1500, 4000].forEach((d) =>
      setTimeout(() => {
        if (!inRoom) refreshLobby();
      }, d)
    );
    if (lobbyInt) clearInterval(lobbyInt);
    // WS가 끊겨있을 때만 폴백 폴링
    lobbyInt = setInterval(() => {
      if (!lobbyWs || lobbyWs.readyState !== WebSocket.OPEN) refreshLobby();
    }, 6000);
  }

  function stopLobbyPolling() {
    if (lobbyInt) clearInterval(lobbyInt);
    lobbyInt = null;
    try {
      if (lobbyWs) lobbyWs.close();
    } catch {}
    lobbyWs = null;
  }

  // ════════════════ 방 생성 (방장) ════════════════
  async function createRoom() {
    if (busy || inRoom) return; // 멱등성: 여러 번 눌러도 1번만
    myName = $("nickname").value.trim();
    if (!myName) return toast("닉네임을 입력해주세요");
    busy = true;
    try {
      if (await anotherTabInRoom())
        return toast("이미 다른 탭/창에서 같이 공부에 들어가 있어요. 그 창을 쓰거나 닫아주세요.");

      const body = {
        title: $("r-title").value.trim() || "같이 공부 비행",
        hostName: myName,
        departure: $("r-from").value.trim() || "출발지",
        destination: $("r-to").value.trim() || "목적지",
        durationMinutes: Math.min(600, Math.max(1, parseInt($("r-duration").value || "50", 10))),
        password: $("r-password").value.trim(),
      };

      // 카메라 시도 (거부/없어도 입장은 진행 — 카메라 꺼진 채)
      await prepareMedia(false);

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
    } finally {
      busy = false;
    }
  }

  // ════════════════ 방 입장 (참가자) ════════════════
  async function joinRoom(code) {
    if (busy || inRoom) return; // 멱등성: 여러 번 눌러도 1번만
    myName = $("nickname").value.trim();
    if (!myName) return toast("닉네임을 입력해주세요");
    code = (code || "").trim().toUpperCase();
    if (!code) return toast("방 코드를 입력해주세요");
    busy = true;
    try {
      if (await anotherTabInRoom())
        return toast("이미 다른 탭/창에서 같이 공부에 들어가 있어요. 그 창을 쓰거나 닫아주세요.");

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
        password = prompt("비밀번호를 입력하세요");
        if (password === null) return; // 취소
      }

      await prepareMedia(false);
      isHost = false;
      roomCode = code;
      joinPassword = password;
      meta = { code, title: "입장 중…", departure: "", destination: "", durationMinutes: 0, status: "WAITING", startedAt: null };
      connectWs();
    } finally {
      busy = false;
    }
  }

  // ════════════════ WebSocket 시그널링 ════════════════
  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  let pingInt = null;
  let reconnectAttempts = 0;

  function connectWs() {
    reconnectAttempts = 0;
    enterRoom();
    openWs();
  }

  function openWs() {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      reconnectAttempts = 0;
      wsSend({
        type: "join",
        roomCode,
        name: myName,
        password: joinPassword || "",
        clientId: clientId(),
        camOn: camOn && !!localStream,
      });
      // 유휴 연결이 프록시에 끊기지 않도록 주기적 핑
      clearInterval(pingInt);
      pingInt = setInterval(() => wsSend({ type: "ping" }), 25000);
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
      clearInterval(pingInt);
      console.warn("[ws closed] code=", ev.code, "reason=", ev.reason);
      if (inRoom) scheduleReconnect();
    };
    ws.onerror = () => {
      console.warn("[ws error] url=", wsUrl());
    };
  }

  // 끊기면 같은 방으로 끈질기게 재접속 (서버 재배포 2~3분도 버티도록)
  function scheduleReconnect() {
    if (!inRoom) return;
    reconnectAttempts++;
    // 자동으로 로비로 튕기지 않음 — 끊겨도 계속 재접속(나가기는 사용자가 직접)
    if (reconnectAttempts === 1) toast("연결이 끊겨 재접속 중…");
    // 재접속 시 새 세션 → 기존 피어 정리
    Object.values(pcs).forEach((pc) => {
      try {
        pc.close();
      } catch {}
    });
    for (const k in pcs) delete pcs[k];
    for (const k in remoteStreams) delete remoteStreams[k];
    for (const k in peerNames) delete peerNames[k];
    for (const k in pendingIce) delete pendingIce[k];
    for (const k in peerCam) delete peerCam[k];
    resetSeats();
    renderTiles();
    const delay = Math.min(1000 + reconnectAttempts * 400, 5000); // 백오프(최대 5s)
    setTimeout(() => {
      if (inRoom) openWs();
    }, delay);
  }

  function handleSignal(msg) {
    switch (msg.type) {
      case "joined":
        selfId = msg.selfId;
        (msg.peers || []).forEach((p) => seatOrder(p.id));
        seatOrder(selfId);
        meta = msg.meta;
        isHost = msg.hostSessionId === selfId; // 서버가 정한 방장
        toast("방에 입장했어요");
        applyMeta();
        renderTiles();
        // 내가 새로 들어왔으니 기존 참가자들에게 내가 offer를 건다
        (msg.peers || []).forEach((p) => {
          peerNames[p.id] = p.name;
          peerCam[p.id] = p.camOn !== false;
          callPeer(p.id);
        });
        renderTiles(); // 영상이 오기 전에도 기존 탑승객 창문 표시
        applyMusic(msg.nowPlaying, msg.playlist, msg.shuffle);
        break;
      case "host":
        // 방장 위임됨
        isHost = msg.sessionId === selfId;
        if (meta) meta.hostName = msg.name;
        if (isHost) toast("방장이 되었어요");
        applyMeta();
        renderTiles();
        break;
      case "music-state":
        applyMusic(msg.nowPlaying, msg.playlist, msg.shuffle);
        break;
      case "cam":
        peerCam[msg.id] = !!msg.on;
        renderTiles();
        break;
      case "chat":
        appendChat(msg.name, msg.text);
        break;
      case "ding":
        appendSystem(`${msg.name}님이 띵동을 울렸어요`, "ding");
        if (dingMuted) break; // 이 참여자가 띵동 알림을 끔
        toast(`${msg.name}님이 띵동! 채팅 확인해보세요`);
        playDing();
        break;
      case "peer-join":
        // 새 사람이 들어옴 → 그가 나에게 offer 할 것. 이름만 기록.
        peerNames[msg.id] = msg.name;
        peerCam[msg.id] = msg.camOn !== false;
        seatOrder(msg.id);
        toast(`${msg.name}님이 입장했어요`);
        appendSystem(`${msg.name}님이 탑승했어요`);
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
      case "state": {
        const wasFlying = meta && meta.status === "FLYING";
        meta = msg.meta;
        if (meta.status === "FLYING" && !wasFlying) appendSystem("이륙했어요. 좋은 비행 되세요");
        applyMeta();
        break;
      }
      case "error":
        inRoom = false; // 에러로 종료 → 자동 재접속 막기(강제 퇴장 핑퐁 방지)
        toast(msg.message || "오류가 발생했어요");
        setTimeout(() => leaveRoom(), 1200);
        break;
    }
  }

  // ════════════════ WebRTC ════════════════
  function makePeer(peerId) {
    if (pcs[peerId]) return pcs[peerId];
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcs[peerId] = pc;
    pendingIce[peerId] = pendingIce[peerId] || [];

    // 카메라가 있으면 트랙 추가, 없으면(권한 거부) 수신만
    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    // 카메라 없이 탑승해도 상대 영상은 받아야 함 — 수신 전용 video를 협상에 포함
    // (나중에 카메라를 켜면 addTrack이 이 transceiver를 재사용해 송수신으로 바뀜)
    else pc.addTransceiver("video", { direction: "recvonly" });

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
        if (tile && !remoteStreams[peerId]) setSeatPane(tile, peerNames[peerId] || "친구", "연결 실패", false);
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
    delete peerCam[id];
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
    return ids.sort((a, b) => seatOrder(a) - seatOrder(b)); // 입장 순서 = 좌석 순서
  }

  // 창문형 좌석: 바깥 창틀(.seat-window) + 안쪽 유리(.seat-pane)
  function createTile() {
    const root = document.createElement("div");
    root.className = "seat-window";
    const pane = document.createElement("div");
    pane.className = "seat-pane";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // 스피커 OFF
    const empty = document.createElement("div");
    empty.className = "seat-initial";
    const label = document.createElement("div");
    label.className = "seat-label";
    const badge = document.createElement("div");
    badge.className = "seat-badge";
    badge.textContent = "CAPTAIN";
    badge.style.display = "none";
    pane.append(video, empty, label, badge);
    root.append(pane);
    return { root, pane, video, label, badge, empty };
  }

  // 영상이 없을 때 창문 안: 이니셜 + 상태 문구
  function setSeatPane(tile, name, caption, isMe) {
    tile.empty.className = "seat-initial" + (isMe ? " is-me" : "");
    tile.empty.innerHTML = `<b>${escapeHtml(Array.from(name || "?")[0] || "?")}</b><small>${escapeHtml(caption)}</small>`;
    tile.empty.style.display = "flex";
    tile.video.style.visibility = "hidden";
  }

  function emptySeat(index) {
    const root = document.createElement("div");
    root.className = "seat-window seat-filler";
    root.innerHTML = `<div class="seat-pane is-empty"><span class="seat-label"><span class="seat-no">${seatLabel(index)}</span>빈 좌석</span></div>`;
    return root;
  }

  const VIDEO_PAGE_SIZE = 6;
  let videoPage = 0;
  let videoTotalPages = 1;

  function renderTiles() {
    const ids = participantIds();
    videoTotalPages = Math.max(1, Math.ceil(ids.length / VIDEO_PAGE_SIZE));
    videoPage = Math.min(Math.max(0, videoPage), videoTotalPages - 1);
    const visible = ids.slice(
      videoPage * VIDEO_PAGE_SIZE,
      videoPage * VIDEO_PAGE_SIZE + VIDEO_PAGE_SIZE
    );

    // 현재 페이지에 없는 타일은 DOM에서 제거 (연결/스트림은 유지)
    Object.keys(tileEls).forEach((id) => {
      if (!visible.includes(id)) {
        tileEls[id].root.remove();
        delete tileEls[id];
      }
    });
    const hostName = meta ? meta.hostName : null;
    grid.querySelectorAll(".seat-filler").forEach((el) => el.remove());
    visible.forEach((id, i) => {
      let tile = tileEls[id];
      if (!tile) {
        tile = createTile();
        tileEls[id] = tile;
      }
      grid.appendChild(tile.root);

      const isMe = id === selfId;
      const name = isMe ? myName : peerNames[id] || "친구";
      const seat = seatLabel(videoPage * VIDEO_PAGE_SIZE + i);
      tile.label.innerHTML = `<span class="seat-no">${seat}</span>${escapeHtml(isMe ? `${name} (나)` : name)}`;
      tile.badge.style.display = hostName && name === hostName ? "block" : "none";

      const stream = isMe ? localStream : remoteStreams[id];
      if (stream && tile.video.srcObject !== stream) tile.video.srcObject = stream;
      if (isMe ? !camOn || !localStream : peerCam[id] === false) {
        setSeatPane(tile, name, "카메라 꺼짐", isMe);
      } else if (stream) {
        tile.empty.style.display = "none";
        tile.video.style.visibility = "visible";
      } else {
        setSeatPane(tile, name, "연결 중…", isMe);
      }
    });
    // 남는 자리는 빈 좌석으로 채움 (한 페이지 6석)
    for (let k = visible.length; k < VIDEO_PAGE_SIZE; k++) {
      grid.appendChild(emptySeat(videoPage * VIDEO_PAGE_SIZE + k));
    }
    $("people-count").textContent = ids.length;

    // 페이지네이션 표시 (6명 초과 시)
    const pager = $("video-pager");
    if (videoTotalPages > 1) {
      pager.classList.remove("hidden");
      pager.classList.add("flex");
      $("vp-label").textContent = `${videoPage + 1} / ${videoTotalPages}`;
    } else {
      pager.classList.add("hidden");
      pager.classList.remove("flex");
    }
  }

  function applyMeta() {
    if (!meta) return;
    $("room-title").textContent = meta.title;
    $("room-from").textContent = meta.departure;
    $("room-to").textContent = meta.destination;
    const dur = $("room-duration");
    if (dur) dur.textContent = meta.durationMinutes || 0;

    const badge = $("room-status");
    const pill = "px-2.5 py-1 rounded-md font-mono text-xs font-semibold tracking-[0.1em] ";
    roomView.classList.remove("flying", "arrived");
    if (meta.status === "FLYING") {
      badge.textContent = "IN FLIGHT · 집중!";
      badge.className = pill + "bg-accent-soft text-accent";
      roomView.classList.add("flying");
    } else if (meta.status === "FINISHED") {
      badge.textContent = "LANDED · 수고했어요";
      badge.className = pill + "bg-card-2 text-text";
      roomView.classList.add("arrived");
    } else {
      badge.textContent = "BOARDING · 대기 중";
      badge.className = pill + "bg-ok-soft text-ok";
    }
    // 이륙 버튼: 방장 + 대기 중 / 다시 시작 버튼: 방장 + 도착
    $("takeoff-btn").classList.toggle("hidden", !(isHost && meta.status === "WAITING"));
    const rb = $("restart-btn");
    if (rb) rb.classList.toggle("hidden", !(isHost && meta.status === "FINISHED"));
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
    const pl = $("room-progress-label");
    if (pl)
      pl.textContent =
        meta.status === "FLYING" ? `${Math.floor(pct)}% · 순항 중` : meta.status === "FINISHED" ? "100% · 착륙" : "이륙 대기";
    $("room-timer").textContent = fmt(remain);
    $("flight-progress").style.width = pct + "%";
    $("flight-plane").style.left = pct + "%";
  }

  // ════════════════ 화면 전환 ════════════════
  // ── 세션 유지 (새로고침 시 같은 방 자동 재입장) ──
  const SESSION_KEY = "sf_session";
  function saveSession() {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ roomCode, name: myName, password: joinPassword || "" })
      );
    } catch {}
  }
  function clearSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {}
  }
  async function rejoinSaved() {
    let s = null;
    try {
      s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch {}
    if (!s || !s.roomCode || !s.name) {
      startLobbyPolling();
      return;
    }
    if (await anotherTabInRoom()) {
      clearSession();
      startLobbyPolling();
      return;
    }
    myName = s.name;
    const n = $("nickname");
    if (n) n.value = s.name;
    await prepareMedia(true);
    isHost = false;
    roomCode = s.roomCode;
    joinPassword = s.password || "";
    meta = { code: s.roomCode, title: "다시 입장 중…", departure: "", destination: "", durationMinutes: 0, status: "WAITING", startedAt: null };
    connectWs();
  }

  function enterRoom() {
    inRoom = true;
    saveSession();
    stopLobbyPolling();
    lobbyView.classList.add("hidden");
    roomView.classList.remove("hidden");
    $("room-code").innerHTML = flipChars(roomCode, true);
    updateCamBtn();
    updateDingMuteBtn();
    applyMeta();
    renderTiles();
    if (timerInt) clearInterval(timerInt);
    timerInt = setInterval(tick, 1000);
    window.scrollTo(0, 0);
  }

  function leaveRoom() {
    inRoom = false;
    clearSession(); // 직접 나가면 세션 지움(새로고침 재입장 안 함)
    reconnectAttempts = 0;
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
    if (pingInt) clearInterval(pingInt);
    pingInt = null;
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
    videoPage = 0;
    currentVideoId = null;
    pendingMusic = null;
    try {
      if (ytPlayer && ytReady) ytPlayer.stopVideo();
    } catch {}
    resetSeats();
    for (const k in pcs) delete pcs[k];
    for (const k in peerNames) delete peerNames[k];
    for (const k in remoteStreams) delete remoteStreams[k];
    for (const k in pendingIce) delete pendingIce[k];
    for (const k in peerCam) delete peerCam[k];
    Object.values(tileEls).forEach((t) => t.root.remove());
    for (const k in tileEls) delete tileEls[k];
    grid.innerHTML = "";
    $("chat-log").innerHTML = "";

    roomView.classList.add("hidden");
    lobbyView.classList.remove("hidden");
    startLobbyPolling();
  }

  // ════════════════ 혼자 비행 (싱글 타이머) ════════════════
  // 서버에 비행 기록(FLYING)을 만들고 타이머는 클라이언트에서. 도착/중도 하차 시 착륙 기록.
  // 탭을 닫으면 sendBeacon으로 착륙(=중도 하차), 새로고침하면 같은 비행에 재탑승.
  const SOLO_KEY = "sf_solo";
  const soloView = $("solo-view");
  let solo = null; // 서버 FlightLogResponse {id,status,departure,destination,plannedMinutes,focusedSeconds,startedAt,plannedEndAt}
  let soloInt = null;
  let soloHeartbeatInt = null;
  const baseTitle = document.title;

  function soloFlying() {
    return !!solo && solo.status === "FLYING";
  }
  function flightUrl(id, action) {
    return `${apiBase()}/api/flights/${id}/${action}?clientId=${encodeURIComponent(clientId())}`;
  }
  async function postFlight(id, action) {
    const res = await fetch(flightUrl(id, action), { method: "POST" });
    if (!res.ok) throw new Error(action + " failed");
    return res.json();
  }
  function saveSolo() {
    try {
      sessionStorage.setItem(SOLO_KEY, JSON.stringify(solo));
    } catch {}
  }
  function clearSolo() {
    try {
      sessionStorage.removeItem(SOLO_KEY);
    } catch {}
  }

  async function startSolo(again) {
    if (busy || inRoom || soloFlying()) return;
    const prev = again && solo ? solo : null;
    const body = {
      clientId: clientId(),
      nickname: $("nickname").value.trim() || "나",
      departure: prev ? prev.departure : $("s-from").value.trim() || "출발지",
      destination: prev ? prev.destination : $("s-to").value.trim() || "목적지",
      durationMinutes: prev
        ? prev.plannedMinutes
        : Math.min(600, Math.max(1, parseInt($("s-duration").value || "25", 10) || 25)),
    };
    busy = true;
    try {
      if (!prev && (await anotherTabInRoom()))
        return toast("이미 다른 탭/창에서 비행 중이에요. 그 창을 쓰거나 닫아주세요.");
      const res = await fetch(apiBase() + "/api/flights/solo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("solo failed");
      solo = await res.json();
    } catch (e) {
      return toast("이륙 실패 — 서버에 연결할 수 없어요");
    } finally {
      busy = false;
    }
    saveSolo();
    enterSolo();
    toast("이륙! 지금부터 집중 시작");
  }

  function enterSolo() {
    stopLobbyPolling();
    lobbyView.classList.add("hidden");
    soloView.classList.remove("hidden");
    $("solo-from").textContent = solo.departure;
    $("solo-to").textContent = solo.destination;
    $("solo-planned").textContent = solo.plannedMinutes;
    $("solo-dep-time").textContent = clock(solo.startedAt);
    $("solo-arr-time").textContent = clock(solo.plannedEndAt);
    $("solo-eta").textContent = clock(solo.plannedEndAt);
    clearInterval(soloInt);
    soloInt = setInterval(soloTick, 1000);
    // 재탑승 하트비트 — 새로고침 시 착륙 비콘과 재탑승 요청 순서가 꼬여도 1분 안에 복구
    clearInterval(soloHeartbeatInt);
    soloHeartbeatInt = setInterval(() => {
      if (soloFlying()) postFlight(solo.id, "resume").catch(() => {});
    }, 60000);
    applySoloView();
    window.scrollTo(0, 0);
  }

  function applySoloView() {
    if (!solo) return;
    const flying = solo.status === "FLYING";
    const badge = $("solo-status");
    soloView.classList.toggle("arrived", solo.status === "COMPLETED");
    soloView.classList.toggle("aborted", solo.status === "LEFT");
    const pill = "col-start-3 justify-self-end px-3 py-1.5 rounded-md font-mono text-xs font-semibold tracking-[0.1em] ";
    if (flying) {
      badge.textContent = "IN FLIGHT";
      badge.className = pill + "bg-accent-soft text-accent";
    } else if (solo.status === "COMPLETED") {
      badge.textContent = "LANDED · 도착";
      badge.className = pill + "bg-ok-soft text-ok";
    } else {
      badge.textContent = `중도 하차 · ${fmtDuration(solo.focusedSeconds)} 집중`;
      badge.className = pill + "bg-danger-soft text-danger-fg";
    }
    $("solo-timer-label").textContent = flying
      ? "도착까지 남은 시간"
      : solo.status === "COMPLETED"
        ? "도착 완료"
        : "남은 비행 시간";
    $("solo-abort-btn").classList.toggle("hidden", !flying);
    $("solo-again-btn").classList.toggle("hidden", flying);
    $("solo-exit-btn").classList.toggle("hidden", flying);
    soloTick();
  }

  function soloTick() {
    if (!solo) return;
    const total = Math.max(1, solo.plannedEndAt - solo.startedAt);
    let remain = 0;
    let pct = 100;
    let elapsed = total / 1000;
    if (solo.status === "FLYING") {
      const now = Date.now();
      remain = (solo.plannedEndAt - now) / 1000;
      elapsed = (now - solo.startedAt) / 1000;
      pct = Math.min(100, Math.max(0, ((now - solo.startedAt) / total) * 100));
      if (remain <= 0) return arriveSolo();
      document.title = `${fmt(remain)} · 혼자 비행`;
    } else if (solo.status === "LEFT") {
      pct = Math.min(100, ((solo.focusedSeconds * 1000) / total) * 100);
      remain = (solo.plannedEndAt - solo.startedAt) / 1000 - solo.focusedSeconds;
      elapsed = solo.focusedSeconds;
    }
    $("solo-timer").textContent = fmt(remain);
    $("solo-pct").textContent = Math.floor(pct) + "%";
    $("solo-elapsed").textContent = fmt(elapsed);
    placeSoloPlane(pct);
  }

  // 아크(Q 곡선) 위 진행률 → 진행선(dasharray) + 비행기 위치/방향
  function placeSoloPlane(pct) {
    soloPct = pct;
    placePlaneOnArc($("solo-progress"), $("solo-plane"), pct);
    updateSoloPip();
  }
  // 아크 path 위 진행률 → 진행선 + 비행기 위치/방향 (본 화면·PiP 창 공용)
  function placePlaneOnArc(path, plane, pct) {
    path.setAttribute("stroke-dasharray", `${pct} 100`); // pathLength="100"
    try {
      const len = path.getTotalLength();
      const at = (len * pct) / 100;
      const p = path.getPointAtLength(at);
      const a = path.getPointAtLength(Math.max(0, at - 1));
      const b = path.getPointAtLength(Math.min(len, at + 1));
      const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      const vb = path.ownerSVGElement.viewBox.baseVal; // 본 화면 1000×250 · PiP 1000×115
      plane.style.left = (p.x / vb.width) * 100 + "%";
      plane.style.top = (p.y / vb.height) * 100 + "%";
      plane.firstElementChild.style.transform = `rotate(${deg + 45}deg)`; // 아이콘 기본 방향 = 45°
    } catch {}
  }
  function clock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function arriveSolo() {
    if (!soloFlying()) return;
    solo.status = "COMPLETED";
    solo.focusedSeconds = Math.round((solo.plannedEndAt - solo.startedAt) / 1000);
    clearSolo();
    document.title = "도착! · 혼자 비행";
    applySoloView();
    playDing();
    toast(`${solo.destination} 도착! 수고했어요`);
    try {
      solo = await postFlight(solo.id, "land");
      applySoloView();
    } catch {} // 실패해도 서버 정리 작업이 도착 처리함
  }

  async function abortSolo() {
    if (!soloFlying()) return;
    if (!confirm("중도 하차할까요? 기록에 중도 하차로 남아요.")) return;
    const id = solo.id;
    solo.status = "LEFT";
    solo.focusedSeconds = Math.round((Date.now() - solo.startedAt) / 1000);
    clearSolo();
    document.title = baseTitle;
    applySoloView();
    try {
      solo = await postFlight(id, "land");
      applySoloView();
    } catch {
      toast("착륙 기록 전송 실패 — 잠시 후 기록을 확인해주세요");
    }
  }

  // ════════════════ 혼자 비행 PiP (진행도만 작은 창으로) ════════════════
  // 크롬/엣지: Document PiP(실제 HTML) · 사파리 등: 캔버스 → 영상 PiP · 둘 다 없으면 버튼 숨김
  const PLANE_PATH =
    "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z";
  // PiP는 낮고 넓은 창에 맞게 본 화면보다 납작한 아크 (viewBox 1000×115)
  const PIP_ARC = { d: "M40 100 Q500 -60 960 100", w: 1000, h: 115, p0: [40, 100], p1: [500, -60], p2: [960, 100] };
  let soloPct = 0;
  let pipWin = null; // Document PiP 창
  let pipVideo = null; // 영상 PiP 대체용
  let pipCanvas = null;
  const docPipSupported = "documentPictureInPicture" in window;
  const videoPipSupported =
    !!document.pictureInPictureEnabled && typeof HTMLCanvasElement.prototype.captureStream === "function";

  function pipOpen() {
    return !!(pipWin && !pipWin.closed) || !!pipVideo;
  }
  function updatePipBtn() {
    const b = $("solo-pip-btn");
    if (!b) return;
    const open = pipOpen();
    b.classList.toggle("is-on", open);
    b.setAttribute("aria-pressed", String(open));
    b.title = open ? "PiP 닫기" : "진행도 PiP로 띄우기";
    b.setAttribute("aria-label", b.title);
  }

  async function toggleSoloPip() {
    if (!solo) return;
    if (pipOpen()) return closeSoloPip();
    try {
      if (docPipSupported) await openDocPip();
      else if (videoPipSupported) await openVideoPip();
    } catch (e) {
      closeSoloPip();
      toast("PiP를 열 수 없어요");
    }
    updatePipBtn();
  }

  async function openDocPip() {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 560, height: 220 });
    const d = pipWin.document;
    const base = d.createElement("base");
    base.href = document.baseURI; // 폰트 등 상대경로(url(fonts/…)) 해석용
    d.head.appendChild(base);
    // 본 페이지 스타일(테일윈드·style.css·폰트)과 테마를 그대로 복사
    [...document.styleSheets].forEach((ss) => {
      try {
        const st = d.createElement("style");
        st.textContent = [...ss.cssRules].map((r) => r.cssText).join("\n");
        d.head.appendChild(st);
      } catch {
        if (ss.href) {
          const l = d.createElement("link");
          l.rel = "stylesheet";
          l.href = ss.href;
          d.head.appendChild(l);
        }
      }
    });
    d.documentElement.className = document.documentElement.className;
    d.title = "혼자 비행";
    d.body.className = "pip-body";
    d.body.innerHTML = `
      <div id="solo-pip" class="pip-root">
        <div class="pip-arc">
          <svg viewBox="0 0 ${PIP_ARC.w} ${PIP_ARC.h}" fill="none" aria-hidden="true">
            <path d="${PIP_ARC.d}" class="pip-dash" stroke-width="4" stroke-dasharray="10 14" />
            <path id="pip-progress" d="${PIP_ARC.d}" stroke-width="7" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100" />
            <circle cx="${PIP_ARC.p0[0]}" cy="${PIP_ARC.p0[1]}" r="12" class="pip-start" />
            <circle cx="${PIP_ARC.p2[0]}" cy="${PIP_ARC.p2[1]}" r="12" class="pip-end" stroke-width="4" />
          </svg>
          <div id="pip-plane" class="pip-plane">${$("solo-plane").innerHTML}</div>
        </div>
        <div class="pip-ends">
          <div><b id="pip-from"></b><small><span id="pip-dep"></span> 출발</small></div>
          <div class="is-end"><b id="pip-to"></b><small><span id="pip-arr"></span> 도착 예정</small></div>
        </div>
        <div id="pip-timer" class="pip-timer">--:--</div>
      </div>`;
    pipWin.addEventListener("pagehide", () => {
      pipWin = null;
      updatePipBtn();
    });
    updateSoloPip();
  }

  async function openVideoPip() {
    pipCanvas = document.createElement("canvas");
    pipCanvas.width = 720; // PiP 창 비율(약 2.5:1)과 동일
    pipCanvas.height = 280;
    drawPipCanvas();
    pipVideo = document.createElement("video");
    pipVideo.muted = true;
    pipVideo.playsInline = true;
    pipVideo.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;";
    document.body.appendChild(pipVideo);
    pipVideo.srcObject = pipCanvas.captureStream();
    await pipVideo.play();
    pipVideo.addEventListener("leavepictureinpicture", () => closeSoloPip());
    await pipVideo.requestPictureInPicture();
  }

  function closeSoloPip() {
    if (pipWin && !pipWin.closed) pipWin.close();
    pipWin = null;
    if (pipVideo) {
      const v = pipVideo;
      pipVideo = null;
      if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(() => {});
      try {
        v.srcObject && v.srcObject.getTracks().forEach((t) => t.stop());
      } catch {}
      v.remove();
    }
    pipCanvas = null;
    updatePipBtn();
  }

  // 매 tick: PiP 창에도 같은 진행도 반영
  function updateSoloPip() {
    if (!solo) return;
    if (pipWin && !pipWin.closed) {
      const d = pipWin.document;
      const root = d.getElementById("solo-pip");
      if (!root) return;
      placePlaneOnArc(d.getElementById("pip-progress"), d.getElementById("pip-plane"), soloPct);
      d.getElementById("pip-from").textContent = solo.departure;
      d.getElementById("pip-to").textContent = solo.destination;
      d.getElementById("pip-dep").textContent = clock(solo.startedAt);
      d.getElementById("pip-arr").textContent = clock(solo.plannedEndAt);
      d.getElementById("pip-timer").textContent = $("solo-timer").textContent;
      root.classList.toggle("arrived", solo.status === "COMPLETED");
      root.classList.toggle("aborted", solo.status === "LEFT");
      d.documentElement.className = document.documentElement.className; // 테마 전환 따라가기
    }
    if (pipVideo) drawPipCanvas();
  }

  // 영상 PiP용: Document PiP와 같은 배치(style.css .pip-*와 같은 u 단위)를 캔버스에 그림
  function drawPipCanvas() {
    if (!pipCanvas || !solo) return;
    const ctx = pipCanvas.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const col = (n) => `rgb(${css.getPropertyValue("--" + n).trim()})`;
    const tone = solo.status === "COMPLETED" ? col("ok") : solo.status === "LEFT" ? col("danger") : col("accent");
    const W = pipCanvas.width;
    const H = pipCanvas.height;
    const u = Math.min(W / 100, (H / 100) * 2.5);
    const padX = 4 * u;
    ctx.fillStyle = col("bg");
    ctx.fillRect(0, 0, W, H);

    // 아크 (진행률 → 베지어 t, 선 끝과 비행기 위치가 항상 일치)
    const s = (W - padX * 2) / PIP_ARC.w;
    const top = 3 * u;
    const bez = (t) => {
      const [a, b, c] = [PIP_ARC.p0, PIP_ARC.p1, PIP_ARC.p2];
      const m = 1 - t;
      return [m * m * a[0] + 2 * m * t * b[0] + t * t * c[0], m * m * a[1] + 2 * m * t * b[1] + t * t * c[1]];
    };
    const tEnd = Math.min(1, Math.max(0, soloPct / 100));
    ctx.save();
    ctx.translate(padX, top);
    ctx.scale(s, s);
    ctx.setLineDash([10, 14]);
    ctx.lineWidth = 4;
    ctx.strokeStyle = col("line");
    ctx.stroke(new Path2D(PIP_ARC.d));
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let t = 0; t <= tEnd; t += 0.01) {
      const [x, y] = bez(t);
      t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const [px, py] = bez(tEnd);
    ctx.lineTo(px, py);
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.strokeStyle = tone;
    ctx.stroke();
    ctx.fillStyle = col("accent");
    ctx.beginPath();
    ctx.arc(...PIP_ARC.p0, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col("bg");
    ctx.strokeStyle = col("subtext");
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(...PIP_ARC.p2, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // 비행기 (원 + 진행 방향으로 회전한 아이콘)
    const [ax, ay] = bez(Math.max(0, tEnd - 0.01));
    const [bx, by] = bez(Math.min(1, tEnd + 0.01));
    const deg = (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    const r = 2.9 * u;
    ctx.save();
    ctx.translate(padX + px * s, top + py * s);
    ctx.fillStyle = tone;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(((deg + 45) * Math.PI) / 180);
    const k = (r * 2 * (3.4 / 5.8)) / 24; // 아이콘 = 원 지름의 3.4/5.8 (Document PiP와 같은 비율)
    ctx.scale(k, k);
    ctx.translate(-12, -12);
    ctx.strokeStyle = solo.status === "FLYING" ? col("accent-ink") : "#fff";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(new Path2D(PLANE_PATH));
    ctx.restore();

    // 출발 / 도착 라벨
    const nameY = top + PIP_ARC.h * s + 5.2 * u;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = col("text");
    ctx.font = `700 ${4.2 * u}px Maplestory, 'IBM Plex Sans KR', sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(solo.departure, padX, nameY);
    ctx.textAlign = "right";
    ctx.fillText(solo.destination, W - padX, nameY);
    ctx.fillStyle = col("subtext");
    ctx.font = `500 ${2.3 * u}px 'IBM Plex Mono', Maplestory, 'IBM Plex Sans KR', monospace`;
    ctx.textAlign = "left";
    ctx.fillText(`${clock(solo.startedAt)} 출발`, padX, nameY + 3.2 * u);
    ctx.textAlign = "right";
    ctx.fillText(`${clock(solo.plannedEndAt)} 도착 예정`, W - padX, nameY + 3.2 * u);

    // 큰 타이머
    ctx.fillStyle = col("text");
    ctx.textAlign = "center";
    ctx.font = `600 ${11.5 * u}px 'IBM Plex Mono', monospace`;
    ctx.fillText($("solo-timer").textContent, W / 2, H - 2.6 * u);
  }

  function exitSolo() {
    if (soloFlying()) return;
    closeSoloPip();
    clearInterval(soloInt);
    clearInterval(soloHeartbeatInt);
    soloInt = soloHeartbeatInt = null;
    solo = null;
    clearSolo();
    document.title = baseTitle;
    soloView.classList.add("hidden");
    lobbyView.classList.remove("hidden");
    startLobbyPolling();
  }

  // 새로고침 → 저장된 혼자 비행에 재탑승 (서버 상태가 최종)
  async function resumeSavedSolo() {
    let s = null;
    try {
      s = JSON.parse(sessionStorage.getItem(SOLO_KEY) || "null");
    } catch {}
    if (!s || !s.id) {
      clearSolo();
      return startLobbyPolling();
    }
    solo = s;
    try {
      solo = await postFlight(s.id, "resume");
    } catch {
      if (Date.now() >= s.plannedEndAt) solo.status = "COMPLETED";
    }
    if (!soloFlying()) clearSolo();
    enterSolo();
  }

  // ════════════════ 내 비행 기록 ════════════════
  const STATUS_LABEL = {
    FLYING: ["비행 중", "bg-accent-soft text-accent"],
    COMPLETED: ["도착", "bg-ok-soft text-ok"],
    LEFT: ["중도 하차", "bg-danger-soft text-danger-fg"],
  };
  // 탑승객 참가 여부 칩 색
  const CREW_CLS = {
    FLYING: "bg-accent-soft text-accent",
    COMPLETED: "bg-ok-soft text-ok",
    LEFT: "bg-danger-soft text-danger-fg",
  };

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    if (sec < 60) return `${sec}초`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h}시간 ${m}분` : `${m}분`;
  }
  function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function loadHistory() {
    try {
      const res = await fetch(`${apiBase()}/api/flights?clientId=${encodeURIComponent(clientId())}&limit=30`);
      if (!res.ok) throw new Error("bad status");
      renderHistory(await res.json());
    } catch {
      const box = $("history-list");
      if (box) box.innerHTML = stillWaking() ? WAKING_HTML("") : '<p class="text-sm text-danger-fg">기록을 불러올 수 없어요.</p>';
    }
  }

  // 통계 칸용 짧은 시간 (12h 30m / 45m)
  function fmtHours(sec) {
    const m = Math.floor((sec || 0) / 60);
    const h = Math.floor(m / 60);
    return h ? `${h}h ${m % 60}m` : `${m}m`;
  }

  function renderHistory(h) {
    const stats = $("history-stats");
    const box = $("history-list");
    if (!stats || !box) return;
    const stat = (label, value, cls = "") => `
      <div class="p-3 rounded-[10px] bg-bg flex flex-col gap-1 min-w-0">
        <span class="text-xs text-subtext">${label}</span>
        <span class="font-mono text-lg sm:text-[22px] font-semibold truncate ${cls}">${value}</span>
      </div>`;
    const rate = h.totalFlights ? Math.round((h.completed / h.totalFlights) * 100) + "%" : "—";
    stats.innerHTML =
      stat("총 비행", `${h.totalFlights}회`) +
      stat("누적 시간", fmtHours(h.totalFocusedSeconds)) +
      stat("완주율", rate, "text-ok");

    if (!h.flights || !h.flights.length) {
      box.innerHTML = '<p class="text-sm text-subtext">아직 비행 기록이 없어요. 첫 비행을 떠나보세요!</p>';
      return;
    }
    box.innerHTML = h.flights
      .map((f) => {
        const [label, cls] = STATUS_LABEL[f.status] || STATUS_LABEL.LEFT;
        const group = f.mode === "GROUP";
        const mins =
          f.status === "COMPLETED" ? `${f.plannedMinutes}분` : `${Math.floor(f.focusedSeconds / 60)}/${f.plannedMinutes}분`;
        const who = group ? `함께 ${f.crew ? f.crew.length : 1}명` : "혼자";
        const crew =
          group && f.crew && f.crew.length
            ? `<div class="flex flex-wrap gap-1 mt-1.5">${f.crew
                .map(
                  (c) =>
                    `<span class="px-1.5 py-0.5 rounded text-[11px] font-medium ${CREW_CLS[c.status] || CREW_CLS.LEFT}" title="${
                      (STATUS_LABEL[c.status] || STATUS_LABEL.LEFT)[0]
                    }">${escapeHtml(c.nickname)}${c.lateBoarding ? " · 늦은 탑승" : ""}</span>`
                )
                .join("")}</div>`
            : "";
        return `
          <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center py-3 border-t border-line-soft first:border-t-0">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="text-[15px] font-medium truncate">${escapeHtml(f.departure || "")} → ${escapeHtml(f.destination || "")}${
                group ? ` <span class="text-sm font-normal text-subtext">· ${escapeHtml(f.title)}</span>` : ""
              }</span>
              <span class="font-mono text-xs text-subtext truncate">${fmtDate(f.startedAt)} · ${mins} · ${who}</span>${crew}
            </div>
            <span class="px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap ${cls}">${label}</span>
          </div>`;
      })
      .join("");
  }

  // ════════════════ 카메라 on/off ════════════════
  function updateCamBtn() {
    const btn = $("cam-toggle");
    const on = camOn && !!localStream;
    btn.innerHTML = `${icon(on ? "video" : "videoOff")}<span>${on ? "카메라 끄기" : "카메라 켜기"}</span>`;
    btn.classList.toggle("text-text/80", on);
    btn.classList.toggle("text-danger-fg", !on);
    btn.classList.toggle("border-line", on);
    btn.classList.toggle("border-danger", !on);
  }

  async function toggleCamera() {
    if (!localStream) {
      // 카메라가 없던 상태 → 권한 요청 후 켜고, 기존 연결에 트랙 추가(재협상)
      const ok = await getMedia();
      if (!ok || !localStream) {
        toast("카메라를 켤 수 없어요 (권한 확인)");
        return;
      }
      camOn = true;
      updateCamBtn();
      await addLocalTracksAndRenegotiate();
      renderTiles();
      wsSend({ type: "cam", on: true });
      return;
    }
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
    updateCamBtn();
    renderTiles();
    wsSend({ type: "cam", on: camOn }); // 상대 화면에 이니셜/영상 전환
  }

  // 늦게 카메라를 켰을 때: 모든 피어에 트랙 추가 후 새 offer로 재협상
  async function addLocalTracksAndRenegotiate() {
    for (const [peerId, pc] of Object.entries(pcs)) {
      try {
        localStream.getTracks().forEach((t) => {
          const exists = pc.getSenders().some((s) => s.track === t);
          if (!exists) pc.addTrack(t, localStream);
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsSend({ type: "offer", to: peerId, payload: offer });
      } catch (e) {
        console.warn("renegotiate error", e);
      }
    }
  }

  // ════════════════ 채팅 ════════════════
  function sendChat() {
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text) return;
    wsSend({ type: "chat", name: myName, text }); // 서버가 전원에 브로드캐스트(나 포함)
    input.value = "";
  }

  // ── 띵동(주목 알림) ──
  let audioCtx = null;
  function playDing() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const now = audioCtx.currentTime;
      [[880, 0], [660, 0.18]].forEach(([freq, t]) => {
        // 딩~동
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, now + t);
        g.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.35);
        o.connect(g).connect(audioCtx.destination);
        o.start(now + t);
        o.stop(now + t + 0.36);
      });
    } catch {}
  }
  function sendDing() {
    if (!inRoom) return;
    wsSend({ type: "ding", name: myName });
    toast("띵동! 모두에게 알렸어요");
    appendSystem("띵동을 울렸어요", "ding");
    playDing();
  }

  // 개인별 띵동 알림 받기 ON/OFF (로컬 저장)
  let dingMuted = localStorage.getItem("sf_ding_muted") === "1";
  function updateDingMuteBtn() {
    const b = $("ding-mute");
    if (!b) return;
    b.innerHTML = icon(dingMuted ? "bellOff" : "bell");
    b.title = dingMuted ? "띵동 알림 꺼짐 (클릭해 켜기)" : "띵동 알림 켜짐 (클릭해 끄기)";
    b.setAttribute("aria-label", b.title);
    b.classList.toggle("text-subtext", !dingMuted);
    b.classList.toggle("text-danger-fg", dingMuted);
  }
  function toggleDingMute() {
    dingMuted = !dingMuted;
    localStorage.setItem("sf_ding_muted", dingMuted ? "1" : "0");
    updateDingMuteBtn();
    toast(dingMuted ? "띵동 알림을 껐어요" : "띵동 알림을 켰어요");
  }

  // 이름 → 현재 좌석번호 (나간 사람이면 "")
  function seatOfName(name) {
    const ids = participantIds();
    const i = ids.findIndex((id) => (id === selfId ? myName : peerNames[id]) === name);
    return i < 0 ? "" : seatLabel(i);
  }

  function appendChat(name, text) {
    const log = $("chat-log");
    const isMe = name === myName;
    const seat = isMe ? "" : seatOfName(name);
    const row = document.createElement("div");
    row.className =
      (isMe ? "self-end items-end" : "self-start items-start") + " flex flex-col gap-1 max-w-[85%] sm:max-w-[280px]";
    row.innerHTML =
      (isMe
        ? ""
        : `<span class="text-xs text-subtext">${escapeHtml(name)}${seat ? ` · <span class="font-mono">${seat}</span>` : ""}</span>`) +
      `<span class="px-3.5 py-2.5 text-sm leading-normal break-words whitespace-pre-wrap ${
        isMe ? "rounded-[14px_4px_14px_14px] bg-accent text-accent-ink" : "rounded-[4px_14px_14px_14px] bg-card-2"
      }">${escapeHtml(text)}</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  // 시스템 메시지(입장·이륙·띵동) — 가운데 정렬 pill
  function appendSystem(text, kind) {
    const log = $("chat-log");
    if (!log) return;
    const row = document.createElement("div");
    if (kind === "ding") {
      row.className =
        "self-center inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent-soft text-accent text-xs font-bold";
      row.innerHTML = `${icon("bell", 12)}${escapeHtml(text)}`;
    } else {
      row.className =
        "self-center text-center px-3 py-1.5 rounded-full bg-bg font-mono text-[11px] tracking-[0.08em] text-subtext";
      row.textContent = `— ${text} —`;
    }
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
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
  }

  let playlistClipboardHtml = "";
  let importedPlaylistSongs = [];

  function decodeYouTubeText(value) {
    if (!value) return "";
    const textarea = document.createElement("textarea");
    textarea.innerHTML = value;
    const decoded = textarea.value;
    try {
      return JSON.parse(`"${decoded.replace(/"/g, '\\"')}"`);
    } catch {
      return decoded
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  }

  function extractPlaylistSongs(text, clipboardHtml) {
    const songs = [];
    const seen = new Set();
    const add = (videoId, title) => {
      if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId) || seen.has(videoId)) return;
      seen.add(videoId);
      songs.push({ videoId, title: (decodeYouTubeText(title) || "제목을 불러오는 중").trim() });
    };

    // 일반 페이지 복사 시 클립보드 HTML에 들어 있는 실제 재생목록 링크를 읽는다.
    if (clipboardHtml) {
      const doc = new DOMParser().parseFromString(clipboardHtml, "text/html");
      const anchors = [...doc.querySelectorAll('a[href*="watch"], a[href*="youtu.be/"]')];
      const playlistAnchors = anchors.filter((a) => /[?&]list=/.test(a.getAttribute("href") || ""));
      (playlistAnchors.length ? playlistAnchors : anchors).forEach((a) => {
        const href = a.getAttribute("href") || "";
        add(parseYouTubeId(href), a.getAttribute("title") || a.getAttribute("aria-label") || a.textContent);
      });
    }

    const source = String(text || "");

    // Ctrl+U 페이지 소스의 playlistVideoRenderer 블록에서 ID와 제목을 순서대로 추출한다.
    const markerPattern = /\\?"playlistVideoRenderer\\?"\s*:/g;
    let marker;
    while ((marker = markerPattern.exec(source))) {
      const chunk = source.slice(marker.index, marker.index + 6000);
      const idMatch = chunk.match(/\\?"videoId\\?"\s*:\s*\\?"([A-Za-z0-9_-]{11})\\?"/);
      if (!idMatch) continue;
      const titleStart = chunk.search(/\\?"title\\?"\s*:/);
      const titleChunk = titleStart >= 0 ? chunk.slice(titleStart, titleStart + 1800) : chunk;
      const titleMatch = titleChunk.match(/\\?"text\\?"\s*:\s*\\?"((?:\\.|[^"\\])*)\\?"/);
      add(idMatch[1], titleMatch ? titleMatch[1] : "");
    }

    // 직접 붙여넣은 watch/shorts/youtu.be 링크도 함께 지원한다.
    const urlPattern = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s"'<>]*?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})[^\s"'<>]*/g;
    let urlMatch;
    while ((urlMatch = urlPattern.exec(source))) add(urlMatch[1], "");

    return songs;
  }

  function renderPlaylistImport(songs) {
    importedPlaylistSongs = songs;
    const results = $("playlist-import-results");
    const list = $("playlist-import-list");
    const status = $("playlist-import-status");
    if (!results || !list || !status) return;

    if (!songs.length) {
      results.classList.add("hidden");
      list.innerHTML = "";
      status.textContent = "영상 링크를 찾지 못했어요. Ctrl+U 페이지 소스를 붙여넣으면 가장 정확해요.";
      return;
    }

    results.classList.remove("hidden");
    status.textContent = `${songs.length}곡을 찾았어요`;
    list.innerHTML = "";
    songs.forEach((song, index) => {
      if (song.title && song.title !== "제목을 불러오는 중") titleCache[song.videoId] = song.title;
      const row = document.createElement("label");
      row.className = "flex items-center gap-2 p-1.5 rounded-lg hover:bg-card-2 cursor-pointer";
      row.innerHTML = `
        <input type="checkbox" class="playlist-import-check accent-accent w-4 h-4 shrink-0" data-index="${index}" checked />
        <img src="https://img.youtube.com/vi/${song.videoId}/default.jpg" class="w-12 h-9 object-cover rounded shrink-0" alt="" />
        <span class="playlist-import-title min-w-0 text-xs truncate" data-video-id="${song.videoId}">${escapeHtml(song.title)}</span>`;
      list.appendChild(row);
      if (song.title === "제목을 불러오는 중") {
        getTitle(song.videoId);
      }
    });
  }

  function analyzePlaylistSource() {
    const input = $("playlist-source");
    const songs = extractPlaylistSongs(input ? input.value : "", playlistClipboardHtml);
    renderPlaylistImport(songs);
  }

  function setImportedPlaylistSelection(checked) {
    document.querySelectorAll(".playlist-import-check").forEach((el) => {
      el.checked = checked;
    });
  }

  function addSelectedPlaylistSongs() {
    const selected = [...document.querySelectorAll(".playlist-import-check:checked")]
      .map((el) => importedPlaylistSongs[Number(el.dataset.index)])
      .filter(Boolean);
    if (!selected.length) return toast("신청할 곡을 선택해주세요");

    const currentCount = lastMusic && lastMusic.playlist ? lastMusic.playlist.length : 0;
    const available = Math.max(0, 300 - currentCount);
    if (!available) return toast("플레이리스트가 가득 찼어요");
    const songs = selected.slice(0, available);
    wsSend({ type: "music-add-batch", videoIds: songs.map((song) => song.videoId), addedBy: myName });
    toast(`${songs.length}곡을 신청했어요`);
    if (songs.length < selected.length) toast(`남은 자리만큼 ${songs.length}곡을 신청했어요`);
  }

  function removeSong(videoId) {
    wsSend({ type: "music-remove", videoId });
  }

  function toggleShuffle() {
    wsSend({ type: "music-shuffle" });
  }

  function skipSong() {
    wsSend({ type: "music-skip" });
  }

  function toggleMusicMute() {
    musicMuted = !musicMuted;
    applyMusicMute();
    const b = $("music-mute");
    b.innerHTML = icon(musicMuted ? "volumeX" : "volume");
    b.title = musicMuted ? "내 소리 꺼짐" : "내 소리 켜짐";
    b.setAttribute("aria-label", b.title);
  }
  function applyMusicMute() {
    if (!ytReady) return;
    try {
      if (musicMuted) ytPlayer.mute();
      else ytPlayer.unMute();
    } catch {}
  }

  const titleCache = {}; // videoId -> 곡 제목 (noembed로 조회)
  let lastMusic = null;

  function applyMusic(nowPlaying, playlist, shuffle) {
    lastMusic = { nowPlaying, playlist: playlist || [], shuffle };
    renderPlaylist(playlist || [], nowPlaying, shuffle);
    if (nowPlaying && nowPlaying.videoId) ensureYouTube(); // 음악 있을 때만 유튜브 로드
    if (!ytReady) {
      pendingMusic = { nowPlaying, playlist, shuffle };
      return;
    }
    if (nowPlaying && nowPlaying.videoId) {
      $("yt-by").textContent = nowPlaying.addedBy ? `${nowPlaying.addedBy}님 신청` : "";
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
      }
      getTitle(currentVideoId);
      refreshNowTitle();
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

  // 유튜브 제목 조회 (noembed — CORS 허용) + 캐시. 로드되면 목록/재생중 갱신.
  function getTitle(videoId) {
    if (!videoId) return "";
    if (videoId in titleCache) return titleCache[videoId];
    titleCache[videoId] = ""; // 조회 중 표시(중복 요청 방지)
    fetch("https://noembed.com/embed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + videoId))
      .then((r) => r.json())
      .then((d) => {
        titleCache[videoId] = d && d.title ? d.title : "";
        onTitleLoaded();
      })
      .catch(() => {});
    return "";
  }

  // 제목이 여러 개 동시에 로드돼도 한 번만 다시 그리도록 묶음(디바운스)
  let titleRenderT = null;
  function onTitleLoaded() {
    refreshNowTitle();
    document.querySelectorAll(".playlist-import-title").forEach((el) => {
      const title = titleCache[el.dataset.videoId];
      if (title) el.textContent = title;
    });
    clearTimeout(titleRenderT);
    titleRenderT = setTimeout(() => {
      if (lastMusic) renderPlaylist(lastMusic.playlist, lastMusic.nowPlaying, lastMusic.shuffle);
    }, 150);
  }

  function refreshNowTitle() {
    if (!currentVideoId) {
      $("yt-title").textContent = "재생 중인 곡이 없어요";
      return;
    }
    let t = titleCache[currentVideoId];
    if (!t) {
      try {
        const d = ytPlayer.getVideoData();
        if (d && d.title) t = d.title;
      } catch {}
    }
    $("yt-title").textContent = t || "재생 중";
  }

  function renderPlaylist(playlist, nowPlaying, shuffle) {
    $("queue-count").textContent = playlist.length;
    const mine = playlist.filter((t) => t.addedBy === myName).length;
    const mc = $("my-song-count");
    if (mc) mc.textContent = mine;
    const sb = $("music-shuffle");
    if (sb) {
      sb.classList.toggle("is-on", !!shuffle);
      sb.title = shuffle ? "셔플 ON (다시 누르면 OFF)" : "셔플 OFF";
    }
    const box = $("music-queue");
    if (!playlist.length) {
      box.innerHTML =
        '<p class="py-3 text-sm text-subtext">아직 곡이 없어요. 유튜브 링크로 신청해보세요!</p>';
      return;
    }
    const curId = nowPlaying ? nowPlaying.videoId : null;
    box.innerHTML = "";
    playlist.forEach((it, n) => {
      const isCur = it.videoId === curId;
      const title = getTitle(it.videoId);
      const row = document.createElement("div");
      row.className = "grid grid-cols-[28px_minmax(0,1fr)_auto_auto] gap-2.5 items-center py-1 border-t border-line-soft first:border-t-0";
      row.innerHTML = `
        <span class="font-mono text-xs ${isCur ? "text-accent" : "text-muted"}">${isCur ? icon("play", 12) : String(n + 1).padStart(2, "0")}</span>
        <span class="text-sm truncate ${isCur ? "text-accent font-semibold" : ""}">${title ? escapeHtml(title) : "제목 불러오는 중…"}</span>
        <span class="text-xs text-subtext">${escapeHtml(it.addedBy || "게스트")}</span>`;
      const del = document.createElement("button");
      del.className =
        "w-11 h-11 rounded-[10px] flex items-center justify-center text-muted hover:text-danger-fg hover:bg-card-2 transition";
      del.innerHTML = icon("x", 14);
      del.title = "삭제";
      del.setAttribute("aria-label", "삭제");
      del.onclick = () => removeSong(it.videoId);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  // 유튜브 IFrame API를 처음 음악 재생이 필요할 때만 동적 로드 (성능)
  function ensureYouTube() {
    if (ytPlayer || ytReady || ytApiLoading) return;
    ytApiLoading = true;
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
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
            applyMusic(p.nowPlaying, p.playlist, p.shuffle);
          }
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED && currentVideoId) {
            wsSend({ type: "music-ended", videoId: currentVideoId });
          } else if (e.data === YT.PlayerState.PLAYING) {
            refreshNowTitle(); // 재생 시작 시 플레이어 제목으로도 보정
          }
        },
      },
    });
  };

  // ════════════════ 이벤트 (요소 없으면 건너뜀 — null-safe) ════════════════
  const on = (id, ev, fn) => {
    const el = $(id);
    if (el) el.addEventListener(ev, fn);
  };
  const enterKey = (fn) => (e) => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) fn();
  };

  on("create-btn", "click", () => createRoom());
  on("join-btn", "click", () => joinRoom($("join-code") && $("join-code").value));
  on("join-code", "keydown", enterKey(() => joinRoom($("join-code").value)));
  on("refresh-rooms", "click", () => refreshLobby());
  on("vp-prev", "click", () => {
    if (videoPage > 0) {
      videoPage--;
      renderTiles();
    }
  });
  on("vp-next", "click", () => {
    if (videoPage < videoTotalPages - 1) {
      videoPage++;
      renderTiles();
    }
  });
  on("cam-toggle", "click", () => toggleCamera());
  on("cam-pref", "click", () => toggleCamPref());
  updateCamPref();
  on("ding-btn", "click", () => sendDing());
  on("ding-mute", "click", () => toggleDingMute());
  on("music-add", "click", () => addSong());
  on("music-url", "keydown", enterKey(() => addSong()));
  on("playlist-source", "paste", (e) => {
    playlistClipboardHtml = e.clipboardData ? e.clipboardData.getData("text/html") : "";
  });
  on("playlist-analyze", "click", () => analyzePlaylistSource());
  on("playlist-select-all", "click", () => setImportedPlaylistSelection(true));
  on("playlist-select-none", "click", () => setImportedPlaylistSelection(false));
  on("playlist-add-selected", "click", () => addSelectedPlaylistSongs());
  on("music-skip", "click", () => skipSong());
  on("music-mute", "click", () => toggleMusicMute());
  on("music-shuffle", "click", () => toggleShuffle());
  on("chat-send", "click", () => sendChat());
  on("chat-input", "keydown", enterKey(() => sendChat()));
  on("leave-btn", "click", () => {
    if (confirm("방에서 나갈까요?")) leaveRoom();
  });
  on("takeoff-btn", "click", () => {
    if (!isHost) return;
    wsSend({ type: "start" });
    toast("이륙! 지금부터 집중 시작");
  });
  on("restart-btn", "click", () => {
    if (!isHost) return;
    const cur = meta && meta.durationMinutes ? meta.durationMinutes : 50;
    const v = prompt("다시 시작할 공부 시간(분)을 입력하세요", String(cur));
    if (v === null) return;
    const m = Math.min(600, Math.max(1, parseInt(v, 10) || 0));
    if (!m) return toast("올바른 시간(분)을 입력해주세요");
    wsSend({ type: "restart", durationMinutes: m });
    toast(`${m}분으로 다시 시작!`);
  });
  on("copy-code", "click", () => {
    navigator.clipboard?.writeText(roomCode);
    toast("방 코드를 복사했어요");
  });
  on("copy-link", "click", () => {
    const link = `${location.origin}${location.pathname}?room=${roomCode}`;
    navigator.clipboard?.writeText(link);
    toast("초대 링크를 복사했어요");
  });
  on("solo-start-btn", "click", () => startSolo(false));
  on("solo-again-btn", "click", () => startSolo(true));
  on("solo-abort-btn", "click", () => abortSolo());
  on("solo-exit-btn", "click", () => exitSolo());
  on("refresh-history", "click", () => loadHistory());
  // 프리셋 선택 표시 (입력값과 같은 프리셋 강조)
  function syncSoloPresets() {
    const v = String(parseInt($("s-duration").value, 10));
    document.querySelectorAll(".solo-preset").forEach((b) => b.classList.toggle("is-active", b.dataset.soloMin === v));
  }
  document.querySelectorAll(".solo-preset").forEach((b) =>
    b.addEventListener("click", () => {
      $("s-duration").value = b.dataset.soloMin;
      syncSoloPresets();
    })
  );
  on("s-duration", "input", () => syncSoloPresets());
  syncSoloPresets();
  // 상단 "터미널로": 비행 중이면 중도 하차 확인, 착륙 후면 로비로
  on("solo-back-btn", "click", () => (soloFlying() ? abortSolo() : exitSolo()));
  on("solo-pip-btn", "click", () => toggleSoloPip());
  if (docPipSupported || videoPipSupported) $("solo-pip-btn").classList.remove("hidden");
  on("theme-toggle", "click", () => {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.theme = dark ? "dark" : "light";
  });
  on("save-server", "click", () => {
    const el = $("server-url");
    const v = el ? el.value.trim() : "";
    if (v) {
      localStorage.setItem("sf_api", v);
      toast("백엔드 주소를 저장했어요");
      refreshLobby();
    }
  });

  // ── 초기화 ──
  const _serverUrlEl = $("server-url");
  if (_serverUrlEl) _serverUrlEl.value = apiBase();
  const params = new URLSearchParams(location.search);
  const invited = params.get("room");
  if (invited) {
    const _jc = $("join-code");
    if (_jc) _jc.value = invited.toUpperCase();
    setTimeout(() => {
      const n = $("nickname");
      if (n) n.focus();
    }, 100);
    toast("초대받은 방이에요! 닉네임 입력 후 입장하세요");
  }

  // 혼자 비행 중 탭을 닫으면 착륙(=중도 하차) 기록. 새로고침이면 resume으로 재탑승.
  window.addEventListener("pagehide", () => {
    if (soloFlying() && navigator.sendBeacon) navigator.sendBeacon(flightUrl(solo.id, "land"));
  });

  window.addEventListener("beforeunload", () => {
    try {
      if (ws) ws.close();
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    } catch {}
  });

  // 새로고침 시 저장된 방이 있으면 자동 재입장, 없으면 로비
  if (sessionStorage.getItem(SESSION_KEY)) {
    rejoinSaved();
  } else if (sessionStorage.getItem(SOLO_KEY)) {
    resumeSavedSolo();
  } else {
    startLobbyPolling();
  }
})();
