package com.i3inni.studytogether.flight;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface FlightLogRepository extends JpaRepository<FlightLog, Long> {

    Optional<FlightLog> findByFlightKeyAndClientId(String flightKey, String clientId);

    List<FlightLog> findByFlightKeyAndStatus(String flightKey, FlightStatus status);

    /** 방 비행 탑승객 명단(참가 여부) — 탑승 순 */
    List<FlightLog> findByFlightKeyInOrderByJoinedAtAsc(Collection<String> flightKeys);

    List<FlightLog> findByClientIdOrderByStartedAtDesc(String clientId, Pageable pageable);

    List<FlightLog> findByClientIdAndModeAndStatus(String clientId, FlightMode mode, FlightStatus status);

    List<FlightLog> findByStatusAndPlannedEndAtLessThanEqual(FlightStatus status, Instant now);

    long countByClientId(String clientId);

    long countByClientIdAndStatus(String clientId, FlightStatus status);

    @Query("select coalesce(sum(f.focusedSeconds), 0) from FlightLog f where f.clientId = :clientId")
    long sumFocusedSeconds(@Param("clientId") String clientId);
}
