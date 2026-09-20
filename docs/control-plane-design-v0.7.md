# MVP v0.7 — 평가 근거를 반영한 구현 기준

2026-09-20. v0.5 원문과 v0.6 제안은 보존한다. 이 문서는 신규 구현의 우선 기준이다. 미검증 기능을 삭제하거나 완료로 바꾸지 않는다.

## 제품과 첫 구현 범위

사용자의 작업을 방해하지 않는 실행 환경에서 에이전트가 맡긴 브라우저·코딩 CLI 업무를 실행하고, 소유권·중단·복구·완료 증거를 관리하는 실행 control plane.

Phase 15는 durable core, deterministic guard/router, CLI, owned headless test-app 저장 경로를 구현한다. 첫 경로는 사용 가능한 제품 기반이지 범용 사이트 지원 MVP 완성판이 아니다. 실제 로그인/CLI host/MCP/설치 자동화/Windows 인증은 별도 gate다.

## 모든 평가를 반영한 변경

|근거|발견|구현 결정|
|v1 executor 480회 및 별도 정책 lane|검증/업무 의미/입력 경로가 다른 도구를 총점으로 비교하면 오해|과거 결과 보존; actuator·planner·observer·verifier를 분리해 기록|
|E1 v2.3/v2.4 공통 계약, hidden 보정 시험|Playwright는 모든 시나리오의 최속이 아니며 실제 hidden에서 기본 click timeout. 다른 경로 성공, 표본·환경 제약 존재|Playwright 첫 adapter 유지. capability·환경·visibility·독립 검증 여부로만 route 선정. hidden 미검증 경로는 중단, force/foreground 우회 금지|
|E1 OpenCLI file input 실패|generic upload와 사이트별 adapter를 혼동하면 잘못된 라우팅|미검증 capability는 route에서 제외. executor 이름만으로 승격하지 않음|
|E2 동등 관측 A/V/S/O, 전송 응답 유실/재생|Jev가 상태를 맞혀도 actuator 문제를 해결하지 않음. 추가 readback이 효과 확인을 가능하게 함. 전송 계층도 중복 효과 원인 가능|intent→dispatch→response→독립 verification 분리. 불명확 쓰기는 재실행 금지. generation/lease를 유지한 read-only 조정 먼저|
|G1 자연어 API 6개 사례|필수 값 없음과 원문에 있으나 추출 못 함을 혼동|NEEDS_EXTRACTION / NEEDS_CLARIFICATION / NEEDS_OBSERVATION 분리. 원문 출처 없는 값 자동 실행 금지|
|Domain 9,600 API 요청|동일 holdout에서 Jev 사실 분해+코드가 복합 판단보다 개선. A 82.1→100%, S72.9→92.4%, O97.9→100%. API 지연 약5.5배 우위|독립 사실 질문을 batch하고 순서/안전 정책은 코드. Jev 필수 의존성 아님. 모델은 proposal, 권한 아님|
|Calibration/extension/native challenge|A/V/S/O는 제한 pilot 통과, I 불안정. 실제 사이트·독립 사람 라벨·end-to-end 미검증|모델 자동 실행 off, shadow-only. 질문/모델/관측기/팩/프로필 버전 결속. 임계값을 다른 도메인으로 이식하지 않음|

세부 원본은 로컬 평가 보고서 E1/E2/G1/Domain에 보존했다. 공개 요약은 `docs/evaluation-summary.md`. 서로 다른 protocol·구독 CLI/API·모델 경로의 수치를 합산해 정답률/10배 속도를 광고하지 않는다.

## 실행 경로

```text
한 줄 요청 / 구조화 요청
 → Task Pack: 지원 업무·인수·허용 효과 (의도/출처 모호하면 대기)
 → runtime 관측: target/account/generation/visibility/현재 값
 → 규칙으로 확인 가능한 사실 처리; 선택적으로 좁은 모델 질문
 → capability와 실제 환경에 맞는 route
 → 코드 guard: project + caller + scope + origin + ownership + fencing
 → SQLite intent 확정 → 단일 writer dispatch
 → response 기록 → 별도 readback/파일/업무 oracle → 결과 이벤트
```

다른 실행기로 바꾸는 것은 명령 재전송이 아니다. 기존 step의 효과 확인, 새 generation 발급, 새 실행기의 target 재결속과 관측이 필요하다. 불명확한 외부 쓰기 동안 lease를 다른 writer에게 양도하지 않는다. 같은 browser dependency가 죽었으면 같은 Chrome에 붙는 여러 도구를 순환하지 않는다.

## 첫 구현의 핵심 계약

- Node22.22.0 내장 SQLite, WAL/FULL, schema migration version. SQLite 확장 로딩 금지. 파일별 DB/프로필은 `.runtime/` 아래, 공개 제외.
- project/task/step/command_intent/lease/append-only event/outbox/consumer_cursor. 다른 기존 원문 schema는 후속 phase에서 확장한다.
- caller/scope는 신뢰된 로컬 host 설정에서 주입한다. 모델 `approved=true`나 웹페이지 문구로 만들지 않는다. 현재 CLI는 같은 OS 사용자 안의 도구이며 원격 인증 경계가 아니다.
- capability manifest는 등록된 동작·효과·allowed origin·supported environment·verification을 명시한다. 임의 JS/shell/raw CDP는 공개 실행 표면에 없다.
- 모든 작업을 무조건 자동 복구하지 않는다. command dispatch가 시작된 쓰기·결과 미관측은 reconciliation_required, 이미 확인된 효과는 재전송하지 않는다.
- response 성공/exit0은 succeeded가 아니다. 독립 readback evidence가 있어야 succeeded가 된다.
- 취소는 미래 dispatch를 막는다. 이미 발송된 효과는 unknown/observed 그대로 기록하고 취소됐다고 되돌리지 않는다.
- 프로세스 kill 검증은 전원 상실·VM 재부팅 인증과 구분한다. WAL/FULL 플래그만으로 전원 상실 시험 PASS를 만들지 않는다.
- event_id와 caller/project별 cursor로 at-least-once 전달. fetch는 ack가 아니다. 실제 delivery 이전의 cursor jump는 금지한다.
- timeout은 monotonic clock; persistent timestamp는 감사/유효기간 표시용이다. 현재 MVP는 미확인 lease를 시간 경과만으로 강탈하지 않는다.

## 무간섭과 격리

Phase 17 구현 보완: 접수와 실행 사이의 단절을 durable queue+독립 감독자로 연결한다. SQLite schema v3에 감독자/실행 예약/worker kernel identity/복구 세대를 추가한다. claim 전 예약과 이미 claim된 worker의 복구 조건은 다르다. 후자는 사망과 profile 비점유 증명이 모두 필요하다. intent 이후의 복구는 identity-bound GET으로만 수행한다. 자세한 구현 범위와 Linux/Windows 한계는 [감독·복구 계약](supervisor-recovery.md)에 분리한다. 모델 추론을 이 안전 경계의 승인 근거로 추가하지 않는다.

Phase 18 구현 보완: CLI도 gateway와 독립된 host가 소유하고, v4 session/turn/host 기록과 token IPC를 추가한다. 입력 수락·전송·공식 수신·턴 완료·입력 준비는 서로 다른 사건이다. 정상 턴에도 발생하는 `rate_limit_event`나 성공 exit만으로 상태를 추정하지 않는다. 완료되지 않은 턴을 CLI resume가 자동 실행할 위험 때문에, 결과 불명확 세션은 재개보다 조정/인계를 우선한다. [CLI 근거표](cli-adapter-matrix.md)의 실제 구조화 세션 검증은 대화형/Windows·파일 수정·프로젝트 완료와 구분한다. 현재 file tools는 경계 검증 전 비활성화한다.

기본 정책은 host foreground 전환·OS 입력·사용자 탭·클립보드·파일 대화상자 금지다. 첫 브라우저 경로는 runtime이 새로 소유한 headless persistent context에서만 실행한다. 타인의 Chrome에 attach하지 않는다.

Phase19 구현 보완: 중단 복구의 입력 자료는 마지막 출력 한 개가 아니라 수락 순서의 전체 턴·불명확/취소 상태·해시 결속 출력과 실제 worktree 관측이다. [조회·인계](terminal-handoff.md)는 페이지 revision과 generation을 검사하며 모델의 완료 주장과 Git 관측/테스트 검증을 분리한다. 인계 자료 생성은 resume나 재전송이 아니다. 읽기 전용 Git 작업도 외부 diff/textconv뿐 아니라 clean/process 필터까지 차단한다. linked worktree·Windows 수집과 실제 파일 도구는 아직 미검증이다.

이 정책과 headless 실행 자체가 Windows 이벤트 기반 비간섭 인증을 대체하지 않는다. 무료 guest/전용 세션 배포는 후속 설계이며 VMware/Broadcom 계정을 설치 전제조건으로 넣지 않는다. 작업환경 분리와 악성 페이지 보안 경계는 별개다. 신뢰된 plugin이 같은 OS 권한으로 실행되는 상태를 샌드박스로 부르지 않는다.

## 구현 순서와 종료 기준

Phase22 설계 보완: [저장 경계](storage-boundaries.md)는 durable 예약과 dispatch 재검사, 회전된 출력의 global offset/hash, 기본 꺼진 소유 자료 정리를 추가한다. 실제 공간 부족에서는 새 효과를 차단하고 이미 확정된 intent를 보존한다. 정리는 삭제 의도를 먼저 저장하며 진행·불확실·미등록 증거를 제외한다. 애플리케이션 admission은 hard filesystem quota가 아니며 snapshot/staging·모든 CLI cache·장기 보존·Windows/재부팅은 별도 gate로 남긴다.

Phase21 설계 보완: [자원 경계](resource-boundaries.md)는 하나의 host위임 domain에서 worker/browser·CLI/broker·독립 verifier의 CPU/memory/PID를 합산한다. 실제 user systemd/cgroupv2 설정과 프로세스 membership을 읽고 dispatch 전에 검사한다. main 사망·OOM 후 자손이 남지 않도록 transient service의 control-group 종료를 사용한다. 예산 없는 legacy 구성은 unconfigured/unverified이며 Windows·I/O/디스크·gateway 전체 예산·foreground timeline·soak 보장을 대신하지 않는다.

Phase20 설계 보완: 코딩 실행의 실제 효과는 [파일 broker·독립 검증](terminal-file-effects.md)으로 결속한다. 기본 CLI 파일/shell 도구를 열지 않고, host가 위임한 정확한 파일과 현재 공식 tool-use/turn/generation만 허용한다. 파일 hash readback과 격리된 Node 입출력 oracle을 분리하며, 모델의 성공 문구·테스트 자기 보고를 프로젝트 완료로 올리지 않는다. 이전 Phase18/19의 “파일 도구 미검증”은 당시 상태이며, Phase20의 개별 실측 증거로만 범위를 갱신한다. 독점 사본 전제·범용 프로젝트 runner·Windows·cgroup/VM·원래 전체 RQ는 별도 유지한다.

1. Phase15: durable core/guard/route/CLI/owned fixture + crash/negative tests. 공개 PR로 검토.
2. Task Pack one-line intake와 stdio MCP, 실제 사이트 observer/verifier 1개. 자연어/정책 라벨 정리.
3. 조건별 browser adapter와 실제 takeover. 각 fallback을 별도 evidence로 검증.
4. 별도 CLI host, 공식 세션 재개, Linux/native Windows 분리.
5. 설치/격리/재부팅/foreground timeline/soak/실사용 profile 검증.

앞 단계 완료는 뒷 단계 완료가 아니다. 각 단계는 이슈와 RQ, 증거/환경/미실행 범위를 남기고 확인받는다. 모든 실제 사이트 onboarding·권한/계정 선택을 합성 fixture 검증으로 대신하지 않는다.

## 공개/데이터 원칙

공개 대상은 명시적 allowlist의 source·계약·합성 fixture·새 runtime 테스트·집계 문서다. 원시 모델 응답, API response ID, 세션/프로필/DB/키, 원본 사용자 요청, 로컬 경로·개인정보가 들어간 handoff는 기본 제외한다. 로컬 원본은 삭제하지 않는다. 공개 checkout에서 install/build/test를 별도 검증한다. 배포 라이선스는 사용자가 정하기 전 임의 부여하지 않는다.
