package com.i3inni.studytogether.room;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;

public interface RoomRepository extends JpaRepository<Room, String> {

    /** 로비에 노출할 방(대기/비행 중) 목록 — 최신순. 비밀번호 방도 목록엔 노출(🔒). */
    List<Room> findByStatusInOrderByCreatedAtDesc(Collection<RoomStatus> statuses);
}
