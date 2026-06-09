# ════════════════════════════════════════════════════════════════
#  Railway 배포 전용 — 루트 컨텍스트에서 study-together-server(백엔드)를 빌드.
#  레포 루트에 Dockerfile이 있으면 Railway가 Staticfile 감지 대신 이걸 사용한다.
#  (GitHub Pages 는 Dockerfile 을 무시하므로 정적 사이트엔 영향 없음)
#  [study-together 기능 삭제 시: 이 파일 + /railway.json + study-together-server/ 제거]
# ════════════════════════════════════════════════════════════════

# ── 1단계: 빌드 (Gradle 이미지) ──
FROM gradle:8.7-jdk17 AS build
WORKDIR /app
COPY study-together-server/settings.gradle study-together-server/build.gradle ./
COPY study-together-server/src ./src
RUN gradle clean bootJar --no-daemon

# ── 2단계: 실행 (가벼운 JRE) ──
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
