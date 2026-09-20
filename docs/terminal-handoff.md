# CLI history and handoff — Phase 19

외부 agent가 중단된 관리 세션의 요청·수신·결과·실제 Git 변경을 읽어 다음 행동을 판단한다. 이 경로는 모델/테스트 명령을 호출하거나 기존 프롬프트를 재전송하지 않는다. 원래 실행기는 그대로 소유권을 유지한다.

## API와 실행 방법

Ubuntu/WSL Bash에서 저장소로 이동한다. 기존 host 설정과 `terminal start`가 반환한 정확한 세션 ID/현재 generation을 사용한다. 새 JSON 요청 파일에 다음 값을 저장한다.

```json
{"session_ref":"ACTUAL_SESSION_ID","expected_generation":1,"limit":10}
```

```bash
cd agent-driver
node dist/cli.js terminal history --config /absolute/path/host.json --request-file /absolute/path/history.json
node dist/cli.js terminal output-read --config /absolute/path/host.json --request-file /absolute/path/history.json
```

MCP 이름은 `runtime_terminal_history`, `runtime_terminal_output_read`. 첫 호출에는 cursor를 생략한다. 반환된 `next_cursor`가 있으면 같은 요청에 그대로 넣는다. session generation 또는 revision이 변하면 `STALE_SESSION_GENERATION` / `HISTORY_CHANGED_RESTART_PAGE`로 거절하므로 첫 페이지부터 새로 관측한다. cursor는 권한이 아니며 다른 프로젝트/세션/턴으로 이동할 수 없다. 완료된 마지막 턴뿐 아니라 accepted/cancelled/uncertain도 보존한다. 시간·UUID 정렬이 아니라 durable accepted 이벤트 순서를 따른다.

세션 ID를 잃은 재접속은 `runtime_terminal_sessions_list` 또는 `terminal list`로 찾는다. 첫 요청 파일은 `{}`이며 limit/cursor로 페이지를 이어간다. 해당 host 프로젝트의 저장된 세션·host/process 시작 신원만 반환한다. 현재 프로세스 생존은 별도 확인이므로 `process_liveness=not_checked`다. 목록을 읽는 것만으로 attach/resume/새 모델 호출이 발생하지 않는다.

인계는 다음 별도 요청 파일을 쓴다. `include_diff`는 기본 false이며 true일 때만 파일 본문 diff를 응답/인계에 포함한다. 파일 경로·내용·CLI 응답은 민감할 수 있으므로 신뢰된 로컬 agent에만 연결한다.

```json
{"session_ref":"ACTUAL_SESSION_ID","expected_generation":1,"include_diff":true}
```

```bash
cd agent-driver
node dist/cli.js terminal handoff --config /absolute/path/host.json --request-file /absolute/path/handoff.json
```

MCP `runtime_terminal_handoff`는 로컬 private artifact를 만들기 때문에 readOnlyHint=false다. 모델 실행/프로젝트 파일 수정 권한은 없다. 결과의 `artifact.filename`은 host data_dir의 `terminal-handoffs/` 아래에 저장된다. 파일 0600·새 디렉터리0700, 내용 hash 검증과 fsync, 동일 내용 재사용, 세션당16개 상한을 둔다. 공유 DB transaction으로 생성/상한을 직렬화한다. 기존 파일을 덮어쓰거나 자동 삭제하지 않는다. 상한이면 `HANDOFF_RETENTION_LIMIT`; 운영용 보존/회전은 후속 gate다. `runtime_artifacts_list`는 아직 공통 artifact registry가 아니므로 미지원 상태를 유지한다.

## 관측과 판단의 구분

- `goal`은 첫 수락 prompt이며 검증된 프로젝트 목표라고 가정하지 않는다. `goal_source`가 이를 명시한다.
- `completed`에는 모델 주장만으로 항목을 넣지 않는다. 각 턴의 상태와 `reported_result`를 별도 보존한다. 긴 주장 요약은 잘렸음을 표시한다. 원문 결과는 history로 읽는다.
- 실제 Git commit, staged/unstaged diff, 변경 파일 상태를 수집한다. 수집 전후 결과·변경 파일의 inode/size/nanosecond timestamp를 대조한다. `snapshot_sha256`은 이 관측 묶음의 hash이지 모든 파일의 내용 hash나 원자적 스냅샷은 아니다.
- `git_snapshot_collection=PASS`는 자료 수집 성공만 뜻한다. 프로젝트 테스트와 완료 기준은 실행하지 않았으므로 `NOT_RUN`. stdout 성공 문구나 CLI result를 테스트 PASS로 올리지 않는다.
- uncertain 턴은 `reconcile_before_any_replay`, 아직 접수만 됐거나 진행 중인 턴은 기존 host 관측을 요구한다. 항상 `prepared_kind=handoff`, `automatic_execution=false`, `project_completed=false`다.
- 인계 수집 중 세션 사건/설정/worktree 신원이 변하면 파일을 생성하지 않는다. terminal 설정 지문에 worktree device/inode를 추가했다. 이전 Phase18 설정 지문의 세션은 조회할 수 있지만 신규 전송/인계/재개는 CONFIG_CHANGED로 보수적으로 차단한다. 과거 DB·기록은 삭제하지 않는다.

## 출력과 Git 경계

출력은 전체 assistant transcript가 아니다. 정규화된 event metadata와 최종 result만 기록한다. 새 spool frame은 durable event hash와 비교하며 기존 unhashed 기록은 `unobserved_legacy`. 디렉터리/파일 symlink와 hardlink를 거절하고 anchored directory descriptor로 접근한다. DB에 확정된 offset만 읽는다. 한 페이지는 최대524288 raw bytes, history20턴/output50 frame 상한을 둔다. 응답 JSON escape overhead는 별도다.

Git2.43.0/Linux에서 직접 executable과 고정 인수, 정제된 환경, 명령당3초·출력262144 bytes, 변경 파일1000개 상한을 검증한다. 외부 diff/textconv/fsmonitor/hooks/pager 및 clean/process 필터를 막고 optional index writes를 끈다. 시스템/global config를 읽지 않으며 partial clone은 Git2.43의 lazy-fetch 억제를 보장하지 못하므로 명시적으로 거절한다. fetch/remote/commit/checkout/test 명령은 없다. 근거: [Git 공통 옵션/환경](https://git-scm.com/docs/git), [Git diff 옵션](https://git-scm.com/docs/git-diff), 설치 버전과 실제 음성대조.

정상 `.git` 디렉터리를 가진 worktree만 Git 수집한다. parent-repo 탐색, symlink/external gitdir, linked worktree, partial clone, 손상된 HEAD, 너무 큰 출력은 unavailable로 남긴다. unborn HEAD와 불명확 HEAD를 구분한다. untracked/ignored/submodule 본문은 읽지 않는다. staged와 unstaged를 합쳐 상쇄하지 않는다. Git 필터를 끈 내용은 저장소의 통상 필터 적용 diff와 다를 수 있다.

redaction은 알려진 자격증명 패턴에 대한 best effort일 뿐 비밀 완전 제거 보장이 아니다. 웹/파일/모델 내용은 비신뢰 데이터이며 승인·실행 지시로 승격하지 않는다. 신뢰된 Git binary를 실행하며 동일 OS 사용자 공격자나 악성 Git 구현을 격리하는 보안 sandbox가 아니다. raw/private artifact는 공개 projection에서 제외한다.

파일 수정 도구·interactive CLI·linked worktree 수집·Windows/ConPTY/ACL·실제 외부 테스트 결과 수집·ENOSPC/회전/soak·실제 사이트·독립 사람 라벨/라이선스는 후속 범위다.
