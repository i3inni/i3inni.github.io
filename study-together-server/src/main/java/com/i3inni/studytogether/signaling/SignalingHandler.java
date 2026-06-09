package com.i3inni.studytogether.signaling;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.i3inni.studytogether.presence.PresenceRegistry;
import com.i3inni.studytogether.room.Room;
import com.i3inni.studytogether.room.RoomService;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

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

    // sessionId -> WebSocketSession
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    // sessionId -> roomCode
    private final Map<String, String> sessionRoom = new ConcurrentHashMap<>();

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
                case "leave" -> cleanup(session);
                default -> log.debug("unknown message type: {}", type);
            }
        } catch (Exception e) {
            log.warn("message handling error: {}", e.getMessage());
        }
    }

    private void handleJoin(WebSocketSession session, JsonNode node) {
        String roomCode = node.path("roomCode").asText("").trim().toUpperCase();
        String name = node.path("name").asText("게스트");

        Room meta;
        try {
            meta = roomService.get(roomCode);
        } catch (Exception e) {
            send(session, Map.of("type", "error", "message", "방을 찾을 수 없어요"));
            return;
        }

        // 나를 추가하기 전의 기존 참가자 목록 (이들에게 내가 offer를 건다)
        List<Map<String, String>> existingPeers = presence.peers(roomCode);

        presence.add(roomCode, session.getId(), name);
        sessionRoom.put(session.getId(), roomCode);

        send(session, Map.of(
                "type", "joined",
                "selfId", session.getId(),
                "peers", existingPeers,
                "meta", metaOf(meta)
        ));

        broadcast(roomCode, session.getId(), Map.of(
                "type", "peer-join",
                "id", session.getId(),
                "name", name
        ));
        log.info("join room={} session={} name={} (now {} people)",
                roomCode, session.getId(), name, presence.count(roomCode));
    }

    /** offer/answer/ice 를 to 대상에게 그대로 전달 (from 채워서) */
    private void relay(WebSocketSession session, JsonNode node) {
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
        Room updated = roomService.start(roomCode);
        broadcastAll(roomCode, Map.of("type", "state", "meta", metaOf(updated)));
        log.info("takeoff room={}", roomCode);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        cleanup(session);
    }

    private void cleanup(WebSocketSession session) {
        sessions.remove(session.getId());
        String roomCode = sessionRoom.remove(session.getId());
        if (roomCode == null) return;

        int remaining = presence.remove(roomCode, session.getId());
        broadcastAll(roomCode, Map.of("type", "peer-leave", "id", session.getId()));

        if (remaining == 0) {
            try {
                roomService.deleteIfExists(roomCode);
                log.info("room {} emptied → removed", roomCode);
            } catch (Exception ignored) {
            }
        }
    }

    // ── helpers ──

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
