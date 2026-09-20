# CLI 출력과 제어 응답성

## 계약

구조화 CLI의 stdout을 pull 방식으로 읽는다. 한 번에 최대 64 KiB의 chunk만 유지하며, 한 처리 구간은 최대 64 KiB·8개 frame·32ms 중 먼저 도달한 경계에서 양보한다. 시간 경계는 **현재 동기 작업을 마친 뒤** 확인한다. 구간 사이 5ms 휴지로 다른 프로세스의 SQLite writer도 lock을 획득할 기회를 준다. 메모리에 전체 출력이나 파싱한 이벤트 목록을 쌓지 않는다.

Node readable buffer는 128 KiB를 넘으면 실패로 처리한다. 이것은 입력 스트림의 관측/거부 상한이며 OS pipe나 자식 프로세스의 메모리 상한이 아니다. 미완성 frame은 기존 1 MiB UTF8 bound를 유지한다. JSON 객체·문자열 표현의 전체 RSS가 이 합계와 같다는 뜻도 아니다. CPU/memory/PID 제한은 별도의 host resource 설정이다.

파일 spool은 기존 순서·frame hash·global offset·WAL/FULL transaction과 파일 fsync를 유지한다. directory fsync는 새 segment 생성 시 수행하고, 기존 파일 append에는 파일 fsync를 적용한다. 이 변경은 전원 상실 인증을 의미하지 않는다. 예산·segment 회전·부분 쓰기 실패·변조/누락 검사는 유지한다.

EOF는 대기 중 frame이 모두 처리된 뒤 검증한다. process close 관측도 이 뒤에 전달한다. 명시적 stop/실패는 대기 출력을 버리고 pipe를 drain하며 소유 child만 종료한다. 중단은 이미 발생한 효과를 되돌리지 않는다. host가 중단을 적용하기 전 도착한 정상 결과는 알려진 완료 증거로 보존할 수 있지만, cancel flag가 있으면 input_ready로 승격하지 않는다. 중단 적용 후 도착한 결과로 불확실 턴을 완료 처리하지 않는다. 불확실 prompt는 자동 재전송하지 않는다.

단일 filesystem/SQLite 동기 호출, 공유 OS 자원과 외부 부하는 여전히 지연시킬 수 있다. 이는 hard real-time 서비스가 아니며 아래 수치는 해당 시험 환경의 관측이다.

## 독립 부하 runner

저장소 checkout의 Linux/Ubuntu/WSL Bash에서:

```bash
cd agent-driver
npm ci
npm run build
node scripts/runtime/output-load.mjs --run --duration-ms 60000
```

500~540000ms의 명시적 유한 관측만 허용한다. 별도 host와 두 synthetic CLI를 직접 띄운다. 첫 세션은 유한 50000개 frame을 pipe backpressure를 지키며 출력하고, 다른 세션은 짧은 턴을 처리한다. 모델/API/사용자 브라우저/로그인을 사용하지 않는다. 실행 중 진행 파일과 최종 JSON, `tests/report.json`을 남긴다. 내부 임시 worktree는 소유 자식의 사망 확인 후에만 정리한다. 전역 프로세스나 사용자 파일은 건드리지 않는다.

독립 controller가 ping/status/다른 세션 submit/interrupt-to-dead를 잰다. 표본마다 host·CLI RSS와 data directory의 logical/allocated byte 큰 값을 기록한다. RSS는 표본 관측이지 커널 lifetime peak가 아니다. timeout과 실패도 남기며, 지연된 polling 완료 시각은 실제 완료의 상계다. 시작/종료 overhead와 requested duration/actual duration을 구분한다. 합성 CLI 부하 성공을 실제 Claude의 모델 판단 성공으로 합치지 않는다.

개발 gate: ping <=1초, 다른 세션 submit <=1초, interrupt→소유 child 사망 <=3초. 출력 quota/EOF/회복 계약은 별도 시험이다. 변경 전 host ping timeout·submit 실패·6.13초 interrupt 표본을 보존했다. 최종 실측은 PR/CI receipt에 결속한다.

2026-09-20 WSL Linux 개발 관측: 요청60000ms/실제부하60039ms, ping248/248 성공·최대168.26ms, status최대147.85ms, 다른 세션 입력접수287.24ms/완료관측746.90ms, interrupt→dead112.45ms. 최종 정규화 spool914356bytes/data6488064bytes, 표본 RSS 최대host134107136/CLI58138624bytes. 소유 child2개 모두 종료, 불확실 턴을 완료 처리하거나 재전송하지 않음. 60초 한 표본이며 새로운 머신/부하에 이 수치를 보장하지 않는다.

## 남은 범위

9분 이하 개발 부하 runner는 원문 72시간/7일/30일 운영 soak 도구 전체를 대신하지 않는다. 전체 설치 storage hard quota, snapshot/staging 회수, 자동 재시작을 포함한 장기 운영 관측, Windows ConPTY/UI 비간섭, 일반 프로젝트·실제 사이트 및 외부 오케스트레이터 검증은 별도 gate다. 이 단계로 공식 릴리즈 완료를 주장하지 않는다.
