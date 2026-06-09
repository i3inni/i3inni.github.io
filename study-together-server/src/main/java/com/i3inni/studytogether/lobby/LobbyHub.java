package com.i3inni.studytogether.lobby;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.i3inni.studytogether.presence.PresenceRegistry;
import com.i3inni.studytogether.room.RoomService;
import com.i3inni.studytogether.room.dto.RoomResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 로비 실시간 푸시. 로비 페이지를 보고 있는 클라이언트들에게
 * 방 생성/삭제/입장/이륙 시 공개 방 목록을 즉시 보낸다. (/ws/lobby)
 */
@Component
@RequiredArgsConstructor
public class LobbyHub extends TextWebSocketHandler {

    private final RoomService roomService;
    private final PresenceRegistry presence;
    private final ObjectMapper mapper; // Spring이 구성한 매퍼(JavaTime 포함) 주입

    private final Set<WebSocketSession> sessions = ConcurrentHashMap.newKeySet();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.add(session);
        sendRaw(session, listJson()); // 접속 즉시 현재 목록 전송
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session);
    }

    /** 방 목록 변경 시 호출 → 모든 로비 구독자에게 푸시 */
    public void publish() {
        String text = listJson();
        if (text == null) return;
        for (WebSocketSession s : sessions) sendRaw(s, text);
    }

    private String listJson() {
        try {
            List<RoomResponse> rooms = roomService.listOpen().stream()
                    .map(r -> RoomResponse.from(r, presence.count(r.getCode())))
                    .toList();
            return mapper.writeValueAsString(Map.of("type", "rooms", "rooms", rooms));
        } catch (Exception e) {
            return null;
        }
    }

    private void sendRaw(WebSocketSession s, String text) {
        if (text == null) return;
        try {
            synchronized (s) {
                if (s.isOpen()) s.sendMessage(new TextMessage(text));
            }
        } catch (Exception ignored) {
        }
    }
}
