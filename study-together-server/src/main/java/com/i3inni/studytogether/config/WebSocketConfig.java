package com.i3inni.studytogether.config;

import com.i3inni.studytogether.lobby.LobbyHub;
import com.i3inni.studytogether.security.ClientIpHandshakeInterceptor;
import com.i3inni.studytogether.signaling.SignalingHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

/**
 * WebRTC 시그널링용 WebSocket 엔드포인트 등록 (/ws/signal).
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;
    private final LobbyHub lobbyHub;
    private final String[] allowedOrigins;

    public WebSocketConfig(SignalingHandler signalingHandler,
                           LobbyHub lobbyHub,
                           @Value("${app.allowed-origins}") String allowedOrigins) {
        this.signalingHandler = signalingHandler;
        this.lobbyHub = lobbyHub;
        this.allowedOrigins = allowedOrigins.split("\\s*,\\s*");
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/ws/signal")
                .addInterceptors(new ClientIpHandshakeInterceptor())
                .setAllowedOrigins(allowedOrigins);
        registry.addHandler(lobbyHub, "/ws/lobby")
                .setAllowedOrigins(allowedOrigins);
    }

    /** WS 메시지 크기 제한 (과대 페이로드 차단). SDP 여유 위해 64KB. */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(64 * 1024);
        container.setMaxBinaryMessageBufferSize(64 * 1024);
        return container;
    }
}
