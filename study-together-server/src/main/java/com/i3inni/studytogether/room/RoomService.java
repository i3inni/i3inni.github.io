package com.i3inni.studytogether.room;

import com.i3inni.studytogether.room.dto.CreateRoomRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.List;

@Service
@RequiredArgsConstructor
public class RoomService {

    // 헷갈리는 문자(0/O, 1/I 등) 제외한 코드 알파벳
    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final int CODE_LEN = 6;
    private final SecureRandom random = new SecureRandom();

    private final RoomRepository repository;

    @Transactional
    public Room create(CreateRoomRequest req) {
        String code;
        do {
            code = generateCode();
        } while (repository.existsById(code));

        Room room = Room.builder()
                .code(code)
                .title(req.getTitle())
                .hostName(req.getHostName())
                .departure(blankToDefault(req.getDeparture(), "출발지"))
                .destination(blankToDefault(req.getDestination(), "목적지"))
                .durationMinutes(req.getDurationMinutes())
                .status(RoomStatus.WAITING)
                .createdAt(Instant.now())
                .build();
        return repository.save(room);
    }

    @Transactional(readOnly = true)
    public List<Room> listOpen() {
        return repository.findByStatusInOrderByCreatedAtDesc(
                List.of(RoomStatus.WAITING, RoomStatus.FLYING));
    }

    @Transactional(readOnly = true)
    public Room get(String code) {
        return repository.findById(code)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "방을 찾을 수 없어요"));
    }

    /** 방장이 이륙 → 비행 시작 */
    @Transactional
    public Room start(String code) {
        Room room = get(code);
        room.setStatus(RoomStatus.FLYING);
        room.setStartedAt(Instant.now());
        return room;
    }

    @Transactional
    public boolean deleteIfExists(String code) {
        if (repository.existsById(code)) {
            repository.deleteById(code);
            return true;
        }
        return false;
    }

    private String generateCode() {
        StringBuilder sb = new StringBuilder(CODE_LEN);
        for (int i = 0; i < CODE_LEN; i++) {
            sb.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    private String blankToDefault(String value, String fallback) {
        return (value == null || value.isBlank()) ? fallback : value.trim();
    }
}
