package com.i3inni.studytogether.flight;

import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;

/** 도착 시각이 지난 탑승 중 기록을 주기적으로 완주 처리 */
@Component
@RequiredArgsConstructor
public class FlightSweepTask {

    private static final Logger log = LoggerFactory.getLogger(FlightSweepTask.class);

    private final FlightLogService service;

    @Scheduled(fixedRate = 60_000L) // 1분마다
    public void sweep() {
        int n = service.sweep(Instant.now());
        if (n > 0) log.info("flight sweep: {} arrived", n);
    }
}
