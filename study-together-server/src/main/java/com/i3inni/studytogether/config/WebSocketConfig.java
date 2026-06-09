package com.i3inni.studytogether.config;

import com.i3inni.studytogether.signaling.SignalingHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/**
 * WebRTC 시그널링용 WebSocket 엔드포인트 등록 (/ws/signal).
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;
    private final String[] allowedOrigins;

    public WebSocketConfig(SignalingHandler signalingHandler,
                           @Value("${app.allowed-origins}") String allowedOrigins) {
        this.signalingHandler = signalingHandler;
        this.allowedOrigins = allowedOrigins.split("\\s*,\\s*");
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws/signal")
                .setAllowedOrigins(allowedOrigins);
    }
}
