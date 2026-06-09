package com.i3inni.studytogether.room;

import com.i3inni.studytogether.presence.PresenceRegistry;
import com.i3inni.studytogether.room.dto.CreateRoomRequest;
import com.i3inni.studytogether.room.dto.RoomResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 로비/방 REST API.
 *  POST /api/rooms          방 생성
 *  GET  /api/rooms          공개 방 목록(대기실)
 *  GET  /api/rooms/{code}   방 상세
 */
@RestController
@RequestMapping("/api/rooms")
@RequiredArgsConstructor
public class RoomController {

    private final RoomService roomService;
    private final PresenceRegistry presence;

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public RoomResponse create(@Valid @RequestBody CreateRoomRequest request) {
        Room room = roomService.create(request);
        return RoomResponse.from(room, presence.count(room.getCode()));
    }

    @GetMapping
    public List<RoomResponse> list() {
        return roomService.listOpen().stream()
                .map(room -> RoomResponse.from(room, presence.count(room.getCode())))
                .toList();
    }

    @GetMapping("/{code}")
    public RoomResponse get(@PathVariable String code) {
        Room room = roomService.get(code.toUpperCase());
        return RoomResponse.from(room, presence.count(room.getCode()));
    }
}
