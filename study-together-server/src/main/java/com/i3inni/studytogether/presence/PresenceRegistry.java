package com.i3inni.studytogether.presence;

import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 방별 실시간 참가자(WebSocket 세션) 인메모리 레지스트리.
 * 방 메타데이터는 Postgres, "지금 누가 접속해 있나"는 휘발성이라 메모리에서 관리.
 */
@Component
public class PresenceRegistry {

    // roomCode -> (sessionId -> 닉네임). 입장 순서 유지(= 좌석 순서)를 위해 LinkedHashMap
    private final Map<String, Map<String, String>> rooms = new ConcurrentHashMap<>();

    public void add(String roomCode, String sessionId, String name) {
        rooms.computeIfAbsent(roomCode, k -> Collections.synchronizedMap(new LinkedHashMap<>())).put(sessionId, name);
    }

    /** 세션 제거 후 방에 남은 인원 수 반환 */
    public int remove(String roomCode, String sessionId) {
        Map<String, String> members = rooms.get(roomCode);
        if (members == null) return 0;
        members.remove(sessionId);
        if (members.isEmpty()) {
            rooms.remove(roomCode);
            return 0;
        }
        return members.size();
    }

    public int count(String roomCode) {
        Map<String, String> members = rooms.get(roomCode);
        return members == null ? 0 : members.size();
    }

    /** 방의 현재 참가자 목록 [{id, name}, ...] */
    public List<Map<String, String>> peers(String roomCode) {
        Map<String, String> members = rooms.get(roomCode);
        List<Map<String, String>> out = new ArrayList<>();
        if (members != null) {
            synchronized (members) { // synchronizedMap 순회는 직접 잠가야 함
                members.forEach((id, name) -> out.add(Map.of("id", id, "name", name)));
            }
        }
        return out;
    }

    public Set<String> sessionIds(String roomCode) {
        Map<String, String> members = rooms.get(roomCode);
        if (members == null) return Set.of();
        synchronized (members) {
            return new HashSet<>(members.keySet());
        }
    }
}
