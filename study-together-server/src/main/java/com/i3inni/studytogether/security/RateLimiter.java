package com.i3inni.studytogether.security;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 아주 단순한 인메모리 고정창(fixed-window) 레이트 리미터.
 * key 단위로 windowMs 동안 limit회까지 허용한다. (분산 환경 X, 단일 인스턴스용)
 */
@Component
public class RateLimiter {

    private static class Window {
        volatile long start;
        final AtomicInteger count = new AtomicInteger();
    }

    private final Map<String, Window> windows = new ConcurrentHashMap<>();

    public boolean allow(String key, int limit, long windowMs) {
        long now = System.currentTimeMillis();
        Window w = windows.computeIfAbsent(key, k -> {
            Window x = new Window();
            x.start = now;
            return x;
        });
        synchronized (w) {
            if (now - w.start >= windowMs) {
                w.start = now;
                w.count.set(0);
            }
            return w.count.incrementAndGet() <= limit;
        }
    }

    /** 오래된 키 정리 (스케줄러에서 주기 호출) — 메모리 증가 방지 */
    public void purge() {
        long now = System.currentTimeMillis();
        windows.entrySet().removeIf(e -> now - e.getValue().start > 600_000L);
    }
}
