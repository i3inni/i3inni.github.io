package com.i3inni.studytogether.flight.dto;

import com.i3inni.studytogether.flight.FlightLog;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;
import java.util.List;

/** 비행 기록 1건. 시각은 전부 epoch ms (프론트 Date.now()와 바로 비교) */
@Getter
@Builder
public class FlightLogResponse {

    private Long id;
    private String mode;
    private String status;
    private String roomCode;
    private String title;
    private String departure;
    private String destination;
    private int plannedMinutes;
    private long focusedSeconds;
    private long startedAt;
    private long plannedEndAt;
    private long joinedAt;
    private Long endedAt;
    /** 방 비행 탑승객 명단(참가 여부). 혼자 비행은 빈 목록 */
    private List<CrewMember> crew;

    @Getter
    @Builder
    public static class CrewMember {
        private String nickname;
        private String status;
        private long focusedSeconds;
        private boolean lateBoarding; // 이륙 후 늦게 탑승
    }

    public static FlightLogResponse from(FlightLog l, List<FlightLog> crew, Instant now) {
        return FlightLogResponse.builder()
                .id(l.getId())
                .mode(l.getMode().name())
                .status(l.getStatus().name())
                .roomCode(l.getRoomCode())
                .title(l.getTitle())
                .departure(l.getDeparture())
                .destination(l.getDestination())
                .plannedMinutes(l.getPlannedMinutes())
                .focusedSeconds(l.liveFocusedSeconds(now))
                .startedAt(l.getStartedAt().toEpochMilli())
                .plannedEndAt(l.getPlannedEndAt().toEpochMilli())
                .joinedAt(l.getJoinedAt().toEpochMilli())
                .endedAt(l.getEndedAt() == null ? null : l.getEndedAt().toEpochMilli())
                .crew(crew.stream().map(c -> CrewMember.builder()
                        .nickname(c.getNickname())
                        .status(c.getStatus().name())
                        .focusedSeconds(c.liveFocusedSeconds(now))
                        .lateBoarding(c.getJoinedAt().getEpochSecond() - c.getStartedAt().getEpochSecond() > 60)
                        .build()).toList())
                .build();
    }
}
