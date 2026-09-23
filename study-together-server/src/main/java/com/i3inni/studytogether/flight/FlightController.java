package com.i3inni.studytogether.flight;

import com.i3inni.studytogether.flight.dto.FlightHistoryResponse;
import com.i3inni.studytogether.flight.dto.FlightLogResponse;
import com.i3inni.studytogether.flight.dto.SoloFlightRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;

/**
 * 비행 기록 REST API. 사용자 = 브라우저별 clientId.
 *  GET  /api/flights?clientId=            내 비행 기록 + 통계 (방 비행은 탑승객 참가 여부 포함)
 *  POST /api/flights/solo                 혼자 비행 이륙
 *  POST /api/flights/{id}/land?clientId=  착륙 (도착 전이면 중도 하차) — 탭 닫힘 시 sendBeacon
 *  POST /api/flights/{id}/resume?clientId= 새로고침 후 재탑승
 */
@RestController
@RequestMapping("/api/flights")
@RequiredArgsConstructor
@Validated
public class FlightController {

    private final FlightLogService service;

    @GetMapping
    public FlightHistoryResponse history(@RequestParam @NotBlank @Size(max = 64) String clientId,
                                         @RequestParam(defaultValue = "30") int limit) {
        return service.history(clientId, limit, Instant.now());
    }

    @PostMapping("/solo")
    @ResponseStatus(HttpStatus.CREATED)
    public FlightLogResponse startSolo(@Valid @RequestBody SoloFlightRequest request) {
        Instant now = Instant.now();
        return FlightLogResponse.from(service.startSolo(request, now), List.of(), now);
    }

    @PostMapping("/{id}/land")
    public FlightLogResponse land(@PathVariable long id, @RequestParam @NotBlank @Size(max = 64) String clientId) {
        Instant now = Instant.now();
        return FlightLogResponse.from(service.landSolo(id, clientId, now), List.of(), now);
    }

    @PostMapping("/{id}/resume")
    public FlightLogResponse resume(@PathVariable long id, @RequestParam @NotBlank @Size(max = 64) String clientId) {
        Instant now = Instant.now();
        return FlightLogResponse.from(service.resumeSolo(id, clientId, now), List.of(), now);
    }
}
