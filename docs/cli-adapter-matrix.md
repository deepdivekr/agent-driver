# CLI adapter — Phase 18, structured protocol only

2026-09-20. Claude Code **2.1.126**, Node22.22.0. Linux/WSL에서 별도 소유 host와 실제 CLI 구독 인증을 시험했다. native Windows ConPTY, interactive TUI, 실제 코드 수정, 임의 사용자 터미널 연결은 지원 완료가 아니다.

## 검증 근거와 상태

|계약|설치 버전에서 확인한 근거|현재 판정|
|---|---|---|
|공식 session ID|`--session-id UUID`, 실제 `session_id` 일치|구조화 모드 검증|
|명시적 재개|`--resume UUID`, 종료된 소유 세션의 기억 유지|완료된 턴 뒤 재개만 허용|
|구조화 입출력|`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`|실제 CLI + 합성 교란 검증|
|입력 수신|`user.uuid`와 입력 UUID 일치, prompt echo 일치|단일 활성 턴과 함께 결속|
|턴 완료|동일 session의 공식 `result`, 앞선 수신 확인 필수|성공도 프로젝트 완료는 아님|
|입력 준비|현재 child 시작 신원·살아 있는 writable stdin + 단일 writer|host 관측이며 공식 CLI ready 이벤트가 아님|
|도구 승인 대기|result의 `permission_denials`|계약 주입 검사; 실제 도구 실행은 꺼짐|
|인증·한도·컨텍스트 대기|설치 버전의 모든 실패 payload는 미검증|추측하지 않고 state_unknown/보수적 중단|
|rate_limit_event|정상 성공 턴에서도 관측됨|이름만으로 rate_limited 처리하지 않음|
|대화형 PTY/ConPTY|구조화 JSON 검증과 다른 입력 경로|미구현/미검증; native ConPTY BLOCKED_ENV|

공식 자료: [CLI reference](https://code.claude.com/docs/en/cli-reference), [programmatic use](https://code.claude.com/docs/en/headless), [permissions](https://code.claude.com/docs/en/permissions). 현재 웹 문서는 설치 버전보다 새 옵션/동작을 포함한다. 따라서 설치된 `--help`와 실제 이벤트를 우선했다. `--bare`는 구독 인증 경로에 쓰지 않으며, 최신 문서에만 있는 제한 옵션을 가정하지 않는다.

실제 제품 host 시험은 서로 다른 3턴과 명시적 재개 후 1턴 모두 PASS. 마지막 취소 race 보강 뒤에도 실제4턴을 다시 통과했다. 관측 모델은 Claude Sonnet4.6이며 최종 첫 턴 약5.7초, 후속1.6/1.7초, 재개 후13.2초였다. 작은 합성 프로토콜 시험이므로 코딩 성능, 도구 간 우위, 종단 업무 성공률의 근거가 아니다. 별도 초기 프로토콜 probe4회, 최초 제품시험3회, 수정 후4회, 최종 보강 후4회로 **구독 prompt 15회**를 보냈다. CLI 내부 inference 요청 수는 미관측이다. 기존 Luna/Jev API 평가 장부와 합산하지 않는다.

첫 제품시험은 3턴 PASS 뒤 시험 스크립트가 `INTERRUPTED → child close`의 비동기 전이를 너무 일찍 FAIL로 판단했다. 초기 FAIL을 보존하고 완료된 턴 중단/재개 회귀를 추가했다. 합성 테스트 초기5개 FAIL은 테스트 함수의 지역변수 shadowing 오류였으며 원본 결과를 남겼다.

추가 취소 race3건은 실제 제품 오류를 재현한 뒤 수정했다. 시작 전 interrupt는 child를 띄우지 않아야 하고, 시작 전 task cancel은 다른 세션 host를 실패시키면 안 되며, 완료 result와 취소가 경합해도 완료 증거는 보존해야 한다. 세 회귀의 초기FAIL과 수정 후PASS를 모두 기록했다. 새 세션과 resume 예약은 같은4세션 상한을 공유한다.

## 실행 경계

host는 gateway/브라우저 supervisor와 별도 프로세스다. Unix socket의 private directory/토큰 challenge와 host instance/kernel identity로 재연결한다. PID만으로 stdin을 새로 획득하거나 종료하지 않는다. 입력은 직접 spawn한 child stdin에 JSON 데이터로만 전달하며 shell/SendInput/Chrome 연동을 사용하지 않는다.

SQLite v4에 session/turn/host를 보존한다. project/worktree/executable/version/session UUID/host instance/process identity/generation/turn을 확인한다. 접수·dispatch intent·공식 수신·result·입력 준비를 각각 기록한다. 같은 ID/동일 인수는 기존 turn을 반환하고 충돌·오래된 generation·이전 턴 불일치·스트리밍 중 입력을 거절한다.

기존 demo용 generic `cancel --task`/`recover --task`는 managed terminal 작업을 거절한다. terminal-aware 공통 API의 취소 또는 terminal interrupt를 사용해야 하며, 이전 명령이 pending CLI 효과를 건너뛰고 취소 완료처럼 표시할 수 없게 했다.

host 사망과 CLI 사망을 구분한다. host가 살아 있으면 IPC로 같은 transport를 사용한다. 죽은 host의 child가 살아 있거나 신원 불명이면 attach/kill/resume하지 않는다. child 사망이 확인되고 모든 dispatch가 완료된 경우에만 명시적 UUID resume가 가능하다. 결과 불명확 턴은 reconciliation_required이며, resume가 미완료 턴을 자동 실행할 수 있으므로 준비 모드도 자동 resume하지 않는다.

출력은 프레임1MiB 상한, session별 기본4MiB private spool, fsync 후 DB offset 순서로 저장한다. 디스크 기록 불일치/과다/알 수 없는 프로토콜은 입력을 중단하고 소유 child만 종료한다. 종료·budget·반복 결과는 오케스트레이터에 재검토 신호를 보내며 새 prompt를 스스로 만들지 않는다. 반복 문자열은 진전 없음의 확정 판정이 아니라 추가 diff/test 확인 신호다.

공개 상태 API는 현재/마지막 턴 결과와 프로세스 신원을, events API는 전달 가능한 상태/출력 메타데이터를 제공한다. private spool은 감사용 로컬 파일이며 전체 assistant 스트림을 그대로 복제하지 않는다. 과거 모든 턴 내용·spool을 외부 agent가 scope 검사와 함께 조회하는 전용 API는 아직 없고 후속 구현이다.

기본 CLI 도구는 계속 `tools=[]`만 허용한다. Phase20에서는 별도 host의 `terminal.files` 위임으로 runtime 소유 MCP read_file/write_file만 연다. 실제 Claude 2.1.126의 assistant tool_use/user tool_result와 broker의 durable 결과를 결속한다. 상세 범위·실측·제약은 [파일 작업 계약](terminal-file-effects.md)을 따른다. Bash·다른 MCP·Chrome·hooks는 비활성 상태다. 일반 프로젝트 빌드·interactive·Windows 완성판이나 같은 OS 사용자 공격자를 막는 보안 sandbox는 아니다. 실제 인증/사용자 파일을 public test에 넣지 않는다.

## 실험적 사용

Ubuntu/WSL Bash에서 저장소로 이동해 빌드한다. Claude2.1.126의 기존 인증이 준비된 경우, 신뢰된 host JSON에 다음 terminal 항목을 추가할 수 있다. worktree는 소유 작업 디렉터리, data_dir는 private 상태 경로여야 한다. 실제 executable 절대 경로를 넣으며 임의 추가 CLI args는 받지 않는다.

```json
{"terminal":{"executable":"/opt/claude/bin/claude","version":"2.1.126","mode":"structured","tools":[],"max_turns":20,"turn_deadline_ms":120000,"spool_bytes":4194304}}
```

완전한 host 설정의 project_id/caller_ref/account_ref/worktree/data_dir/schema_version은 [Agent interface](agent-interface.md)를 따른다. terminal 추가로 project binding이 바뀌므로 기존 fixture DB에 억지로 섞지 말고 새 data_dir를 사용한다.

```bash
cd agent-driver
npm run build
node dist/cli.js terminal start --config host.json --request-file start.json
node dist/cli.js terminal status SESSION_ID --config host.json
node dist/cli.js terminal submit --config host.json --request-file prompt.json
node dist/cli.js terminal stop-host --config host.json
```

`start.json`: `{"request_id":"owned-session-1"}`. `prompt.json`에는 `request_id`, 반환된 `session_ref`, `expected_generation`, `expected_previous_turn_id`(첫 턴은 null), `prompt`를 넣는다. status가 input_ready가 된 뒤에만 submit한다. resume/interrupt는 `{session_ref,expected_generation}` 파일을 같은 방식으로 전달한다. 승인 발급·raw terminal write 도구는 없다. 자동으로 새 세션을 찾아 연결하지 않는다. 기존 사용자 Claude/Windows Terminal 세션을 조작하지 않는다.

MCP의 다섯 terminal 도구는 같은 API를 사용한다. 독립 host 종료는 이 runtime이 직접 소유한 child만 중단한다. SIGKILL된 host의 orphan CLI는 PID를 근거로 강제 종료하지 않으며, 별도 상태 확인이 필요할 수 있다. 데이터 보관/삭제·OS watchdog·재부팅/전원 상실·backup·장기 soak·Windows Job Object/ACL은 추가 출시 gate다.
