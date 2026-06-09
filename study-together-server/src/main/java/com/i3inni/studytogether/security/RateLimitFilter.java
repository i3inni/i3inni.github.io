package com.i3inni.studytogether.security;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * REST 요청 폭주 차단. 특히 방 생성(POST /api/rooms)을 IP당 제한해 스팸/DoS를 막는다.
 */
@Component
@RequiredArgsConstructor
public class RateLimitFilter extends OncePerRequestFilter {

    private final RateLimiter limiter;

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {

        String path = req.getRequestURI();

        // 방 생성(POST /api/rooms)만 IP당 분 15회로 제한 (조회 GET은 자유 — NAT 뒤 폴링 고려)
        boolean blocked = "POST".equalsIgnoreCase(req.getMethod())
                && "/api/rooms".equals(path)
                && !limiter.allow("create:" + clientIp(req), 15, 60_000L);

        if (blocked) {
            res.setStatus(429);
            res.setContentType("application/json;charset=UTF-8");
            res.getWriter().write("{\"message\":\"요청이 너무 많아요. 잠시 후 다시 시도해주세요.\"}");
            return;
        }
        chain.doFilter(req, res);
    }

    static String clientIp(HttpServletRequest req) {
        String xff = req.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) return xff.split(",")[0].trim();
        return req.getRemoteAddr();
    }
}
