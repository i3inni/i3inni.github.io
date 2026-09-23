package com.i3inni.studytogether.flight;

import com.i3inni.studytogether.flight.dto.FlightHistoryResponse;
import com.i3inni.studytogether.flight.dto.FlightLogResponse;
import com.i3inni.studytogether.flight.dto.SoloFlightRequest;
import com.i3inni.studytogether.room.Room;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * 비행 기록.
 *  · 혼자 비행: REST로 이륙/착륙/재탑승
 *  · 방 비행  : SignalingHandler가 이륙·입장·퇴장 시점에 board/alight 호출
 */
@Service
@RequiredArgsConstructor
public class FlightLogService {

    private static final int MAX_HISTORY = 100;

    private final FlightLogRepository repository;

    public static String flightKey(Room room) {
        return room.getCode() + "-" + room.getStartedAt().toEpochMilli();
    }

    // ── 방 비행 ──

    /** 방 비행 탑승 (이륙 시 전원 / 비행 중 입장 / 새로고침 후 재탑승) */
    @Transactional
    public void boardGroup(Room room, String clientId, String nickname, Instant now) {
        if (clientId == null || clientId.isBlank() || room.getStartedAt() == null) return;
        Instant end = room.getStartedAt().plus(Duration.ofMinutes(room.getDurationMinutes()));
        if (!now.isBefore(end)) return; // 이미 도착한 비행
        String key = flightKey(room);

        FlightLog log = repository.findByFlightKeyAndClientId(key, clientId).orElse(null);
        if (log != null) {
            log.setNickname(nickname);
            log.board(now);
            return;
        }
        repository.save(FlightLog.builder()
                .clientId(clientId)
                .nickname(nickname)
                .mode(FlightMode.GROUP)
                .flightKey(key)
                .roomCode(room.getCode())
                .title(room.getTitle())
                .departure(room.getDeparture())
                .destination(room.getDestination())
                .plannedMinutes(room.getDurationMinutes())
                .startedAt(room.getStartedAt())
                .plannedEndAt(end)
                .joinedAt(now)
                .boardedAt(now)
                .status(FlightStatus.FLYING)
                .build());
    }

    /** 방에서 나감 → 도착 전이면 중도 하차 */
    @Transactional
    public void alightGroup(String flightKey, String clientId, Instant now) {
        if (clientId == null || clientId.isBlank()) return;
        repository.findByFlightKeyAndClientId(flightKey, clientId).ifPresent(l -> l.alight(now));
    }

    /** 방 비행 종료(다시 시작 등) — 아직 탑승 중인 기록 모두 마감 */
    @Transactional
    public void closeFlight(String flightKey, Instant now) {
        repository.findByFlightKeyAndStatus(flightKey, FlightStatus.FLYING).forEach(l -> l.alight(now));
    }

    // ── 혼자 비행 ──

    @Transactional
    public FlightLog startSolo(SoloFlightRequest req, Instant now) {
        // 혼자 비행은 한 번에 하나 — 진행 중인 게 있으면 먼저 내림
        repository.findByClientIdAndModeAndStatus(req.getClientId(), FlightMode.SOLO, FlightStatus.FLYING)
                .forEach(l -> l.alight(now));

        return repository.save(FlightLog.builder()
                .clientId(req.getClientId())
                .nickname(blankToDefault(req.getNickname(), "나"))
                .mode(FlightMode.SOLO)
                .title("혼자 비행")
                .departure(blankToDefault(req.getDeparture(), "출발지"))
                .destination(blankToDefault(req.getDestination(), "목적지"))
                .plannedMinutes(req.getDurationMinutes())
                .startedAt(now)
                .plannedEndAt(now.plus(Duration.ofMinutes(req.getDurationMinutes())))
                .joinedAt(now)
                .boardedAt(now)
                .status(FlightStatus.FLYING)
                .build());
    }

    /** 착륙 (도착 시각 지났으면 완주, 아니면 중도 하차) */
    @Transactional
    public FlightLog landSolo(long id, String clientId, Instant now) {
        FlightLog log = ownedSolo(id, clientId);
        log.alight(now);
        return log;
    }

    /** 새로고침 후 같은 비행 재탑승 */
    @Transactional
    public FlightLog resumeSolo(long id, String clientId, Instant now) {
        FlightLog log = ownedSolo(id, clientId);
        log.board(now);
        return log;
    }

    private FlightLog ownedSolo(long id, String clientId) {
        return repository.findById(id)
                .filter(l -> l.getMode() == FlightMode.SOLO && Objects.equals(l.getClientId(), clientId))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "비행 기록을 찾을 수 없어요"));
    }

    // ── 조회 / 정리 ──

    @Transactional(readOnly = true)
    public FlightHistoryResponse history(String clientId, int limit, Instant now) {
        List<FlightLog> logs = repository.findByClientIdOrderByStartedAtDesc(
                clientId, PageRequest.of(0, Math.min(MAX_HISTORY, Math.max(1, limit))));

        // 방 비행이면 같은 비행의 탑승객 명단(참가 여부)을 함께
        List<String> keys = logs.stream().map(FlightLog::getFlightKey).filter(Objects::nonNull).toList();
        Map<String, List<FlightLog>> crewByKey = keys.isEmpty() ? Map.of()
                : repository.findByFlightKeyInOrderByJoinedAtAsc(keys).stream()
                        .collect(Collectors.groupingBy(FlightLog::getFlightKey));

        List<FlightLogResponse> flights = logs.stream()
                .map(l -> FlightLogResponse.from(l,
                        l.getFlightKey() == null ? List.of() : crewByKey.getOrDefault(l.getFlightKey(), List.of()), now))
                .toList();

        return FlightHistoryResponse.builder()
                .totalFlights(repository.countByClientId(clientId))
                .completed(repository.countByClientIdAndStatus(clientId, FlightStatus.COMPLETED))
                .left(repository.countByClientIdAndStatus(clientId, FlightStatus.LEFT))
                .totalFocusedSeconds(repository.sumFocusedSeconds(clientId))
                .flights(flights)
                .build();
    }

    /** 도착 시각이 지났는데 아직 탑승 중인 기록 → 완주 처리 (방에 남아있던 사람, 탭 닫힘 등) */
    @Transactional
    public int sweep(Instant now) {
        List<FlightLog> due = repository.findByStatusAndPlannedEndAtLessThanEqual(FlightStatus.FLYING, now);
        due.forEach(l -> l.alight(now));
        return due.size();
    }

    private String blankToDefault(String value, String fallback) {
        return (value == null || value.isBlank()) ? fallback : value.trim();
    }
}
