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

    /** 방 비밀번호 (선택). 입력 시 입장하려면 이 비번을 맞춰야 함 */
    @Size(max = 30)
    private String password;
}
