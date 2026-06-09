package com.i3inni.studytogether.room;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.time.Instant;

@Entity
@Table(name = "rooms")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Room {

    /** 방 코드(=초대 코드)를 PK로 사용 */
    @Id
    @Column(length = 8)
    private String code;

    @Column(nullable = false, length = 40)
    private String title;

    @Column(nullable = false, length = 20)
    private String hostName;

    @Column(length = 30)
    private String departure;

    @Column(length = 30)
    private String destination;

    @Column(nullable = false)
    private int durationMinutes;

    /** 방 비밀번호(BCrypt 해시). null = 공개방. (해시 60자라 100 길이, 새 컬럼명) */
    @Column(name = "pw_hash", length = 100)
    private String password;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 12)
    private RoomStatus status;

    @Column(nullable = false)
    private Instant createdAt;

    private Instant startedAt;
}
