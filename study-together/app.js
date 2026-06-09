/* ════════════════════════════════════════════════════════════════
   같이 공부 (Study Flight) — PeerJS P2P 메시 화상 스터디
   ─ 방장(host): 고정 peer id = 방 코드. 명단(roster) 관리 + 브로드캐스트.
   ─ 참가자(guest): 랜덤 id. 방장에게 data 연결로 hello → state 수신.
   ─ 화상: 풀메시. "나중에 합류한 사람이 먼저 있던 사람에게 call" 규칙으로
     쌍마다 정확히 1번만 연결(중복 호출 방지).
   ─ 카메라만 공유(audio:false) / 원격 비디오 muted → 마이크·스피커 OFF 보장.
   ════════════════════════════════════════════════════════════════ */
(() => {
  "use strict";

  // PeerJS 공개 브로커 + Google/Twilio STUN (NAT 통과)
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:global.stun.twilio.com:3478" },
      ],
    },
  };

  // ── DOM ──
  const $ = (id) => document.getElementById(id);
  const lobbyView = $("lobby-view");
  const roomView = $("room-view");
  const grid = $("video-grid");
  const toastEl = $("toast");

  // ── 상태 ──
  let peer = null;
  let myId = null;
  let myName = "";
  let isHost = false;
  let roomCode = null;
  let localStream = null;
  let hostConn = null; // guest → host data conn
  const hostConns = {}; // host: guestId → data conn
  const calls = {}; // peerId → MediaConnection
  const remoteStreams = {}; // peerId → MediaStream
  const tileEls = {}; // peerId → {root, video, label, badge, empty}
  let roster = []; // [{id, name, host}]
  let meta = null; // {title, from, to, duration, startedAt, status}
  let timerInt = null;
  let arrivedFired = false;

  // ════════════════ 유틸 ════════════════
  let toastT;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  function genCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 문자 제외
    let c = "";
    for (let i = 0; i < 6; i++)
      c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  }

  async function getMedia() {
    try {
      // 카메라만! 오디오는 캡처하지 않음 → 마이크 OFF 보장
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      return true;
    } catch (e) {
      toast("카메라 권한이 필요해요 📷 (브라우저 설정 확인)");
      return false;
    }
  }

  // ════════════════ 로컬 저장 (내가 만든 방) ════════════════
  const LS_KEY = "sf_rooms";
  function loadRooms() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || [];
    } catch {
      return [];
    }
  }
  function saveRoom(r) {
    const rooms = loadRooms().filter((x) => x.code !== r.code);
    rooms.unshift(r);
    localStorage.setItem(LS_KEY, JSON.stringify(rooms.slice(0, 8)));
    renderMyRooms();
  }
  function deleteRoom(code) {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify(loadRooms().filter((x) => x.code !== code))
    );
    renderMyRooms();
  }
  function renderMyRooms() {
    const rooms = loadRooms();
    const box = $("my-rooms");
    if (!rooms.length) {
      box.innerHTML =
        '<p class="text-sm text-light-subtext dark:text-dark-subtext">아직 만든 방이 없어요.</p>';
      return;
    }
    box.innerHTML = "";
    rooms.forEach((r) => {
      const row = document.createElement("div");
      row.className =
        "flex items-center justify-between gap-2 p-3 rounded-xl bg-light-bg dark:bg-dark-bg border border-gray-200 dark:border-gray-700";
      row.innerHTML = `
        <div class="min-w-0">
          <p class="font-semibold text-sm truncate">${escapeHtml(r.title)}</p>
          <p class="text-xs text-light-subtext dark:text-dark-subtext truncate">
            ${escapeHtml(r.from)} → ${escapeHtml(r.to)} · ${r.duration}분 · <span class="font-mono text-primary">${r.code}</span>
          </p>
        </div>
        <div class="flex items-center gap-1 flex-shrink-0">
          <button class="rehost px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-semibold hover:bg-primary-hover transition">다시 열기</button>
          <button class="del px-2 py-1.5 rounded-lg bg-gray-200 dark:bg-gray-700 text-xs hover:opacity-80 transition" title="삭제">✕</button>
        </div>`;
      row.querySelector(".rehost").onclick = () => {
        myName = $("nickname").value.trim();
        if (!myName) return toast("닉네임을 먼저 입력해주세요");
        createRoom(r);
      };
      row.querySelector(".del").onclick = () => deleteRoom(r.code);
      box.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]
    );
  }

  // ════════════════ 방 생성 (방장) ════════════════
  async function createRoom(existing) {
    myName = $("nickname").value.trim();
    if (!myName) return toast("닉네임을 입력해주세요");

    const m = {
      title: ($("r-title").value || existing?.title || "같이 공부 비행").trim(),
      from: ($("r-from").value || existing?.from || "출발지").trim(),
      to: ($("r-to").value || existing?.to || "목적지").trim(),
      duration: Math.min(
        600,
        Math.max(1, parseInt($("r-duration").value || existing?.duration || 50, 10))
      ),
      startedAt: null,
      status: "waiting",
    };

    if (!(await getMedia())) return;

    isHost = true;
    roomCode = existing?.code || genCode();
    myId = roomCode;
    meta = m;

    peer = new Peer(roomCode, PEER_CONFIG);
    peer.on("open", () => {
      roster = [{ id: roomCode, name: myName, host: true }];
      saveRoom({ code: roomCode, ...m });
      enterRoom();
    });
    peer.on("connection", onHostConnection);
    peer.on("call", onIncomingCall);
    peer.on("error", onPeerError);
  }

  function onHostConnection(conn) {
    conn.on("open", () => {
      hostConns[conn.peer] = conn;
    });
    conn.on("data", (d) => {
      if (d && d.type === "hello") {
        if (!roster.some((r) => r.id === conn.peer))
          roster.push({ id: conn.peer, name: d.name || "친구", host: false });
        hostConns[conn.peer] = conn;
        broadcastState();
      }
    });
    conn.on("close", () => removePeer(conn.peer));
    conn.on("error", () => removePeer(conn.peer));
  }

  function broadcastState() {
    const payload = { type: "state", roster, meta };
    Object.values(hostConns).forEach((c) => {
      try {
        if (c.open) c.send(payload);
      } catch {}
    });
    // 방장 본인 화면도 갱신
    applyMeta();
    renderGrid();
  }

  // ════════════════ 방 입장 (참가자) ════════════════
  async function joinRoom(code) {
    myName = $("nickname").value.trim();
    if (!myName) return toast("닉네임을 입력해주세요");
    code = (code || "").trim().toUpperCase();
    if (!code) return toast("방 코드를 입력해주세요");

    if (!(await getMedia())) return;

    isHost = false;
    roomCode = code;
    meta = { title: "입장 중…", from: "", to: "", duration: 0, startedAt: null, status: "waiting" };

    peer = new Peer(PEER_CONFIG);
    peer.on("open", (id) => {
      myId = id;
      roster = [{ id: myId, name: myName, host: false }];
      enterRoom();

      hostConn = peer.connect(code, { reliable: true });
      hostConn.on("open", () => hostConn.send({ type: "hello", name: myName }));
      hostConn.on("data", onGuestData);
      hostConn.on("close", onHostGone);
      hostConn.on("error", onHostGone);
    });
    peer.on("call", onIncomingCall);
    peer.on("error", onPeerError);
  }

  function onGuestData(d) {
    if (d && d.type === "state") {
      roster = d.roster || roster;
      meta = d.meta || meta;
      applyMeta();
      renderGrid();
      runMeshCalls();
    }
  }

  function onHostGone() {
    if (!isHost && peer) {
      toast("방장이 방을 닫았어요. 로비로 돌아갈게요.");
      setTimeout(() => leaveRoom(), 1200);
    }
  }

  // ════════════════ 화상(미디어) ════════════════
  // 규칙: 내가 명단에서 더 뒤(나중 합류)면, 앞에 있던 사람에게 내가 call.
  function runMeshCalls() {
    const myIdx = roster.findIndex((r) => r.id === myId);
    if (myIdx < 0) return;
    roster.forEach((r, i) => {
      if (r.id !== myId && i < myIdx && !calls[r.id]) {
        const c = peer.call(r.id, localStream);
        if (c) wireCall(c);
      }
    });
  }

  function onIncomingCall(call) {
    call.answer(localStream);
    wireCall(call);
  }

  function wireCall(call) {
    calls[call.peer] = call;
    call.on("stream", (s) => {
      remoteStreams[call.peer] = s;
      renderGrid();
    });
    call.on("close", () => {
      delete remoteStreams[call.peer];
      delete calls[call.peer];
      renderGrid();
    });
    call.on("error", () => {
      delete remoteStreams[call.peer];
      delete calls[call.peer];
      renderGrid();
    });
  }

  function removePeer(id) {
    if (roster.some((r) => r.id === id)) roster = roster.filter((r) => r.id !== id);
    if (calls[id]) {
      try {
        calls[id].close();
      } catch {}
      delete calls[id];
    }
    delete remoteStreams[id];
    delete hostConns[id];
    if (isHost) broadcastState();
    else renderGrid();
  }

  // ════════════════ 렌더링 ════════════════
  function createTile(id) {
    const root = document.createElement("div");
    root.className = "video-tile";
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // 스피커 OFF (원격 소리 안 들림)
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

  function renderGrid() {
    const ids = roster.map((r) => r.id);
    // 떠난 사람 타일 제거
    Object.keys(tileEls).forEach((id) => {
      if (!ids.includes(id)) {
        tileEls[id].root.remove();
        delete tileEls[id];
      }
    });
    // 추가/갱신 (명단 순서대로)
    roster.forEach((r) => {
      let tile = tileEls[r.id];
      if (!tile) {
        tile = createTile(r.id);
        grid.appendChild(tile.root);
        tileEls[r.id] = tile;
      } else {
        grid.appendChild(tile.root); // 순서 정렬
      }
      const isMe = r.id === myId;
      tile.label.innerHTML = `📷 ${escapeHtml(isMe ? "나" : r.name || "친구")}`;
      tile.badge.style.display = r.host ? "block" : "none";

      const stream = isMe ? localStream : remoteStreams[r.id];
      if (stream) {
        if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
        tile.empty.style.display = "none";
      } else {
        tile.empty.style.display = "flex";
      }
    });
    $("people-count").textContent = roster.length;
  }

  function applyMeta() {
    if (!meta) return;
    $("room-title").textContent = meta.title;
    $("room-from").textContent = meta.from;
    $("room-to").textContent = meta.to;

    const badge = $("room-status");
    roomView.classList.remove("flying", "arrived");
    if (meta.status === "flying") {
      badge.textContent = "✈️ 비행 중 (집중!)";
      badge.className =
        "inline-block px-3 py-1 rounded-full text-xs font-semibold bg-primary/15 text-primary";
      roomView.classList.add("flying");
    } else if (meta.status === "arrived") {
      badge.textContent = "🛬 도착! 수고했어요";
      badge.className =
        "inline-block px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
      roomView.classList.add("arrived");
    } else {
      badge.textContent = "🕒 대기 중";
      badge.className =
        "inline-block px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
    }

    // 이륙 버튼: 방장 + 대기 중일 때만
    $("takeoff-btn").classList.toggle(
      "hidden",
      !(isHost && meta.status === "waiting")
    );
    tick();
  }

  function tick() {
    if (!meta) return;
    const total = meta.duration * 60;
    let remain = total;
    let pct = 0;

    if (meta.status === "flying" && meta.startedAt) {
      const elapsed = (Date.now() - meta.startedAt) / 1000;
      remain = total - elapsed;
      pct = Math.min(100, (elapsed / total) * 100);
      if (remain <= 0) {
        remain = 0;
        pct = 100;
        if (isHost && !arrivedFired) {
          arrivedFired = true;
          meta.status = "arrived";
          broadcastState();
        }
      }
    } else if (meta.status === "arrived") {
      remain = 0;
      pct = 100;
    }

    $("room-timer").textContent = fmt(remain);
    $("flight-progress").style.width = pct + "%";
    $("flight-plane").style.left = pct + "%";
  }

  // ════════════════ 화면 전환 ════════════════
  function enterRoom() {
    lobbyView.classList.add("hidden");
    roomView.classList.remove("hidden");
    $("room-code").textContent = roomCode;
    arrivedFired = false;
    applyMeta();
    renderGrid();
    if (timerInt) clearInterval(timerInt);
    timerInt = setInterval(tick, 1000);
    window.scrollTo(0, 0);
  }

  function leaveRoom() {
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
    try {
      Object.values(calls).forEach((c) => c.close());
    } catch {}
    try {
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
    } catch {}
    try {
      if (peer) peer.destroy();
    } catch {}

    peer = null;
    myId = null;
    isHost = false;
    roomCode = null;
    localStream = null;
    hostConn = null;
    roster = [];
    meta = null;
    for (const k in hostConns) delete hostConns[k];
    for (const k in calls) delete calls[k];
    for (const k in remoteStreams) delete remoteStreams[k];
    Object.values(tileEls).forEach((t) => t.root.remove());
    for (const k in tileEls) delete tileEls[k];
    grid.innerHTML = "";

    roomView.classList.add("hidden");
    lobbyView.classList.remove("hidden");
    renderMyRooms();
  }

  // ════════════════ 에러 ════════════════
  function onPeerError(err) {
    const t = err && err.type;
    if (t === "unavailable-id") {
      // 코드 충돌 → 새 코드로 재시도
      toast("코드가 겹쳐서 새 코드로 다시 만들게요");
      try {
        peer.destroy();
      } catch {}
      roomCode = genCode();
      myId = roomCode;
      peer = new Peer(roomCode, PEER_CONFIG);
      peer.on("open", () => {
        roster = [{ id: roomCode, name: myName, host: true }];
        if (meta) saveRoom({ code: roomCode, ...meta });
        $("room-code").textContent = roomCode;
        renderGrid();
      });
      peer.on("connection", onHostConnection);
      peer.on("call", onIncomingCall);
      peer.on("error", onPeerError);
      return;
    }
    if (t === "peer-unavailable") {
      if (!isHost) {
        toast("방을 찾을 수 없어요. 코드를 확인해주세요.");
        setTimeout(() => leaveRoom(), 1200);
      }
      return;
    }
    if (t === "network" || t === "server-error" || t === "socket-error") {
      toast("연결 서버 문제가 있어요. 잠시 후 다시 시도해주세요.");
      return;
    }
    console.warn("[peer error]", err);
  }

  // ════════════════ 이벤트 바인딩 ════════════════
  $("create-btn").onclick = () => createRoom();
  $("join-btn").onclick = () => joinRoom($("join-code").value);
  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom($("join-code").value);
  });
  $("leave-btn").onclick = () => {
    if (confirm("방에서 나갈까요?")) leaveRoom();
  };
  $("takeoff-btn").onclick = () => {
    if (!isHost || !meta) return;
    meta.startedAt = Date.now();
    meta.status = "flying";
    arrivedFired = false;
    broadcastState();
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

  // 초대 링크(?room=CODE)로 들어온 경우 코드 자동 입력
  const params = new URLSearchParams(location.search);
  const invited = params.get("room");
  if (invited) {
    $("join-code").value = invited.toUpperCase();
    setTimeout(() => $("nickname").focus(), 100);
    toast("초대받은 방이에요! 닉네임 입력 후 입장하세요");
  }

  // 나가기 전 정리
  window.addEventListener("beforeunload", () => {
    try {
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      if (peer) peer.destroy();
    } catch {}
  });

  renderMyRooms();
})();
