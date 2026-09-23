package com.i3inni.studytogether.flight;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.Duration;
import java.time.Instant;

/**
 * 사용자(브라우저 clientId)별 비행 기록 1건.
 * 같이 공부 방 비행이면 탑승객마다 1건씩 생기고, 같은 flightKey로 묶인다(=참가 여부).
 */
@Entity
@Table(name = "flight_logs",
        indexes = {
                @Index(name = "idx_flight_client", columnList = "clientId, startedAt"),
                @Index(name = "idx_flight_key", columnList = "flightKey"),
                @Index(name = "idx_flight_status_end", columnList = "status, plannedEndAt")
        },
        uniqueConstraints = @UniqueConstraint(name = "uk_flight_client", columnNames = {"flightKey", "clientId"}))
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class FlightLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, length = 64)
    private String clientId;

    @Column(nullable = false, length = 20)
    private String nickname;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 8)
    private FlightMode mode;

    /** 방 비행 식별자 "방코드-이륙시각(ms)". 혼자 비행은 null */
    @Column(length = 40)
    private String flightKey;

    @Column(length = 8)
    private String roomCode;

    @Column(nullable = false, length = 40)
    private String title;

    @Column(length = 30)
    private String departure;

    @Column(length = 30)
    private String destination;

    @Column(nullable = false)
    private int plannedMinutes;

    /** 비행(이륙) 시각 */
    @Column(nullable = false)
    private Instant startedAt;

    @Column(nullable = false)
    private Instant plannedEndAt;

    /** 이 사용자가 처음 탑승한 시각 (이륙 후 늦게 들어오면 startedAt 이후) */
    @Column(nullable = false)
    private Instant joinedAt;

    /** 현재 탑승 구간 시작 시각. 내려 있으면 null */
    private Instant boardedAt;

    /** 기록 종료(도착/하차) 시각 */
    private Instant endedAt;

    /** 실제로 탑승해 있던 누적 시간(초) — 새로고침 등으로 내렸다 다시 타면 합산 */
    @Column(nullable = false)
    private long focusedSeconds;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 12)
    private FlightStatus status;

    /** (다시) 탑승 */
    public void board(Instant now) {
        if (status == FlightStatus.COMPLETED || !now.isBefore(plannedEndAt)) return;
        if (status == FlightStatus.LEFT || boardedAt == null) boardedAt = now;
        status = FlightStatus.FLYING;
        endedAt = null;
    }

    /** 내림 — 도착 시각이 지났으면 완주, 아니면 중도 하차 */
    public void alight(Instant now) {
        if (status != FlightStatus.FLYING) return;
        focusedSeconds = liveFocusedSeconds(now);
        Instant stop = now.isBefore(plannedEndAt) ? now : plannedEndAt;
        boardedAt = null;
        endedAt = stop;
        status = now.isBefore(plannedEndAt) ? FlightStatus.LEFT : FlightStatus.COMPLETED;
    }

    /** 진행 중인 탑승 구간까지 포함한 누적 시간(초) */
    public long liveFocusedSeconds(Instant now) {
        if (status != FlightStatus.FLYING || boardedAt == null) return focusedSeconds;
        Instant stop = now.isBefore(plannedEndAt) ? now : plannedEndAt;
        return focusedSeconds + Math.max(0, Duration.between(boardedAt, stop).getSeconds());
    }
}
