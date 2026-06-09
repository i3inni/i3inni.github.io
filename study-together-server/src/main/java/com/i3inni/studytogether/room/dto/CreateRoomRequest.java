package com.i3inni.studytogether.room.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class CreateRoomRequest {

    @NotBlank
    @Size(max = 40)
    private String title;

    @NotBlank
    @Size(max = 20)
    private String hostName;

    @Size(max = 30)
    private String departure;

    @Size(max = 30)
    private String destination;

    @Min(1)
    @Max(600)
    private int durationMinutes;
}
