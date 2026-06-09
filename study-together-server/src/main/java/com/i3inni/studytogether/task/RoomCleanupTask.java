package com.i3inni.studytogether.task;

import com.i3inni.studytogether.lobby.LobbyHub;
import com.i3inni.studytogether.presence.PresenceRegistry;
import com.i3inni.studytogether.room.Room;
import com.i3inni.studytogether.room.RoomRepository;
import com.i3inni.studytogether.security.RateLimiter;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;

/** 오래 방치된 빈 방 정리 + 레이트리미터 메모리 정리 */
@Component
@RequiredArgsConstructor
public class RoomCleanupTask {

    private static final Logger log = LoggerFactory.getLogger(RoomCleanupTask.class);
    private static final Duration STALE = Duration.ofMinutes(30);

    private final RoomRepository repository;
    private final PresenceRegistry presence;
    private final RateLimiter rateLimiter;
    private final LobbyHub lobbyHub;

    @Scheduled(fixedRate = 600_000L) // 10분마다
    @Transactional
    public void cleanup() {
        Instant cutoff = Instant.now().minus(STALE);
        int removed = 0;
        for (Room r : repository.findAll()) {
            if (presence.count(r.getCode()) == 0
                    && r.getCreatedAt() != null && r.getCreatedAt().isBefore(cutoff)) {
                repository.deleteById(r.getCode());
                removed++;
            }
        }
        rateLimiter.purge();
        if (removed > 0) {
            log.info("cleanup: removed {} stale empty rooms", removed);
            lobbyHub.publish();
        }
    }
}
