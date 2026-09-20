# 감독 프로세스와 안전한 복구

Phase 17은 **Linux의 같은 부팅 세션 + 합성 draft Task Pack**을 다룬다. 원문 Phase 07/08 전체 또는 Windows 재부팅 복구 완료가 아니다.

## 실행 경계

1. gateway는 단일 감독자를 확보하고, request ID와 입력/config hash를 SQLite에 접수한다. gateway가 사라져도 감독자의 queue 조회는 계속된다.
2. 감독자는 durable 예약 ticket과 실행 세대를 발급한다. worker는 그 ticket을 atomic claim하기 전에는 브라우저를 만들거나 쓰지 않는다. claim되지 않은 오래된 예약은 취소할 수 있으며 늦게 도착한 worker는 거부된다.
3. claim된 worker는 PID뿐 아니라 부팅 ID와 kernel 시작 tick으로 확인한다. 살아 있거나 확인 불가능하면 인계하지 않는다. 죽었어도 dedicated profile이 점유 중이거나 관측 불가하면 넘기지 않는다. 다른 프로세스를 kill하지 않는다.
4. intent가 없고 원래 deadline·config·재시작 한도가 유효할 때만 새 worker를 실행한다. 최대 3번의 시작 시도와 재개 전 400/800ms backoff를 사용한다. 시작 예약은 원래 deadline을 넘지 않는 최대 15초 뒤 무효화할 수 있지만 **claim된 worker의 사망을 15초 경과로 추정하지 않는다**. 이는 CPU 제한 아래에서 건강한 child가 첫 claim 전에 예약 철회되는 것을 막기 위한 유한 창이다.
5. intent가 하나라도 있으면 POST/save를 재전송하지 않는다. 앱의 account/run identity, record, identity를 독립 GET으로 대조한다. MATCH는 원하는 상태의 확인이며 외부 exactly-once 증명이 아니다. NOT_MATCH/UNKNOWN은 `reconciliation_required`로 유지하고 해당 profile의 다음 writer를 막는다.
6. worker가 SIGKILL로 종료되어 storage reservation의 normal cleanup을 건너뛰면, supervisor는 worker identity의 사망과 profile 해제를 각각 확인한 뒤 그 프로젝트의 **정확히 죽은 owner** reservation만 회수한다. alive/unknown owner는 회수하지 않는다. 이 내부 quota 정리는 외부 effect 재시도 승인이 아니다.

`profileOccupancy`는 Linux `/proc`의 정확한 `--user-data-dir` 값과 비교한다. 읽지 못하는 process가 있으면 보수적으로 UNKNOWN이다. 커널 격리나 악성 동일-사용자 프로세스에 대한 보안 경계가 아니다. headless는 사용자의 기존 Chrome과 연결되지 않지만 CPU/메모리 간섭까지 없다고 보장하지 않는다.

## 정책과 운영 명령

host.json의 `recovery_policy`는 `auto_resume`(기본) 또는 `prepare_only`다. 원래 요청에 허용된 1~120초 deadline을 늘리지 않는다. 부팅 ID가 바뀌거나 monotonic 접수 시점이 없는 과거 요청은 자동 실행하지 않는다. 설정 변경도 실제 저장 직전에 다시 확인한다.

Ubuntu/WSL Bash, 저장소 디렉터리 기준:

```bash
cd agent-driver
node dist/cli.js supervisor start --config .runtime/lab-01/host.json
node dist/cli.js supervisor status --config .runtime/lab-01/host.json
node dist/cli.js recovery status --config .runtime/lab-01/host.json
node dist/cli.js supervisor stop --config .runtime/lab-01/host.json
```

start는 API 접수 시에도 자동으로 호출된다. stop은 감독자만 협력적으로 중지하고 실행 중인 worker를 죽이지 않는다. gateway 종료 역시 중지 명령이 아니다. 테스트/서비스 정리 때 worker 종료까지 별도로 확인해야 한다. `supervisor serve`는 현재 프로세스에서 실행하는 운영 진입점이며, 외부 OS watchdog은 후속 구현이다. 감독자 사망 후 새로운 start/접수가 없는데 스스로 살아난다고 주장하지 않는다.

이전 demo의 `recover --task`는 supervisor가 관리하는 submission에 사용할 수 없다. 동일 DB를 명시하더라도 `MANAGED_RECOVERY_REQUIRES_SUPERVISOR`로 거부해 살아 있는 worker의 lease를 우회 회수하지 못하게 한다.

prepare_only에서 죽은 미전송 worker의 lease를 안전하게 정리한 뒤 `ready_to_resume`를 만든다. `recovery prepare TASK_ID --generation N`은 `prepared_kind=handoff`를 반환한다. 살아 있는 브라우저 세션 복원이 아니다. 이어서 `task resume TASK_ID --generation N`은 정확한 복구 세대와 원래 config/deadline을 다시 확인한다. 낡은 세대·불명확 쓰기·만료된 요청은 재개할 수 없다. 현재 prepare API는 이미 안전하게 준비된 행을 조회하는 범위이며 불명확 쓰기에 대한 수동 강제 재실행은 제공하지 않는다.

## 검증 범위와 남은 출시 조건

### 세대별 복구 진단

Phase25는 기존 event/outbox에 `worker.progress`, `worker.failure`, `recovery.observed`를 추가한다. 기존 events fetch/ack로 읽는다. progress/failure는 dispatch·recovery generation, 닫힌 stage/code, worker 시작 후 단조 경과 ms만 담는다. 원문 오류·stack·URL·입력·경로·인증값은 기록하지 않는다. 같은 stage/kind/attempt의 중복은 저장하지 않으며 최대 15단계 × 2종류다. 새 DB schema나 MCP 권한은 없다.

복구 관측은 launch 실패/사망, claim 최대 15초(원래 deadline 상한) 만료, 감독자 교체, claim 이후 worker 사망을 구분한다. `startup_timeout`은 예약 만료 판정이지 프로세스가 죽었다는 뜻이 아니다. `worker_dead`도 OS 수준 사망 관측이며 원인 확정이 아니다. browser launch/navigation/observation 경과와 failure code를 함께 확인해야 한다. unknown 또는 누락은 미관측이다. config 로드·DB open 이전 실패, DB 쓰기 자체 실패, SIGKILL 직전 간격에는 failure event가 없을 수 있다. 마지막 progress만으로 해당 단계가 실패 원인이라고 단정하지 않는다.

진단은 승인·재실행·완료 증거가 아니다. prepare_only가 다시 준비 상태가 된 경우 사용자 재개 승인을 자동 반복하지 않는다. intent 이후 불확실 효과는 계속 읽기 전용 조정하며 최대 15초 startup 제한·3회 launch 상한·원래 deadline은 그대로다.

[#22](https://github.com/deepdivekr/agent-driver/issues/22)의 Phase24 최초 prepare_only 재진입 실패는 사후 원인 미확정이며 마지막 효과 수는 미관측이다. 새 진단 및 후속 성공은 과거 원인의 소급 증명이 아니다. 확정된 원인과 회귀가 확보되기 전까지 이 이슈는 열린 출시 gate다.

Ubuntu/WSL Bash에서 독립 재개 반복을 기록할 수 있다. 매회 새 소유 프로필·프로세스로 실행하며 첫 실패에서 멈춘다. 합성 앱만 사용하고 모델은 호출하지 않는다.

```bash
cd agent-driver
npm run build
node scripts/runtime/recovery-repeat.mjs 20
```

`tests/evidence/recovery-repeat-*.json`은 각 실행 원본/hash·실제 effect count·시도 수·단계 기록과 경과 시간을 보존한다. 이는 동일 환경의 단기 반복이며 실사이트/CPU 압박/장기soak 신뢰도 인증이 아니다. CI artifact에는 합성 시험의 진단만 포함한다.

테스트는 실제 SQLite, owned headless Chromium, 별도 Node 프로세스와 SIGKILL을 사용한다. 서버의 별도 효과 counter를 기대값으로 삼는다. 접수→launch 전, claim 직후, browser 준비 후, intent 전/후, 저장 후, response 기록 후, verification 후를 끊는다. 서버는 저장했지만 브라우저 응답이 막힌 경우도 검증한다. 잘못된 identity, 살아 있는 worker, 점유 profile, stale ticket/generation, 취소/config 변경/deadline을 음성 대조군으로 둔다.

실제 사이트·다중 executor 인계·로그인/CAPTCHA·CLI host·native Windows identity/ConPTY·Task Scheduler/OS watchdog·재부팅/전원 상실·backup restore·disk pressure·장기 soak·독립 실제 사용자 라벨은 아직 출시 gate다. Linux 결과를 해당 gate의 PASS로 표시하지 않는다.
