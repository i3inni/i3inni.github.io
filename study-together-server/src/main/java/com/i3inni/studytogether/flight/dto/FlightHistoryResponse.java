package com.i3inni.studytogether.flight.dto;

import lombok.Builder;
import lombok.Getter;

import java.util.List;

@Getter
@Builder
public class FlightHistoryResponse {

    private long totalFlights;
    private long completed;
    private long left;
    private long totalFocusedSeconds;
    private List<FlightLogResponse> flights;
}
