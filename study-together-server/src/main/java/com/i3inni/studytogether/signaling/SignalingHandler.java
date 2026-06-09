package com.i3inni.studytogether.signaling;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.i3inni.studytogether.lobby.LobbyHub;
import com.i3inni.studytogether.presence.PresenceRegistry;
import com.i3inni.studytogether.room.Room;
import com.i3inni.studytogether.room.RoomService;
import com.i3inni.studytogether.security.RateLimiter;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebRTC 시그널링 + 방 presence 중계.
 *
 * 클라이언트 → 서버:
 *   {type:"join", roomCode, name}
 *   {type:"offer"|"answer"|"ice", to, payload}
 *   {type:"start"}            // 방장 이륙
 *   {type:"leave"}
 *
 * 서버 → 클라이언트:
 *   {type:"joined", selfId, peers:[{id,name}], meta}
 *   {type:"peer-join", id, name}
 *   {type:"peer-leave", id}
 *   {type:"offer"|"answer"|"ice", from, payload}   // 상대에게 그대로 전달
 *   {type:"state", meta}                            // 방 상태 변경(이륙 등)
 *   {type:"error", message}
 *
 * 메시(mesh) 규칙: 새로 들어온 사람이 기존 참가자들에게 offer를 보낸다.
 * (기존 참가자는 answer만 → 쌍마다 정확히 1번 연결)
 */
@Component
@RequiredArgsConstructor
public class SignalingHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(SignalingHandler.class);
    private final ObjectMapper mapper = new ObjectMapper();

    private final RoomService roomService;
    private final PresenceRegistry presence;
    private final RateLimiter rateLimiter;
    private final LobbyHub lobbyHub;

    // sessionId -> WebSocketSession
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    // sessionId -> roomCode
    private final Map<String, String> sessionRoom = new ConcurrentHashMap<>();
    // 중복 입장 방지: "room|clientId" -> sessionId, sessionId -> key
    private final Map<String, String> clientKeyToSession = new ConcurrentHashMap<>();
    private final Map<String, String> sessionClientKey = new ConcurrentHashMap<>();
    // 방별 현재 방장 세션
    private final Map<String, String> roomHost = new ConcurrentHashMap<>();
    // roomCode -> 함께 듣기 플레이리스트 상태
    private final Map<String, MusicState> roomMusic = new ConcurrentHashMap<>();

    /** 방별 음악 플레이리스트 (1인 5곡 제한, 셔플, 무한 루프) */
    static class MusicState {
        final List<Map<String, String>> playlist = new ArrayList<>(); // {videoId, addedBy}
        final List<Integer> order = new ArrayList<>();                 // 재생 순서(playlist 인덱스)
        int orderPos = 0;
        boolean shuffle = false;
        String currentVideoId;
        long startedAt;

        void buildOrder() {
            order.clear();
            for (int i = 0; i < playlist.size(); i++) order.add(i);
            if (shuffle) Collections.shuffle(order);
        }

        void syncPosToCurrent() {
            for (int p = 0; p < order.size(); p++) {
                if (playlist.get(order.get(p)).get("videoId").equals(currentVideoId)) {
                    orderPos = p;
                    return;
                }
            }
            orderPos = 0;
        }

        void setCurrentFromPos(long now) {
            if (order.isEmpty()) { currentVideoId = null; return; }
            if (orderPos < 0 || orderPos >= order.size()) orderPos = 0;
            currentVideoId = playlist.get(order.get(orderPos)).get("videoId");
            startedAt = now;
        }

        void advance(long now) {
            if (playlist.isEmpty()) { currentVideoId = null; return; }
            orderPos++;
            if (orderPos >= order.size()) { buildOrder(); orderPos = 0; } // 끝나면 다시 처음(무한 루프)
            setCurrentFromPos(now);
        }

        String currentAddedBy() {
            for (Map<String, String> t : playlist)
                if (t.get("videoId").equals(currentVideoId)) return t.get("addedBy");
            return "";
        }
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.put(session.getId(), session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        try {
            JsonNode node = mapper.readTree(message.getPayload());
            String type = node.path("type").asText("");
            switch (type) {
                case "join" -> handleJoin(session, node);
                case "offer", "answer", "ice" -> relay(session, node);
                case "start" -> handleStart(session);
                case "music-add" -> handleMusicAdd(session, node);
                case "music-ended" -> handleMusicEnded(session, node);
                case "music-skip" -> handleMusicSkip(session);
                case "music-shuffle" -> handleMusicShuffle(session);
                case "music-remove" -> handleMusicRemove(session, node);
                case "chat" -> handleChat(session, node);
                case "ping" -> send(session, Map.of("type", "pong")); // keepalive
                case "leave" -> cleanup(session);
                default -> log.debug("unknown message type: {}", type);
            }
        } catch (Exception e) {
            log.warn("message handling error: {}", e.getMessage());
        }
    }

    private void handleJoin(WebSocketSession session, JsonNode node) {
        // 입장(=비번 시도) 폭주/무차별 대입 차단: IP당 분 30회
        if (!rateLimiter.allow("join:" + ipOf(session), 30, 60_000L)) {
            send(session, Map.of("type", "error", "message", "요청이 너무 많아요. 잠시 후 다시 시도해주세요."));
            return;
        }
        String roomCode = node.path("roomCode").asText("").trim().toUpperCase();
        String name = clamp(node.path("name").asText("게스트"), 20);

        Room meta;
        try {
            meta = roomService.get(roomCode);
        } catch (Exception e) {
            send(session, Map.of("type", "error", "message", "방을 찾을 수 없어요"));
            return;
        }

        // 비밀번호 방이면 해시 검증
        if (!roomService.passwordOk(meta, node.path("password").asText(""))) {
            send(session, Map.of("type", "error", "message", "비밀번호가 틀렸어요 🔒"));
            return;
        }

        // 나를 추가하기 전의 기존 참가자 목록 (이들에게 내가 offer를 건다)
        List<Map<String, String>> existingPeers = presence.peers(roomCode);

        presence.add(roomCode, session.getId(), name);
        sessionRoom.put(session.getId(), roomCode);

        // 같은 브라우저(clientId)가 이 방에 이미 있으면 이전 탭/세션을 강제 퇴장
        String clientId = node.path("clientId").asText("");
        if (!clientId.isBlank()) {
            String key = roomCode + "|" + clientId;
            String prevSid = clientKeyToSession.put(key, session.getId());
            sessionClientKey.put(session.getId(), key);
            if (prevSid != null && !prevSid.equals(session.getId())) {
                WebSocketSession old = sessions.get(prevSid);
                if (old != null) {
                    send(old, Map.of("type", "error", "message", "다른 탭/기기에서 입장해서 이 창은 나갑니다."));
                    try {
                        old.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }

        // 첫 입장자(보통 방장)를 방장 세션으로 지정
        roomHost.putIfAbsent(roomCode, session.getId());

        MusicState ms = roomMusic.get(roomCode);
        Map<String, Object> joined = new HashMap<>();
        joined.put("type", "joined");
        joined.put("selfId", session.getId());
        joined.put("hostSessionId", roomHost.get(roomCode));
        joined.put("peers", existingPeers);
        joined.put("meta", metaOf(meta));
        putMusic(joined, ms);
        send(session, joined);

        broadcast(roomCode, session.getId(), Map.of(
                "type", "peer-join",
                "id", session.getId(),
                "name", name
        ));
        log.info("join room={} session={} name={} (now {} people)",
                roomCode, session.getId(), name, presence.count(roomCode));
        lobbyHub.publish(); // 인원수 변경 → 로비 갱신
    }

    /** offer/answer/ice 를 to 대상에게 그대로 전달 (from 채워서) */
    private void relay(WebSocketSession session, JsonNode node) {
        // 시그널링 폭주 차단 (ICE 후보가 많아 임계는 넉넉히)
        if (!rateLimiter.allow("relay:" + session.getId(), 400, 10_000L)) return;
        String to = node.path("to").asText(null);
        if (to == null) return;
        WebSocketSession target = sessions.get(to);
        if (target == null) return;

        ObjectNode out = ((ObjectNode) node).deepCopy();
        out.put("from", session.getId());
        sendRaw(target, out.toString());
    }

    private void handleStart(WebSocketSession session) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        if (!session.getId().equals(roomHost.get(roomCode))) return; // 방장만 이륙 가능
        Room updated = roomService.start(roomCode);
        broadcastAll(roomCode, Map.of("type", "state", "meta", metaOf(updated)));
        log.info("takeoff room={}", roomCode);
        lobbyHub.publish(); // 상태(비행중) 변경 → 로비 갱신
    }

    // ── 채팅 ──

    private void handleChat(WebSocketSession session, JsonNode node) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        if (!rateLimiter.allow("chat:" + session.getId(), 10, 3_000L)) return; // 3초 10개
        String text = node.path("text").asText("").trim();
        if (text.isEmpty()) return;
        if (text.length() > 500) text = text.substring(0, 500);
        String name = clamp(node.path("name").asText("게스트"), 20);
        broadcastAll(roomCode, Map.of("type", "chat", "name", name, "text", text));
    }

    // ── 함께 듣기 (플레이리스트: 곡 수 무제한, 셔플, 무한 루프) ──

    private static final int MAX_PLAYLIST = 300; // 폭주 방지용 전체 상한

    private void handleMusicAdd(WebSocketSession session, JsonNode node) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        if (!rateLimiter.allow("music:" + session.getId(), 20, 10_000L)) return; // 10초 20곡
        String videoId = node.path("videoId").asText("");
        if (!videoId.matches("[A-Za-z0-9_-]{11}")) return; // 유효한 유튜브 ID만
        String addedBy = clamp(node.path("addedBy").asText("게스트"), 20);

        MusicState ms = roomMusic.computeIfAbsent(roomCode, k -> new MusicState());
        synchronized (ms) {
            if (ms.playlist.size() >= MAX_PLAYLIST) {
                send(session, Map.of("type", "error",
                        "message", "플레이리스트가 가득 찼어요 (최대 " + MAX_PLAYLIST + "곡)"));
                return;
            }
            ms.playlist.add(Map.of("videoId", videoId, "addedBy", addedBy));
            boolean wasEmpty = (ms.currentVideoId == null);
            ms.buildOrder();
            if (wasEmpty) {
                ms.orderPos = 0;
                ms.setCurrentFromPos(System.currentTimeMillis());
            } else {
                ms.syncPosToCurrent();
            }
        }
        broadcastMusic(roomCode);
        log.info("music-add room={} videoId={} by={}", roomCode, videoId, addedBy);
    }

    private void handleMusicEnded(WebSocketSession session, JsonNode node) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        String videoId = node.path("videoId").asText("");
        MusicState ms = roomMusic.get(roomCode);
        if (ms == null) return;
        synchronized (ms) {
            if (videoId.equals(ms.currentVideoId)) ms.advance(System.currentTimeMillis());
        }
        broadcastMusic(roomCode);
    }

    private void handleMusicSkip(WebSocketSession session) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        MusicState ms = roomMusic.get(roomCode);
        if (ms == null) return;
        synchronized (ms) {
            ms.advance(System.currentTimeMillis());
        }
        broadcastMusic(roomCode);
    }

    private void handleMusicShuffle(WebSocketSession session) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        MusicState ms = roomMusic.get(roomCode);
        if (ms == null) return;
        synchronized (ms) {
            ms.shuffle = !ms.shuffle;
            ms.buildOrder();
            if (ms.currentVideoId != null) ms.syncPosToCurrent();
        }
        broadcastMusic(roomCode);
    }

    private void handleMusicRemove(WebSocketSession session, JsonNode node) {
        String roomCode = sessionRoom.get(session.getId());
        if (roomCode == null) return;
        String videoId = node.path("videoId").asText("");
        MusicState ms = roomMusic.get(roomCode);
        if (ms == null) return;
        synchronized (ms) {
            boolean removed = false;
            for (int i = 0; i < ms.playlist.size(); i++) {
                if (ms.playlist.get(i).get("videoId").equals(videoId)) {
                    ms.playlist.remove(i);
                    removed = true;
                    break;
                }
            }
            if (!removed) return;
            boolean currentGone = videoId.equals(ms.currentVideoId);
            ms.buildOrder();
            if (ms.playlist.isEmpty()) {
                ms.currentVideoId = null;
            } else if (currentGone) {
                if (ms.orderPos >= ms.order.size()) ms.orderPos = 0;
                ms.setCurrentFromPos(System.currentTimeMillis());
            } else {
                ms.syncPosToCurrent();
            }
        }
        broadcastMusic(roomCode);
    }

    private Map<String, Object> nowPlayingPayload(MusicState ms) {
        if (ms == null || ms.currentVideoId == null) return null;
        Map<String, Object> np = new HashMap<>();
        np.put("videoId", ms.currentVideoId);
        np.put("addedBy", ms.currentAddedBy());
        np.put("startedAt", ms.startedAt);
        return np;
    }

    private void putMusic(Map<String, Object> target, MusicState ms) {
        target.put("nowPlaying", nowPlayingPayload(ms));
        target.put("playlist", ms == null ? List.of() : new ArrayList<>(ms.playlist));
        target.put("shuffle", ms != null && ms.shuffle);
    }

    private void broadcastMusic(String roomCode) {
        MusicState ms = roomMusic.get(roomCode);
        Map<String, Object> payload = new HashMap<>();
        payload.put("type", "music-state");
        putMusic(payload, ms);
        broadcastAll(roomCode, payload);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        cleanup(session);
    }

    private void cleanup(WebSocketSession session) {
        sessions.remove(session.getId());
        String ck = sessionClientKey.remove(session.getId());
        if (ck != null) clientKeyToSession.remove(ck, session.getId());
        String roomCode = sessionRoom.remove(session.getId());
        if (roomCode == null) return;

        int remaining = presence.remove(roomCode, session.getId());
        broadcastAll(roomCode, Map.of("type", "peer-leave", "id", session.getId()));

        // 방장이 나가면 다음 사람에게 방장 위임
        if (session.getId().equals(roomHost.get(roomCode))) {
            List<Map<String, String>> rest = presence.peers(roomCode);
            if (!rest.isEmpty()) {
                Map<String, String> next = rest.get(0);
                roomHost.put(roomCode, next.get("id"));
                try {
                    roomService.updateHostName(roomCode, next.get("name"));
                } catch (Exception ignored) {
                }
                broadcastAll(roomCode, Map.of(
                        "type", "host", "sessionId", next.get("id"), "name", next.get("name")));
                log.info("host migrated room={} -> {}", roomCode, next.get("name"));
            } else {
                roomHost.remove(roomCode);
            }
        }

        if (remaining == 0) {
            roomMusic.remove(roomCode);
            roomHost.remove(roomCode);
            try {
                roomService.deleteIfExists(roomCode);
                log.info("room {} emptied → removed", roomCode);
            } catch (Exception ignored) {
            }
        }
        lobbyHub.publish(); // 퇴장/방 삭제 → 로비 갱신
    }

    // ── helpers ──

    private String ipOf(WebSocketSession s) {
        Object ip = s.getAttributes().get("ip");
        return ip == null ? "?" : ip.toString();
    }

    private String clamp(String s, int max) {
        if (s == null) return "";
        s = s.trim();
        return s.length() > max ? s.substring(0, max) : s;
    }

    private Map<String, Object> metaOf(Room r) {
        Map<String, Object> m = new HashMap<>();
        m.put("code", r.getCode());
        m.put("title", r.getTitle());
        m.put("hostName", r.getHostName());
        m.put("departure", r.getDeparture());
        m.put("destination", r.getDestination());
        m.put("durationMinutes", r.getDurationMinutes());
        m.put("status", r.getStatus().name());
        m.put("startedAt", r.getStartedAt() == null ? null : r.getStartedAt().toEpochMilli());
        return m;
    }

    private void send(WebSocketSession s, Object obj) {
        try {
            sendRaw(s, mapper.writeValueAsString(obj));
        } catch (Exception e) {
            log.warn("serialize fail: {}", e.getMessage());
        }
    }

    private void sendRaw(WebSocketSession s, String text) {
        try {
            synchronized (s) {
                if (s.isOpen()) s.sendMessage(new TextMessage(text));
            }
        } catch (Exception e) {
            log.warn("send fail: {}", e.getMessage());
        }
    }

    /** 방의 (한 명 제외) 전원에게 전송 */
    private void broadcast(String roomCode, String exceptSessionId, Object obj) {
        String text = toJson(obj);
        if (text == null) return;
        for (String sid : presence.sessionIds(roomCode)) {
            if (sid.equals(exceptSessionId)) continue;
            WebSocketSession s = sessions.get(sid);
            if (s != null) sendRaw(s, text);
        }
    }

    /** 방의 전원에게 전송 */
    private void broadcastAll(String roomCode, Object obj) {
        String text = toJson(obj);
        if (text == null) return;
        for (String sid : presence.sessionIds(roomCode)) {
            WebSocketSession s = sessions.get(sid);
            if (s != null) sendRaw(s, text);
        }
    }

    private String toJson(Object obj) {
        try {
            return mapper.writeValueAsString(obj);
        } catch (Exception e) {
            return null;
        }
    }
}
