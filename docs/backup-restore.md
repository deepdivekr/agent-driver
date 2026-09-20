# 일관된 백업과 격리 복원

Linux 운영자 전용 기능이다. 실행 중 SQLite의 WAL까지 한 read transaction에 고정하고 Node의 online backup으로 복사한다. DB 파일만 복사하거나 WAL을 삭제하지 않는다. runtime schema6/7만 받으며 실제 schema·integrity·foreign key·event/outbox 일관성을 검사한다. 원본 schema6은 그대로 두고 백업 사본만 schema7로 올린다.

## 계약

- 백업 시점의 project/task/intent/event/cursor와 등록된 spool·handoff 사본을 보존한다. 원본 snapshot 요약과 격리된 사본 요약을 구분한다.
- 진행 중 spool은 snapshot의 길이와 SHA256에 일치하는 prefix만 복사한다. snapshot 이후 추가 출력은 포함하지 않는다. 누락·변경·pruning·소유권 미등록 legacy spool은 오류다. 이미 pruned인 사본은 복구되지 않고 DB의 만료 기록만 남는다.
- 기본128MiB, 허용1–512MiB의 완성 bundle 예산, 파일 최대16MiB·10000개, 64KiB copy buffer다. 실제 여유 공간도 검사한다. 이는 디스크 hard quota·전체 메모리/CPU 상한이 아니다. SQLite 진행 callback의120초 deadline도 OS syscall의 hard timeout은 아니다.
- 새 디렉터리만 만들며 기존 목적지에 덮어쓰지 않는다. 디렉터리0700/파일0600, 파일·디렉터리 fsync와 최종 manifest rename을 사용한다. 실패한 staging은 보존한다. 완료 여부는 디렉터리 존재가 아니라 검증되는 `manifest.json`으로 판단한다.
- `.agent-driver-maintenance.json`은 첫 DB byte보다 앞서 durable하게 생성되는 **영구 실행 차단 표식**이다. 완료되더라도 제거하지 않는다. 백업 DB 자체에도 quarantine과 별도 identity를 확정하므로 완성 DB를 다른 폴더로 복사해도 일반 runtime은 거절한다. 부분 복사본을 직접 추출하거나 DB/표식을 수정해 실행하는 것은 지원하지 않는다.
- 복원은 이미 잠긴 백업을 새 디렉터리로 복사하고 새 instance/provenance를 확정한다. 일반 RuntimeStore/API/MCP/supervisor는 열지 못한다. 현재 실행 중인 store도 identity가 바뀌면 새 transaction/lease dispatch를 거절한다.
- 백업 이후 실제로 수행된 작업은 옛 snapshot에 없을 수 있다. `queued`도 미실행 증명이 아니므로 `post_snapshot_effects=unknown`, `automatic_execution=false`다. 모든 과거 세션·lease·worker 신원은 기록이지 새 실행권이 아니다.

**격리 복원 ≠ 정상 업무 재개.** worktree, 로그인/auth, 브라우저 profile, CLI cache, verifier snapshot, 미등록 자료를 복원하지 않는다. 프로젝트 파일과 외부 효과를 현재 시점에 재관측하는 운영 복구 절차·선택적 조정·activation·설정/버전 migration은 후속 출시 gate다. DB를 수동 편집해 quarantine을 해제하는 방법은 제공하지 않는다.

## 운영자 명령

Linux/Ubuntu/WSL Bash에서 설치한 저장소의 상위 디렉터리에서 시작한다. 아래 DB 경로는 demo 기본값이며 host 설정의 data directory가 다르면 실제 `dbPath`로 바꾼다. 목적지는 매번 존재하지 않는 새 폴더를 지정한다.

```bash
cd agent-driver
node dist/cli.js maintenance backup --db .runtime/runtime.sqlite --destination ../agent-driver-backup-01
node dist/cli.js maintenance inspect --backup ../agent-driver-backup-01
node dist/cli.js maintenance restore --backup ../agent-driver-backup-01 --destination ../agent-driver-restored-01
node dist/cli.js maintenance inspect --backup ../agent-driver-restored-01
node dist/cli.js maintenance checkpoint --db .runtime/runtime.sqlite
```

`backup` 출력의 `manifest_sha256`을 별도의 신뢰된 기록에 보존하고 `inspect`/`restore`의 `--expected-sha256`으로 대조할 수 있다. hash는 무결성 비교이지 서명·인증·복원 권한이 아니다. bundle과 hash를 모두 바꾸는 동일 사용자 공격자에 대한 보안 보장은 없다. DB/spool/handoff는 민감한 private 자료다. 공개 Git·issue·CI artifact·원격 저장소에 올리지 않는다. 명령 출력은 기록 개수와 식별자이며 원문 prompt·출력 본문을 보여주지 않는다.

`checkpoint`는 PASSIVE다. 다른 reader가 있으면 `fully_checkpointed=false`가 정상일 수 있고, 관측된 log/checkpointed frame을 반환한다. busy를 숨기거나 자동 TRUNCATE/VACUUM/WAL 삭제로 해결하지 않는다. 완료돼도 작업 실행·성공·복구 승인이 아니다.

MCP 도구 수/권한에는 변경이 없다. 모델 입력으로 파일 경로를 골라 backup·restore·quarantine 해제를 실행하는 도구를 제공하지 않는다.

## 검증 범위

실제 SQLite/WAL, 별도 프로세스 writer, reader-held checkpoint, source schema6, spool prefix/handoff, 10개 SIGKILL cut point(backup6/restore4), 해시/인벤토리 누락·경로/링크·불필요 WAL·schema 주입·기존 대상 충돌, snapshot 이후 효과의 no-replay를 검사한다. 합성 업무 기록을 사용하는 OS/DB 통합 증거이며 전원 상실·실사용 모든 업무의 정상 복구·Windows 인증으로 확대하지 않는다.
