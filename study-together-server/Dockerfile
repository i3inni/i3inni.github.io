# ── 1단계: 빌드 (Gradle 이미지 사용 → wrapper 불필요) ──
FROM gradle:8.7-jdk17 AS build
WORKDIR /app
COPY settings.gradle build.gradle ./
COPY src ./src
RUN gradle clean bootJar --no-daemon

# ── 2단계: 실행 (가벼운 JRE) ──
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/build/libs/*.jar app.jar
# 환경변수는 docker-compose / 런타임에서 주입 (이미지에 비밀값을 굽지 않는다)
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
