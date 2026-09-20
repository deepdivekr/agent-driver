# 독립 합성 업무 soak

목표는 실제 경과 시간 동안 같은 DB·브라우저 프로필·terminal host에 누적 상태를 남기며 기능과 복구를 관찰하는 것이다. 모델/API는 호출하지 않는다. Chromium·SQLite·프로세스·자원 제한은 실제 Linux 실행이며 CLI는 공개 테스트 helper의 합성 stream-json 프로토콜이다. 실제 Claude/코딩 업무·쇼핑·실사이트·Windows·로그인/CAPTCHA·오케스트레이터 자율 판단 인증은 아니다.

## 사전 고정 프로토콜

초기 독립 lane에서 intent 직후 worker를 끊고 NOT_MATCH/불확실 정지를 확인한다. 이 DB/profile을 끝까지 보존하고 새 효과가 없음을 계속 검사한다. 이후 같은 auto/prepare lane에서 normal, claim 후 중단, prepare_only의 명시 재개, save 후 중단을 반복한다. 저장값·계정 sentinel·server effect counter를 실행 응답과 독립 대조한다. 정상 요청을 같은 ID로 중복 제출해 단일 효과를 확인한다.

16-cycle 일정은 source의 schedule에 고정한다. CLI는 정상 여러 턴, 명시 resume, receipt 직후 SIGKILL, 완료 후 host SIGKILL, gateway 재접속, 유한 출력 부하/취소를 포함한다. fixture receipt UUID count와 실제 result/turn state를 함께 확인한다. 알려진 불확실 턴은 자동 재전송하지 않는다. Browser fault hook은 checkpoint에 도달하기 전 startup timeout이 나면 다시 armed 상태로 남지만, 정확한 세대의 kill이 전달된 뒤에는 제품의 정상 복구를 방해하지 않는다. `fault_path`는 checkpoint kill과 checkpoint 전 prepare-only startup timeout을 구분해 남긴다. 후자는 외부 효과 없이 `ready_to_resume`으로 끝나야 하며 명시 prepare/resume 뒤의 독립 readback까지 확인한다. receipt 뒤 kill과 출력 취소는 세션 용량을 의도적으로 소비하므로 한 run에서 각각 한 번만 주입하고, 이후 일정에서는 해당 불확실 상태와 재개 거절을 다시 관측한다. 이것은 신규 장애를 주입했다고 세지 않는다. supervisor 교체와 명시 재개는 시험 오케스트레이터의 계획된 동작이며 제품 OS watchdog의 자동 복구나 사람이 필요 없다는 증거가 아니다.

특히 receipt 이후 CLI가 죽으면 `process_exited` 같은 정상 재개 상태로 바꾸지 않는다. 턴은 `uncertain`, 세션은 `reconciliation_required`로 남고 같은 세션 재개 요청은 거절되어야 한다. 이는 실패를 숨기지 않는 oracle이며, 다음 업무는 새 명시 세션에서만 시작할 수 있다.

유한 출력 부하도 receipt 뒤에는 명시적으로 취소한다. 이 역시 `uncertain`/`reconciliation_required`이며, cancel을 정상 완료나 자동 재개로 바꾸지 않는다. 제어 ping과 receipt 1회가 맞더라도 이 상태는 별도 보관한다.

첫 예상 밖 상태·효과 수·타깃/계정 오류·재전달 불일치·제어 응답 실패·자원 거절·저장 상한·입력 변경·관측 deadline 실패에서 새 업무를 중지한다. 성공 기준이나 worker startup 최대15초(원래 request deadline 이내)/시도3회/request deadline60초를 완화하지 않는다.

7개 운영 지표를 각각 낸다: 전체 제출 완료율과 실행 가능 사례 성공률; 간섭/대상 오류; 거짓 성공/중복; 자동복구/명시재개/올바른 정지; 의존성이 다시 준비된 뒤 복구 p50/p95; technical/auth/시험 개입 구분; 자원 표본. Windows 간섭·실인증·out-of-band 기술 개입은 미관측/N/A이며 0으로 채우지 않는다. 정상 대기를 성공률 분모에서 숨기지 않는다. 메모리/CPU/PID는 실제 aggregate cgroup 상한, 디스크는 앱 수준 관측/중단이며 OS hard quota가 아니다.

기간은 setup/cleanup과 분리한 monotonic 실제 workload 시간이다. max_cycles에 먼저 닿으면 실패하며 남은 시간을 잠만 자서 채우지 않는다. 2시간 gate는 요청/관측 시간이 모두 2시간 이상이고 일정 coverage와 최소100cycle을 충족해야 한다. 짧은 실행은 2시간 gate NOT_RUN이다. 72시간/7일/30일/90일은 각각 추가 실제 관측이 필요하다.

## 실행

Ubuntu/WSL Bash, 설치 저장소 기준:

```bash
cd agent-driver
npm ci
npm run build
node dist/cli.js soak start --config-file examples/soak.json
node dist/cli.js soak status --run .runtime/soak-two-hour
node dist/cli.js soak stop --run .runtime/soak-two-hour
```

시작은 새 소유 디렉터리만 허용한다. 기존 run을 덮어쓰거나 자동 재시작하지 않는다. 기본 `.runtime` 부모는 자동 생성하지만, 다른 `output_dir` 부모는 소유한 일반 디렉터리로 먼저 만들어야 하며 symlink는 거절된다. Linux user systemd/cgroup v2가 필요하며 검증되지 않은 무제한 fallback은 없다. 별도 transient service에서 실행되므로 시작 CLI/Codex의 종료가 시험을 끝내지 않는다. 상태는 kernel process identity/liveness, heartbeat freshness, 업무 진행, 최종 결과를 구분한다. 자기 heartbeat만으로 crash 복구를 주장하지 않는다.

manifest/input hashes, launch unit, heartbeat, append-only journal, progress, 최종 report를 run 디렉터리에 보존한다. 로그에는 합성값만 있지만 경로·PID·DB/profile은 private 운영 자료로 취급해 공개 커밋하지 않는다. stop은 이 run의 정확한 무작위 resource domain만 확인 후 중지하며 이미 생긴 효과를 되돌리지 않는다. 완료된 run의 stop은 비어 있는 소유 domain을 정리한다. 파일은 자동 삭제하지 않는다.

최종 report가 없는데 프로세스가 죽었으면 interrupted이며 PASS가 아니다. service/DB/실행 파일을 바꾸지 않은 동일 핸들을 관찰한다. 관측 timeout만으로 복제 실행하지 않는다. status는 상태 조회이며 중지/복구 승인이나 외부 쓰기를 발생시키지 않는다.

실행기 자체가 강제 종료되면 별도 terminal host 서비스가 남을 수 있다. 이 경우에도 동일한 CPU/메모리/PID 상한이 적용되지만 자동 정리나 OS watchdog을 보장하지 않는다. 동일 run에 `soak stop`을 실행해 확인된 소유 domain 전체를 정리한다. 이런 중단은 완료 기록으로 보정하지 않는다.
