package com.i3inni.studytogether.room.dto;

import com.i3inni.studytogether.room.Room;
import com.i3inni.studytogether.room.RoomStatus;
import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

@Getter
@Builder
public class RoomResponse {

    private String code;
    private String title;
    private String hostName;
    private String departure;
    private String destination;
    private int durationMinutes;
    private boolean locked;
    private String status;
    private int participantCount;
    private long remainingSeconds;
    private Instant createdAt;
    private Instant startedAt;

    public static RoomResponse from(Room room, int participantCount) {
        return RoomResponse.builder()
                .code(room.getCode())
                .title(room.getTitle())
                .hostName(room.getHostName())
                .departure(room.getDeparture())
                .destination(room.getDestination())
                .durationMinutes(room.getDurationMinutes())
                .locked(room.getPassword() != null && !room.getPassword().isBlank())
                .status(room.getStatus().name())
                .participantCount(participantCount)
                .remainingSeconds(remaining(room))
                .createdAt(room.getCreatedAt())
                .startedAt(room.getStartedAt())
                .build();
    }

    private static long remaining(Room room) {
        long total = (long) room.getDurationMinutes() * 60;
        if (room.getStatus() == RoomStatus.FLYING && room.getStartedAt() != null) {
            long elapsed = (System.currentTimeMillis() - room.getStartedAt().toEpochMilli()) / 1000;
            return Math.max(0, total - elapsed);
        }
        if (room.getStatus() == RoomStatus.WAITING) {
            return total;
        }
        return 0;
    }
}
