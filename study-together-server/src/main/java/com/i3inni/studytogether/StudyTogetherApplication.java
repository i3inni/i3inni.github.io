package com.i3inni.studytogether;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class StudyTogetherApplication {

    public static void main(String[] args) {
        SpringApplication.run(StudyTogetherApplication.class, args);
    }
}
