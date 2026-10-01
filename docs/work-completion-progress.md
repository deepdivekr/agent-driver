# Work 완료 경로 복구 — 진행 기록

Authority: [Work 완료 경로 복구 및 자율 운영 계획](work-completion-and-autonomy-plan.md)
and [AGENTS.md](../AGENTS.md). 이전 이력: [custom-pack-refactoring-progress.md](custom-pack-refactoring-progress.md).
Baseline: main f077e04 (PR #36). Branch: claude/workflow-validation-issues-u9mild.

## 시작 시점 상태 (2026-10-01)

- 실사용 원본 24건 최신 감사: 1 PASS / 9 FAIL / 14 NOT_RUN (이전 진행 기록 기준).
  이 checkout에는 비공개 DB·receipt가 없어 다시 실행하지 않는다.
- 시뮬레이션 재현(실제 검증기·실행기에 fixture 모델 연결):
  - 고쳐진 옛 초안이 남은 실행: `WORK_COMPLETION_BATCH_CONTRADICTS`로 거부
  - 완료 제안의 검사 누락·잘못된 ID: `WORK_CLIENT_COMPLETION_EVIDENCE_MISSING`로 `failed`
  - 180행·15KB 표 receipt: `WORK_COMPLETION_EVIDENCE_BUDGET_EXCEEDED`, 모델 호출 0회
  - 정상 실행(receipt 4개·검사 3개): 검증 모델 호출 4회

## 단위별 기록

### A0. 기준 문서 보정 — 완료
- AGENTS.md: 새 계획서를 현재 기준으로 지정. 조건부 복구, 거짓 거부도 결함,
  위험도 비례 검증, 금지는 코드로 지킨다는 원칙 추가.
- 기존 계획서: 새 기준 안내와 R3 쓰기 재실행 금지 조항에 “대체됨” 표시.
- 코드 변경 없음.

### A1. 검증 거짓 거부 제거 — 완료
- `supersededOutputEvidence`: 같은 실행에서 같은 제목·형식의 Office 결과 파일을 나중에
  다시 저장하면 이전 파일과 그 readback에 `host_superseded_by`를 붙인다.
  표시된 기록의 배치 `contradicts`/`unresolved_material`은 즉시 거부하지 않고 표시와 함께
  최종 판단에 넘긴다. 최종 판단은 그 기록을 인용할 수 없다
  (`WORK_COMPLETION_SUPERSEDED_EVIDENCE_CITED`, 출력 교정 1회).
- 현재 기록의 모순은 계속 배치 단계에서 막는다. 모든 모순을 최종 모델에 맡기면
  현재 산출물의 실제 위반(누락 행·중복 키·잘못된 상태)을 모델이 놓칠 수 있어,
  완화 범위를 호스트가 코드로 증명하는 대체된 산출물로 한정했다.
- 생성된 검사에는 대체된 산출물을 넓혀 붙이지 않는다(실행기가 직접 인용하면 유지).
- 한 receipt의 셀 단위 인용 목록이 40KB 단일 기록 한도를 넘을 때만 표를
  `<ref_prefix>.<row>.<col>` 색인으로 바꾼다. 표가 아닌 receipt는 계속 모델 호출 전에 거부한다.
- 검증 모델 호출 수를 `supervisor.verification.calls` 활동으로 기록한다.

### A2. 거부 뒤 수정 루프 — 완료(Swarm 제외)
- 거부 이유는 감사(audit) 기록이 아닌 별도 `denial` 콜백으로 수정 단계에 전달한다.
  감사 기록에는 기존처럼 이유의 해시만 남는다(개인정보 보호 테스트 유지).
- 수정 기회는 `WORK_COMPLETION_REPAIR_BUDGET=3`. 새 증거가 없으면 Work 실행당 한 번
  같은 receipt를 새로 재검증한다. 그다음은 `WORK_CLIENT_COMPLETION_REPAIR_NO_NEW_EVIDENCE`.
- 검증기 출력이 교정 후에도 쓸 수 없으면(인용·스키마 오류)
  `WORK_COMPLETION_VERIFIER_OUTPUT_UNUSABLE`로 저장된 주장에서 검증만 최대 2회 재시도한다.
  소진되면 `WORK_CLIENT_VERIFICATION_OUTPUT_UNUSABLE`로 보류한다. 도구는 다시 실행하지 않는다.
- 봉인된 수집 계약 불일치(`WORK_COLLECTION_CONTRACT_NOT_VERIFIED`)도 수정 대상이다.
- 수정 중 외부 쓰기·같은 쓰기 재실행·도구 예산 초과는 Work를 끝내지 않고
  발송되지 않은 관측으로 기록해 모델이 다시 고르게 한다. Office 결과 파일
  (`office_result_draft`)은 새 요청 ID로 다시 쓸 수 있다.
- 남은 일: Swarm 결과 경로(`supervisor.ts`의 Swarm 검증)는 아직 수정 루프가 없다.

### A3. 실행기가 완료 전에 끝내는 지점 제거 — 완료
- 완료 제안의 검사 누락·요청 ID 인용·없는 ID는 기존 receipt로 정규화한다.
  receipt가 하나도 없으면 발송되지 않은 관측으로 거부하고 계속한다.
- 결정 출력 교정은 실행당 3회. 교정 실패는 다음 결정으로 넘어가고, 소진되면
  `WORK_CLIENT_DECISION_OUTPUT_UNUSABLE`(재시도 대상)이다.
- 같은 잘못된 입력을 두 번 내면 그 도구를 이번 실행에서 제외한다.
- 효과가 없는 `failed` receipt는 다음 결정에 넘기고, 효과가 있었던 실패만 종료한다.
- 저장 결과 재확인 3회 초과는 발송되지 않은 관측으로 거부한다.
- 발송되지 않은 관측(거부·재사용 기록)은 별도 요청 ID를 쓴다. 같은 ID를 쓰면
  실행 trace의 중복 검사(`WORK_TRACE_DISPATCH_AMBIGUOUS`)에 걸린다.
- receipt 재사용은 turn만 올리지 않고 `WORK_CLIENT_TOOL_RECEIPT_REUSED` 기록을 남긴다.
- 32개 관측 창을 넘는 기록은 `evicted_observations` 원장으로 요약해 trace가 계속
  닫히고 수치도 맞게 한다. 원장 이후의 입장 이후 수치(since admission)는 unknown이 된다.

### A4. 진행 중인 Work가 멈추지 않게 — 완료
- 새 성공 receipt나 단계 보고가 생긴 실행은 시도 횟수를 0으로 되돌리고 2초 뒤 재시도한다.
  진행 없는 실행만 3회 후 `failed`. turn 120 이상은 진행으로 보지 않는다.
- 모델 일시 불가(쿼터·속도 제한·제공자 장애·검증 전송 실패)는 `retry_wait`로
  1분부터 최대 30분까지 지수 백오프로 자동 재개한다. 로그인 만료·미지원 모델은 그대로 사용자 대기.
- 발견한 데드엔드: 실행의 `config_hash`는 생성 시 고정되고 갱신되지 않아, 호스트 설정이
  한 번 바뀌면 그 실행은 재개해도 영원히 `CONFIG_CHANGED`였다. 이제 현재 설정으로
  다시 로드된 supervisor가 실행을 현재 설정·AI 설정으로 다시 묶고(재개와 같은 checkpoint
  재결속) 이어 간다(`supervisor.rebound`). 이전 설정을 가진 supervisor는 실행을 잡지 않고
  `CONFIG_RELOAD_REQUIRED`로 남긴다. 효과가 불확실한 실행은 다시 묶지 않는다.
  커스텀 Pack 회차는 기존 결속을 유지한다(Part B 범위).

### A5. 위험도에 비례한 검증 — 완료(중간 등급 제외)
- `completionRiskTier(observations)`: 등급은 호스트가 봉인한 닫힌 trace에서만 정한다.
  trace가 없거나 열려 있거나 receipt가 봉인 뒤 바뀌었거나, 외부 쓰기나 Office 소유가 아닌
  로컬 쓰기가 있으면 엄격 등급이다.
- 가벼움 등급(읽기·초안·Office 결과 파일·Pack 산출물만): 원래 요청 검사를 포함한 모든 의미
  검사를 짧은 판정 1회로 묻는다. 입력은 원래 요청, 검사, 성공 receipt의 내용
  (결과 파일 본문 12000자, 그 밖 JSON 3000자, trace 진술 4000자, 전체 40KB 이하)이다.
  receipt별 배치 검사와 leaf 색인은 쓰지 않는다.
- 분명한 거부(`unsupported`)는 바로 거부하고 이유를 수정 단계로 넘긴다(감사 기록에는 해시만).
  판단 불가·근거 없는 인용·형식 오류는 기존 엄격 경로로 넘어간다.
- 감사 기록에 `verifier:'light'`와 `WORK_COMPLETION_LIGHT_VERIFIED`를 남긴다.
- supervisor 수준 확인: 읽기 전용 Pack Work가 검증 모델 호출 1회(가벼움)로 `succeeded`.
- 중간 등급(사용자 폴더 쓰기 후 대상 다시 읽기)은 구현하지 않았다. 해당 Work는 엄격 경로다.
- 새 테스트: `runtime-work-completion-risk-tier`(7개).

### A6. 금지는 지시문이 아니라 코드로 — 완료(목표 크기는 실행 지시문만 달성)
- 크기(바이트, 이전 → 현재):
  - 실행(매 턴, 실행+완료 시점+단계): 7693 → 3842 (50%). 목표 달성.
  - 엄격 검증: 7577 → 4943 (65%). 목표 3.5KB 미달.
  - 정의: 6485 → 6121, 재계획: 14410 → 13397 (93%). 목표 7KB 미달.
  - 가벼움 검증(A5): 약 0.7KB. 읽기 위주 Work는 이제 이 지시문을 쓴다.
- 지시문에서 뺀 금지와 그것을 막는 호스트 코드(테스트: `runtime-work-prompt-prohibitions`):
  - 목록에 없는 도구 → `WORK_CLIENT_TOOL_NOT_AVAILABLE` 발송 전 거부 후 계속.
  - 행동 필드 조합 → `decisionFields` 필드별 교정 메시지.
  - 같은 잘못된 입력 반복 → 그 도구 제외(A3).
  - 실패 receipt·없는 evidence ID 인용 → 완료 주장 정규화가 성공 receipt만 남김.
  - 효과가 있었던 쓰기·불확실 효과 재실행 → `WORK_CLIENT_TOOL_REQUEST_ID_NOT_REUSABLE`/`reconciliation_required`, 발송 없음.
  - 수정 단계의 쓰기 재실행·외부 효과 → A2 거부(`REPAIR_REPLAY_FORBIDDEN`, `REPAIR_EXTERNAL_EFFECT_FORBIDDEN`).
  - 단계 보고 증거·의존·전체 보고 → `acceptStageClaims`, `WORK_CLIENT_STAGES_INCOMPLETE`.
  - Google 환경 차단 시 제공자·검색어 바꾸기, 차단된 검색 반복 → `WORK_SEARCH_ENVIRONMENT_BLOCKED`/`WORK_SEARCH_PROVIDER_BLOCKED`.
    제공자별 규칙은 `office_web_search` 설명에, `models=off` 설명은 `runtime_pack_catalog` 설명에 이미 있다.
  - 중단된 로컬 기록 읽기 복구 허용 → 지시문 대신 그 receipt의 `next_action`에 둔다.
  - 검증기: 허용되지 않은 evidence ID(`VERIFIER_EVIDENCE_INVALID`), 키·JSON 문법 인용
    (`VERIFIER_QUOTE_UNOBSERVED`), 검사 수 불일치(`VERIFIER_CHECKS_MISMATCH`), 대체된 산출물 인용
    (`SUPERSEDED_EVIDENCE_CITED`), 열린 trace 인용(`TRACE_NOT_CLOSED`), trace만으로 결과 주장
    (`TRACE_NOT_RESULT_EVIDENCE`). 모두 교정 1회 후 거부.
  - 계획: 경로 조합은 `validateOrCorrectWorkProposal`이 교정, 모델이 넣은 단계 증거는 `modelWorkPlan`이 버린다.
- 남긴 것: 코드로 확인할 수 없는 의미 규칙(원래 요청 범위, 출력 형식 해석, 신뢰할 수 없는 데이터,
  자체 도구·파일·명령 사용 금지 — Codex는 read-only 샌드박스라 파일 읽기는 가능하므로 유지).
- 검증·재계획 지시문을 더 줄이려면 회귀 테스트가 고정한 의미 문장(과거 실제 오류마다 하나)을
  바꿔야 한다. 실제 모델 측정(A7) 없이 빼면 그 오류가 되살아날 수 있어 이번 단위에서는 하지 않았다.
- 크기 회귀 테스트: 실행 3846, 엄격 검증 5000, 정의 6200, 재계획 13500 바이트 이하.
- 검증(fixture): build PASS. Work 관련 테스트 전체 + `runtime-files-http`: 747 PASS / 1 FAIL.
  실패 1건은 `runtime-work-stage-history-ui`(페이지 자체 새로고침이 테스트가 넣은 카드를 지우는
  시간 경쟁, UI 코드는 이번 변경과 무관)다. 새 테스트 `runtime-work-prompt-prohibitions` 12 PASS.

### A7. 최종 검증과 실제 모델 확인 — fixture 완료, 실제 모델 미실행
- frozen quick suite(`npm test`, 소스 0d475bf, browser shim 사용):
  1952 PASS / 10 FAIL / 11 BLOCKED_ENV / 1 NOT_RUN (전체 1974).
  - BLOCKED_ENV 11건: systemd user bus 없음(리소스 한도 테스트). NOT_RUN 1건: 화면(headed) 없음.
  - FAIL 10건은 모두 기준 main f077e04에서도 같은 방식으로 실패한다(별도 worktree에서 확인).
    - `runtime-files` 4건: 검증 샌드박스(bwrap) 없음 → `SANDBOX_UNAVAILABLE`.
    - `runtime-storage` 1건: `/usr/bin/bwrap` 없음.
    - `runtime-interface` 4건: 분리된 브라우저 작업자가 `paused_dependency` 또는 60초 시간 초과.
    - `runtime-work-stage-history-ui` 1건: 화면 새로고침 시간 경쟁(A6 기록 참고).
  - 이 브랜치 변경으로 생긴 실패는 없다.
- ledger 196 RQ, public boundary PASS, diff check PASS.
- 공개 수용 세트 7건을 `docs/work-completion-acceptance-set.md`에 정의했다.
  이 컨테이너에서는 실제 모델 호출이 불가능해 `NOT_RUN`이다. 비공개 원본 24건도 실행하지 않았다.
- Part A 완료 기준 중 fixture로 확인한 것: 최초 진단 6개 항목 재현 테스트 통과, 실행기 종료 지점·멈춤
  지점 재현 테스트 통과, 읽기 위주 Work 검증 1회(A5), 실행 지시문 절반 이하(A6).
  확인하지 못한 것: 실제 모델 완료율 70%, 거짓 거부·거짓 성공 비율, 검증·재계획 지시문 절반.

### 테스트 환경 메모
- 이 컨테이너의 Playwright 1.63은 Chromium 1243을 기대하지만 설치본은 1194다.
  테스트 실행 때만 스크래치 경로에 1194를 1243 이름으로 연결한 shim을 쓴다(커밋하지 않음).
- `runtime-work-stage-history-ui`는 기준 main에서도 1회 통과·1회 실패하는 시간 의존 테스트다.
- 실제 구독 모델 호출은 이 컨테이너에서 하지 않았다. 모든 결과는 fixture 기준이다.

### A1–A4 검증 (fixture 기준)
- TypeScript build PASS.
- Work 관련 테스트 전체(`runtime-work-*`, custom Pack, supervised Swarm, live control,
  pasted Work, draft-only, control-service reload): 723 PASS / 0 FAIL (browser shim 사용).
- 새 회귀 테스트: `runtime-work-completion-superseded`(A1), `runtime-work-completion-repair`
  확장(A2), `runtime-work-completion-path`(A3), `runtime-work-supervisor-continuity`(A4).
- 기존 테스트 중 "즉시 failed/awaiting_review"를 고정하던 것은 같은 안전 조건(발송 없음,
  재실행 없음, 제한된 반복)을 유지한 채 새 동작(거부 기록 후 계속, 제한 후 재시도)으로 갱신했다.
- ledger 196 RQ, public boundary PASS, diff check PASS.
- frozen quick suite는 A7에서 최종 소스로 실행한다.

### A5 검증 (fixture 기준)
- TypeScript build PASS.
- Work 관련 테스트 전체: 723 PASS / 0 FAIL, 새 `runtime-work-completion-risk-tier` 7 PASS.
  기존 fixture는 가벼움 지시문을 모르므로 형식 오류로 엄격 경로로 넘어가 같은 결과를 낸다.

### A7. 실제 구독 모델 측정 — 1차(2026-10-01, 측정만, 코드 변경 없음)
- 소스: 461e885(이 브랜치). 비교: main f077e04. 각각 별도 worktree·새 data_dir·별도 포트의
  Control Center와 supervisor로 실행했고, 같은 시간대에 병렬로 돌렸다(외부 데이터 조건을 맞추기 위해).
- 모델: Control Center에서 Codex `gpt-6.1-sol`, reasoning low, 실행·검증 역할을 같은 모델로 지정
  (이전 24건 감사와 같은 모델). 설정은 `tests/runtime-work-supervisor-continuity.test.mjs`의 setup 형식에
  `records` file 소스(공개 세트의 예시 JSON 6행)만 등록했다. 브라우저는 기본값(owned headless Playwright), Aside 미등록.
- 등록은 UI 등록 버튼과 같은 요청(`execute:true`, 실행 동의 포함)으로 했고, 그 밖의 사람 개입은 하지 않았다.
  승인 요청(`waiting_approval`)은 한 건도 나오지 않았다.

| ID | 상태 · 이유 | 검증 방식 | 검증 호출(관측) | 수정 | 시간 | 확인 | 원인 분류 |
|---|---|---|---|---|---|---|---|
| P1 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 57초 | 산출물 없음 | 환경(Google 비정상 트래픽 → Aside 연결 요구) |
| P2 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 57초 | 산출물 없음 | 환경(같음) |
| P3 | succeeded | 코드(봉인된 수집 계약, native) | 0 | 0 | 248초 | 정답 a1·a3·a4·a6, `id,name`만 — 일치 | — |
| P4 | succeeded | 엄격(가벼움 판단 불가 후 전환) | 5 | 0 | 419초 | report 2·memo 2·invoice 2 — 일치 | — |
| P5 | failed · `BROWSER_URL_NOT_OBSERVED` | — | 0 | 0 | 56초 | 산출물 없음 | 실행기 종료 |
| P6 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 74초 | 입력·제출 0건 | 환경(양식 `draft_only` 대상 미등록) |
| P7 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 78초 | 산출물 없음 | 환경(Bing 빈 결과, DuckDuckGo·Google 챌린지) |

- 요약: 완료율 2/7(29%, 목표 70% 미달). 거짓 성공 0/2. 거짓 거부 0/5(보류·실패 건에는 맞는 산출물이 없었다).
  검증 호출은 Work당 평균 0.71회(성공 건 기준 2.5회).
- f077e04 비교(같은 7건·같은 모델): P1·P2·P6·P7 같은 이유로 보류, P5 같은 이유로 실패, P3 성공(96초, 호출 0),
  P4 성공(295초, 엄격 호출 4). 완료율 2/7로 같다. 이 세트에서 Part A의 개선은 아직 완료율로 드러나지 않았고,
  P4는 가벼움 호출 1회가 더해져 호출 4→5, 시간 295→419초로 늘었다.
- 발견 1 — 검증 호출 카운터가 실제 모델에서 항상 0이다. `modelForRole()`(`src/taskpack/adaptive-spec.ts:28`)이
  `ConfiguredStructuredModel.forRole()`로 새 인스턴스를 만들고, 그 `calls`는 supervisor가 세는
  `model.calls`(`src/work/supervisor.ts:350`, `:376`)와 분리돼 있다. fixture 모델은 `forRole`이 없어 테스트에서만 맞다.
  같은 배열로 검증기 실패 종류(인증 만료·쿼터·속도 제한)를 판정하는 `verifierBoundary`(`:351-358`)도 실제 모델에서는 비어 있다.
  위 표의 호출 수는 활동 기록(가벼움 시작 + 엄격 감사 기록)으로 직접 센 값이다.
- 발견 2 — 가벼움 검증이 Office 결과 파일이 있는 Work에서 판단하지 못한다. 저장된 checkpoint를 데이터 사본에서
  재현해 같은 모델로 3회 다시 물었고 3회 모두 엄격 경로로 넘어갔다. 두 원인이 각각 단독으로 충분하다.
  (1) 가벼움 입력은 `office_result_draft`/`office_result_read`의 파일 본문만 보여 주고 식별자·SHA-256·바이트·전체 읽기
  여부를 뺀다(`src/work/completion.ts:666`). 검증 모델은 3회 모두 `saved_result` 검사를 "저장 영수증·파일 식별자가 없다"는
  이유로 `unknown`이라 했다. (2) 일반 receipt는 키가 포함된 JSON 문자열로 보여 주면서 인용문은 스칼라 leaf 안에 있어야
  통과한다(`:690`). 모델은 3회 모두 `"full_source_read":true` 같은 보여 준 그대로의 문자열을 인용했고 leaf 검사에서 떨어진다.
- 발견 3 — P5: 사용자가 쓴 `nodejs.org`는 scheme이 없어 허용 URL로 등록되지 않는다(`src/work/execution-tools.ts:164`).
  거부는 발송 전 검사가 아니라 실행 중 일반 예외(`:616`)라서 A3의 교정 가능한 거부를 타지 못하고, 재개할 때마다 같은
  pending 읽기를 다시 실행해 진행 없는 3회 뒤 `failed`가 된다.
- 발견 4 — 이 호스트의 headless 검색은 Google(비정상 트래픽)·DuckDuckGo(결과 없는 셸)·Bing(빈 결과) 모두 막힌다.
  Google 차단 뒤 호스트는 `provider_change_allowed:false`, `next_action:connect_aside`를 돌려주고(`:444`, `:690`), Aside가 없으면
  사람이 설정할 때까지 멈춘다. P6은 이 제품에서 양식 입력 수단이 호스트 등록 `draft_only` 대상뿐이라, 공개 세트의 준비
  단계에 그 대상 등록이 빠져 있다.
- 발견 5 — 정의 호출(design, 180초)이 Codex에서 시간 초과되면(P3) Claude로 넘어간다(`client_handoff`
  `provider_unavailable`). 이때 `node` 래퍼만 SIGKILL되고 네이티브 `codex` 프로세스는 고아로 남는다
  (`src/integrations/subscription-auth.ts:61`).
- 비공개 Phase112 원본 세트: `NOT_RUN`. 이 환경에는 재준비에 필요한 연결 입력 파일이 없고, 그 세트는 Aside(사용자
  Windows 브라우저 프로필)를 쓰며, 다른 worktree에서 이미 serve 중이다. 이전 기준(1 PASS / 9 FAIL / 14 NOT_RUN)을 갱신하지 않는다.

### A7 보완 — 1차 측정 발견 1·2·3·5 (2026-10-01, 25a56a5)
- 발견 1(카운터): `ConfiguredStructuredModel`의 호출 기록을 private 필드로 두고 `forRole()`이 같은 기록을 공유한다.
  실행별 `forWork()` 기록은 그대로 분리된다. 공유로 중복이 되는 `task-models.ts`의 수동 복사를 뺐다.
  `verifierBoundary`의 실패 종류 판정도 이제 실제 검증기 호출을 본다.
  테스트: `runtime-work-completion-risk-tier` "A7: verification calls through a configured model are counted"
  (수정 전 빌드에서 "used 0 model calls"로 실패).
- 발견 2(가벼움 검증): 결과 파일 receipt는 식별 정보(해시·바이트·형식·읽기 위치, 본문 제외 JSON) 다음에 본문을 보여 준다.
  인용 근거는 "보여 준 내용의 정확한 부분 문자열이면서, 관측값 하나 안에 있거나 관측값 하나를 통째로 담을 것"이다.
  키·구두점만, 또는 실행 메타데이터(`request_id` 등, 원래 leaf에서 제외됨)만 인용하면 계속 엄격 경로로 간다.
  테스트: "A7: a light quote of a shown key and value or of the saved file identity is grounded; keys alone are not".
  기존 A5 테스트의 "본문만 그대로 보여 준다" 단언은 새 계약(식별 정보 뒤 본문)으로 바꿨다.
  실제 모델 재현(P4 checkpoint 사본, Codex gpt-6.1-sol): 수정 전 0/3 → 수정 후 3/3 가벼움 1회로 검증.
  결과 파일을 틀린 값(report 3, 합계 7)으로 바꾼 사본은 2/2 `unsupported`로 거부(거짓 성공 없음).
- 발견 3(P5): 요청에 scheme 없이 쓴 사이트(흔한 TLD만: `nodejs.org`, `httpbin.org/forms/post`)를 https 출처로 인정한다.
  `Node.js`, `sample.json` 같은 이름은 URL이 되지 않는다. 허용 목록 밖 URL은 `browserRequest`에서 발송 전
  `WorkClientToolInputError('BROWSER_URL_NOT_OBSERVED')`로 거부되어 모델이 다른 수단을 고른다.
  테스트: `runtime-work-unusual-traffic` "a scheme-less site in the request is readable and an unlisted URL is refused before dispatch"
  (수정 전 빌드에서 실패).
- 발견 5(고아 프로세스): POSIX에서 클라이언트 CLI를 별도 프로세스 그룹으로 띄우고, 시간 초과·출력 초과·중단 때 그룹 전체를 종료한다.
  테스트: `runtime-subscription-auth` "a client timeout stops the wrapper and the binary it started"(수정 전 빌드에서 실패).
  1차 측정이 남긴 고아 `codex` 1개(36분 실행)는 측정 뒤 정리했다.
- 검증: build PASS. Work 관련 테스트(`runtime-work-*` 전체 + subscription-auth, task-auto-models, client-handoff,
  supervised-swarm) 721 PASS / 0 FAIL. ledger 196 RQ, public boundary PASS, diff check PASS.
  frozen quick suite(최종 소스): 1978/1978 PASS, BLOCKED_ENV 0, NOT_RUN 0.

### A7. 실제 구독 모델 측정 — 2차(25a56a5, 1차와 같은 조건)

| ID | 상태 · 이유 | 검증 방식 | 검증 호출 | 수정 | 시간 | 확인 | 원인 분류 |
|---|---|---|---|---|---|---|---|
| P1 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 57초 | 산출물 없음 | 환경(Google → Aside 요구) |
| P2 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 94초 | 산출물 없음 | 환경(Bing 빈 결과, DuckDuckGo·Google 챌린지) |
| P3 | succeeded | 코드(봉인된 수집 계약) | 0 | 0 | 109초 | 정답 일치 | — |
| P4 | succeeded | 가벼움 | 1 | 0 | 152초 | 정답 일치 | — |
| P5 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 136초 | 첫 확인 기록 저장·재확인(블로그 첫 글과 일치), 감시 미설정 | 환경(감시할 블로그 소스 미등록) |
| P6 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 63초 | 입력·제출 0건 | 업무 불가능(양식 대상 미등록, 양식 필드에 radio 종류 없음) |
| P7 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 81초 | 산출물 없음 | 환경(같음) |

- 요약: 완료 2/7(29%, 목표 미달). 거짓 성공 0/2, 거짓 거부 0/5. 실행기 종료 1 → 0. 검증 호출 Work당 0.14회
  (성공 건 0·1, 카운터 기록과 관측이 일치). P4 419초 → 152초(f077e04 295초).
- 이 세트에서 Part A가 다루는 지점(검증 거부, 실행기 종료, 진행 정지)으로 멈춘 건은 이제 없다. 수정 루프(`Correction n/3`)는
  두 측정 모두 한 번도 열리지 않았다. 남은 정지는 모두 실행 환경이나 세트의 준비 단계다.
- P6은 1차 기록의 "양식 대상 미등록"만으로는 풀리지 않는다. httpbin 양식의 크기는 radio인데 양식 대상 필드 종류는
  `text/select/checkbox`뿐이다(`src/packs/contracts.ts:12`).

### Part A 완성도 평가 (A7 기준)
- 실제 모델로 확인된 것: 봉인된 수집 계약의 코드 검증(호출 0), 읽기·결과 파일 Work의 가벼움 검증 1회(보완 후),
  사용자 사이트의 읽기와 잘못된 URL의 교정 가능한 거부, 검증 호출 수 기록, 거짓 성공 0.
- 실제 모델로는 아직 확인되지 않은 것(fixture로만): 고쳐진 옛 초안(A1), 180행 표(A1), 수정 루프·재검증(A2),
  완료 제안 형식 교정(A3), 커스텀 Pack 회차 trace(A3), 진행 중 재시도·설정 변경 재결속(A4), 엄격 경로를 타는 외부 쓰기(A5).
  공개 세트에서 이 경로를 여는 업무는 검색 차단·대상 미등록으로 그 단계까지 가지 못했다.
- 남은 Part A 항목: Swarm 결과 경로의 수정 루프(A2), 중간 등급(A5), 검증·재계획 지시문 축소 목표(A6).
- 완료율 목표(70%)를 막는 것은 Part A 밖의 세 가지다.
  1. 공개 웹 검색 경로: 이 호스트에서 headless 검색이 모두 막힌다(P1·P2·P7). 사용자가 Aside 우선 라우팅을 지시했으나,
     로그인된 개인 브라우저를 Work의 기본 경로로 만드는 변경은 이 세션의 자동 권한 검사에서 거부되어 진행하지 않았다.
  2. 감시 소스 등록(P5): 반복 감시는 호스트 등록 소스로만 돈다. 세트 준비 단계에 블로그 소스 등록이 필요하다.
  3. 양식 초안(P6): radio 필드 지원과 `draft_only` 대상 등록이 필요하다.

## Part B 개시 — B5 실행 수단 전환 (2026-10-01, 사용자 승인: Aside 기본, 건별 승인 없음)

사용자가 Aside(Windows 포어그라운드 브라우저, 로그인 세션 등록됨)를 기본 브라우징 경로로 승인했다.
Part A 잔여(Swarm 수정 루프, 중간 등급, 지시문 축소)보다 완료율을 직접 막는 B5를 먼저 열었다.

### 구현 (6c78266, 3c2e740)
- 공개 읽기의 기본 배치(`defaultPublicPlacement`, `src/browser/executor-routing.ts`): 호스트 호환 Aside가 등록돼 있으면
  `host_foreground`에서 시작하고(다른 포어그라운드 브라우저는 제외), 연결 실패 시 owned headless로 대체한다.
  계획 모델이 항상 넣는 `browser:{environment:'owned_headless'}`(엔진 없음)는 핀이 아닌 기본값으로 본다.
  같은 실행에서 headless 차단 기록이 있는 검색은 기존 복구 경로(Aside 1회 인계)를 유지한다. Swarm 경로도 같은 규칙.
- 공개 텍스트 자원(`readTextResource`): CSV/JSON/TXT/XML URL은 브라우저 다운로드로 끝나므로(P2 실측: "Download is starting")
  호스트가 HTTPS로 읽어 `offset`/`max_bytes` 페이지로 돌려준다(해시·바이트 수 포함, 8MB 한도, 같은 origin 리디렉션만).
- 읽기 도구가 실행 중에 던진 **typed 거부**(`WorkClientToolInputError`)는 `read_failed` 관측으로 다음 결정에 넘긴다.
  일반 오류는 기존대로 "결과 불명" 경로(pending 유지)다. 1차 시도에서 모든 대문자 코드를 교정 대상으로 넓혔다가
  "중단된 읽기" 계약 테스트 9건이 깨져 typed 거부로 좁혔다.
- 양식 대상 필드 종류에 `radio` 추가(httpbin 양식의 크기 선택).
- 가벼움 검증 근거 규칙: 보여 준 JSON 그대로 인용한 값(`v24.21.0\nLatest LTS`처럼 이스케이프된 형태)도 근거로 인정하고,
  검사당 근거 있는 인용 1개면 충분하다(상태·ID 줄만 인용한 검사는 계속 엄격 경로). 지시문에 "상태·ID 필드가 아닌 관측값을
  인용하라"를 넣었다. run-4 P1 checkpoint 재현: 수정 전 0/1 → 수정 후 2/2 가벼움 판정.
- Aside 콜드 스타트: 새 origin마다 첫 작업이 MCP 시간 초과(~30초)로 `operation_refused` 1회 → 실행 재시도 뒤 성공하는 패턴이
  실측에서 반복됐다(4차 P1 3회·P2 7회, P7은 3연속으로 `failed`). 탭 생성·이동이 시간 초과되면 1회 재시도한다(`mcp-executor.ts`).
- 보류: "모델이 아는 공개 https URL 열기 허용"(진단 ②)은 구현했다가 되돌렸다. 이 세션의 자동 권한 검사가 보안 완화로
  거부했고, 실제로도 관측 페이지의 주입 문장이 사용자 로그인 브라우저를 임의 URL로 보낼 수 있어 Aside 기본과 결합하면
  위험이 커진다. 제안: 모델 제안 URL은 owned headless(세션 없음)에서만 열고, Aside는 사용자가 쓴·관측된 URL과 검색에만 쓴다.
  사용자 결정 뒤 진행한다.
- 검증: Work·브라우저·Swarm 테스트 892 PASS / 0 FAIL(6c78266), frozen quick suite 1983/1983 PASS(3c2e740).
  ledger 196 RQ, public boundary PASS.

### 실측 3·4·5차 (Aside 등록, Codex gpt-6.1-sol low)
- 3차(25a56a5 + Aside 등록만, 기본 배치 수정 전): P1 `succeeded` 159초 — headless Google 차단 → 기존 Aside 1회 인계로 통과.
  P2는 CSV 피드 URL이 브라우저 다운로드로 끝나 `WORK_CLIENT_EXECUTION_FAILED` 반복. 여기서 중단하고 수정했다.
- 4차(6c78266, Aside 재시도·가벼움 근거 수정 전):

| ID | 상태 | 검증 | 호출 | 수정 | 시간 | 확인 |
|---|---|---|---|---|---|---|
| P1 | succeeded | 가벼움 판단 불가 → 엄격(1차 거부 후 재읽기, 2회) | 16 | 1 | 939초 | v24.21.0 · 2026-09-08 일치 |
| P2 | succeeded | 가벼움 판단 불가 → 엄격 | 8 | 0 | 942초 | CSV 12행 = 피드 24시간 창 12건 |
| P3 | succeeded | 코드 | 0 | 0 | 98초 | 정답 일치 |
| P4 | succeeded | 가벼움 | 1 | 0 | 172초 | 정답 일치 |
| P5 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 195초 | 기준 기록 저장, 감시 소스 미등록 |
| P6 | paused · `WORK_CLIENT_WAIT_CONFIGURATION` | — | 0 | 0 | 54초 | 양식 대상 미등록, 입력·제출 0 |
| P7 | failed · `WORK_CLIENT_EXECUTION_FAILED` | — | 0 | 0 | 146초 | Aside 첫 작업 시간 초과 3연속(환경) |

  완료 4/7(57%). 거짓 성공 0/4, 거짓 거부 0/3. P1·P2의 시간은 Aside 첫 작업 거부(각 ~30초 × 3·7회)와 엄격 검증(6배치+최종)이
  대부분이었다.
- 5차(3c2e740, P1·P2·P7만 다시): P1 `succeeded` 238초(가벼움 1회, Aside 거부 0), P2 `succeeded` 341초(가벼움 1회, 거부 1회 남음,
  CSV 12행 = 피드 12건), P7 `succeeded` 210초(가벼움 1회; Python 3.14.8, Node.js 26.10.0 Current + LTS 24.21.0, 공식 출처·시각 포함).
  최종 빌드 기준으로 P1~P4·P7은 완료, P5·P6은 연결 미등록으로 보류다(5/7, 71%).

## Part B — B1 위임·B5 수단 전환 2차 (2026-10-01, 소유자 지시: 전 권한 위임, "내려받아 바로 쓸 수 있게")

### 구현 (b7536c2 … 23ff727)
- **위임 정책(B1 최소형)**: `work.autonomy`(`per_run`|`delegated`, 실행 결속 밖, 실시간 조회). 새 AI 자료 승인은
  `delegated`를 기록하고 명시적 `per_run`은 유지한다. 위임이면 관제센터 접수가 이번 회차로 제한되지 않고(반복 일정 자동 활성),
  MCP `runtime_work_start` 한 번으로 실행까지 이어진다. 제출·결제·제3자 전송 게이트는 그대로다.
- **되묻기 기본**: 접수 화면의 되묻기(guided)가 기본으로 켜진다. 질문은 항상 소유자에게 가며 호스트가 대신 답하지 않는다
  (위임 모드 자동 답변은 넣었다가 소유자 지시로 제거).
- **반복 일정이 실제로 동작**: 유니온 스키마가 구독 CLI에서 `CLIENT_SCHEMA_INVALID`로 거부돼 실제 모델로는 한 번도 일정이
  만들어지지 않았다. 모델에는 평면 스키마를 주고 호스트가 일정으로 변환한다. 시각 없는 주기("하루 한 번", "2시간마다", 감시)는
  코드가 간격으로 정한다(시각이 있는 규칙은 정규화에 맡김). 실행기에 `host_schedule`을 알리고 `office_schedule_status`가 근거 receipt를 준다.
- **계획 모델에 호스트 능력 전달**(`host_execution_facts`): 반복·감시는 호스트 일정, 공식 페이지 직접 열기, 공개 양식 초안.
  감시 Work가 "이후 예약 실행"이나 "감시 등록 영수증"을 완료 조건으로 요구하지 않는다.
- **정의 단계 코드 교정**: 규칙 없는 반복은 사용자 요청을 규칙으로 쓰고, 교정 응답이 결과 문장·효과를 바꿔 써도 호스트가 원래 값을
  유지한다(이전에는 `WORK_DEFINITION_INVALID_AFTER_CORRECTION`으로 사람 대기).
- **공개 페이지 직접 열기**(소유자 결정): `office_browser_read`가 모델이 제안한 공개 https 페이지를 열고 `source.proposed`로 기록한다.
  비공개 호스트·로그인 사이트·검색 페이지·Google 챌린지 페이지·credential 파라미터는 계속 거부한다.
- **검색**: 전경 브라우저가 없으면 기본 제공자는 Bing이다(2026-10-01 이 호스트에서 headless에 응답한 유일한 제공자. Google·DuckDuckGo·
  Brave·Startpage·Mojeek는 모두 챌린지). Bing 결과 링크(`/ck/a?u=a1<base64>`)를 실제 대상으로 복원하고, Google 차단 시 제공자 전환을 허용한다.
- **브라우저 사다리**: 런타임 소유 백그라운드 브라우저 먼저 → 페이지가 거부하면(검색 챌린지뿐 아니라 봇 차단·사람 확인 화면) 등록된
  Aside로 1회 전환. 백그라운드가 읽을 수 있는 페이지는 소유자 브라우저를 열지 않는다(6c78266의 Aside 우선을 대체).
  Aside/Neo MCP 연결은 endpoint당 하나를 공유하고 2분 유지한다(642eec6).
- **공개 양식 초안**(`office_form_draft`): 런타임 소유 새 페이지에서 name·label·그룹 legend로 필드를 찾아 채우고 되읽는다. GET 외 요청은
  호스트가 전부 중단하고 페이지를 닫는다. 없는 필드는 존재하는 필드 목록과 함께 교정 가능한 거부로 돌려준다.
- **검증**: 페이지 단위 텍스트 자원의 부분 페이지(`host_partial_page`)는 "미해결 자료"로 즉시 거부하지 않는다(거짓 거부 실측).
  `observed_at`을 인용 가능한 관측값으로 둔다(거짓 거부 실측). 가벼움 검증은 텍스트 자원을 12000자까지 보고, 40KB를 넘으면 포기하지 않고
  큰 출처 receipt부터 줄여 맞춘다. 엄격 경로로 넘어갈 때 어느 검사가 왜 판단 불가였는지 기록한다.
- **관제센터 문구**: 사용 빈도가 높은 29개 문구를 내부 용어·불필요한 제약 설명 없이 다시 썼고(한·영), 오늘 바뀐 동작과 맞췄다.

### 실측 (Codex gpt-6.1-sol low, `work.autonomy: delegated`, 접수는 quick 모드로 무인 실행)

| 실행 | 환경 | 리비전 | 완료 | 시간(초) P1–P7 | 검증 호출 | 비고 |
|---|---|---|---|---|---|---|
| 7차 | headless만 | b962600 | 4/7 | 137 · 786× · 83 · 163 · 60× · 55× · 136 | — | P2 거짓 거부(부분 페이지), P5 일정 스키마, P6 legend → 모두 수정 |
| 8차 | headless만 | 24a92ca | 6/7 → P7 재실행 후 7/7 | 130 · 155 · 96 · 160 · 135 · 104 · 636×→143 | 1·1·0·1·1·1·(14→1) | P7 첫 시도는 검증 오판(`observed_at` 인용 불가), 6ebf753 수정 후 통과 |
| 9차 | Aside 등록 | 6ebf753 | **7/7** | 139 · 1013 · 98 · 158 · 150 · 92 · 138 | 1·15·0·1·1·1·1 | P2는 주간 CSV 5페이지로 가벼움 한도 초과 → 23ff727에서 수정. Aside 전환 0회(백그라운드가 전부 처리) |

- 산출물 직접 확인: 성공 건 전부 요청과 일치(P2 13/13·14/14행 = 피드 해당 24시간 창, P3·P4 정답, P5 블로그 첫 글 + 일정 enabled,
  P6 Kim/medium·제출 0·비GET 0, P7 Python 3.14.8·Node.js 26.10.0). **거짓 성공 0.**
- 거짓 거부 2건(7차 P2, 8차 P7 첫 시도)은 모두 검증 오판으로 분류하고 재현 테스트와 함께 고쳤다.
- 사람 개입(승인·로그인·설정) 0회. 1차 측정(2/7, 29%) 대비 공개 세트 완료율 100%.
- 사다리 실측(Aside 등록, 6ebf753): "구글에서 … 검색해 첫 결과를 저장" 업무에서 headless Google이 차단되자 Aside로 1회 전환해
  Google 결과를 관측하고 저장·검증까지 `succeeded`(326초, 엄격 검증 5회). Aside 첫 작업 시간 초과(`operation_refused`)가 재시도 뒤에도
  1회 남아 실행 재시도로 넘어갔다. 9차 세트 7건에서는 백그라운드가 전부 처리해 Aside 전환이 0회였다.
- 최종 검증(d83fc80): frozen quick suite **1990/1990 PASS**, BLOCKED_ENV 0, NOT_RUN 0. public boundary PASS.
- 환경 메모: 측정 중 디스크가 가득 찼다(여유 90MB). 원인은 9/29~9/30의 릴리스 설치 검증(`scripts/release/verify-install.mjs`)이
  남긴 임시 설치 7개(약 9GB)였고, 소유자 확인 후 삭제했다. 스크립트는 이제 보고서 작성 뒤 임시 설치를 지운다
  (`AGENT_OFFICE_KEEP_INSTALL=1`이면 유지). 제품 자체는 추적 파일 15MB다.

### 깨끗한 환경 설치·온보딩 검증 (2026-10-01, 1343859 이후)
- 방법: 임시 HOME에 `install.sh`를 그대로 실행(현재 브랜치를 임시 클론+태그로 설치, Chromium 캐시만 재사용, Codex 로그인은 `CODEX_HOME`으로 연결).
- 결과: 설치 176MB·정상. `connect` → 업무 접수 → "AI에 보내기 허용" 1회 → 기본 모델로 분석·실행 → `succeeded`(약 2분 반, 산출물 정확).
- 발견·수정:
  - `agent-office mcp`가 `COMPUTER_CONNECTION_REQUIRED`로 연결을 닫았다(관제센터에서 승인 클릭 전). 그 승인은 기본 비간섭 모드를
    기록할 뿐이고 관제센터 업무는 승인 없이도 실행됐다. `connect`와 `mcp` 시작이 기본 모드를 기록하도록 했다.
  - MCP 도구 목록이 114개·115KB(약 2만9천 토큰)였다. 기본 목록을 업무용 10개·9.5KB로 줄였다(`--all-tools` 또는
    `AGENT_OFFICE_MCP_TOOLS=all`로 전체). 목록에 없는 도구도 이름으로 호출된다.
  - AI 전송 허용 전의 MCP 응답에 `owner_action`(사용자가 할 일 한 문장)을 넣었다.
  - 설치 로그의 git detached-HEAD 안내를 없앴다.
- 허용 뒤 MCP `runtime_work_start` 한 번으로 실행까지 이어져 약 80초에 `succeeded`(클라이언트가 끊긴 뒤에도 공유 서비스가 완료).
- 하지 않은 것: Windows 앱(WSL 브리지) 등록, Claude Code·OpenCode 클라이언트, 시스템 라이브러리가 없는 진짜 새 OS 이미지.

### 남은 항목 순차 마무리 (2026-10-01, 87c7258 이후)
- 위임 예산(f9536ed): `work.delegation.daily_scheduled_runs`(기본 50). 예약으로 호스트가 시작하는 실행만 센다. 한도에 닿으면
  그 회차는 대기하고 Work마다 하루 한 번만 이유를 남긴다. 한도를 올리면 재시작 없이 이어진다(감독자 수준 테스트 추가).
- 엄격 검증 배치를 3개씩 미리 시작(f289664). 가벼움 검증은 페이지의 링크 목록과 `observed_at`을 본문보다 먼저 받는다(facd9be, a4eaefe).
- 결과 파일 receipt에 호스트의 형식 검사 결과(`format_check`)를 넣었다(a4eaefe). 실측에서 검증 모델이 "JSON 파싱 결과가 없다"며
  판단을 미루던 비교 업무(P7 유형)가 가벼움 검증 1회로 통과한다(11·12차).
- 검증된 절차 저장과 재사용(d745080, 320c735 — B2·B3·B4의 첫 단계):
  - 검증을 통과한 Work의 성공 호출(도구·인자, 회차 한정 값 제외)을 `office_procedure`에 저장한다.
  - 비슷한 요청(업무 단어 절반 이상 일치)에는 안내로 준다. 증거도 권한도 아니며, 새 실행은 자기 receipt로 따로 검증받는다.
  - 거의 같은 요청(일치도 0.75 이상: 같은 Work의 반복 회차, 말만 바꾼 재요청)은 저장된 **읽기 단계를 호스트가 모델 턴 없이 재생**한다.
    검증·실행·receipt는 평소 경로 그대로이고, 쓰기와 이미 관측한 읽기는 재생하지 않는다. 실패한 재생은 보통의 실패 관측으로 남아 모델이 이어 간다.
  - 안내받은 실행이 통과하면 그 절차의 성공으로 기록하고, 실패가 성공 이상이면 더는 주지 않는다.
  - 한국어 조사("json으로"/"json")가 업무 단어를 갈라 일치도가 0.5로 떨어지던 것을 고쳤다.
- B1 `awaiting_review` 자동 처리(320c735): 위임 상태에서 읽기·초안 Work(또는 Office 산출물만 쓴 실행)가 검증 없이 끝나면
  같은 Work를 처음부터 **한 번** 다시 시도한다. 검증되지 않은 실행은 기록에 남고, 두 번째도 실패하면 사용자에게 멈춘다. 건별 승인 설치는 그대로다.
- B1에서 일부러 바꾸지 않은 게이트: 외부 제출용 Pack 쓰기 제안 승인(`HUMAN_APPROVAL_REQUIRED`), 사용자 폴더 파일 이동 제안,
  Jev 비용 동의, `reconciliation_required`. 제출·결제·제3자 발송과 유료 API는 위임에 포함하지 않는다는 AGENTS.md 기준을 따른 것이다.
- 관제센터 문구 3차: 긴 설명 18개를 줄이고 비문을 고쳤다. 영어 화면에서 번역이 없던 7개에 영문을 넣었다.
- 실측 11·12차 (headless만, 위임 모드, Codex gpt-6.1-sol low, 같은 비교 업무를 문장만 바꿔 두 번 등록):
  - 11차(a4eaefe, 안내만): 두 번 다 성공, 가벼움 검증 1회, 189초·188초. 실행 모델 턴은 6 → 6으로 줄지 않았다. 안내만으로는 빨라지지 않는다.
  - 12차(320c735, 읽기 단계 재생): 두 번 다 성공, 가벼움 검증 1회. 두 번째 요청은 읽기 3건을 약 3초에 재생했고
    **실행 모델 턴 6 → 3**, 실행 구간 93초 → 66초, 전체 171초 → 156초. 절차 기록은 한 건에 성공 2회로 합쳐졌다.
  - 남은 시간의 대부분은 접수 분석(약 35초)과 검증(약 45초), 결과 저장·되읽기·완료 제안의 모델 턴 3회다.

- 검증: 소스를 고정하고 quick 스위트 1995/1996 통과. 실패 1건은 2차 문구 정리 때의 옛 문구를 고정한 화면 테스트였고, 테스트를 새 문구에 맞춘 뒤 단독 재실행으로 통과를 확인했다(전체 재실행은 하지 않았다).

### 남김없이 마무리 (2026-10-01, 209cc8e 이후)
소유자 지시: "남기지 말고 마무리". 아래는 그 뒤에 코드로 끝낸 것이다.
- B1 정책 객체(4be5eb4): `work.delegation`에 `registered_folder_moves`(기본 켬)를 넣었다. 소유자가 이동 권한을 준 폴더 안의, 호스트가 검증한
  되돌릴 수 있는 이동 계획은 위임 상태에서 클릭 없이 적용되고 로컬 쓰기로 검증된다. 건별 승인 설치·정책 끔·읽기 전용 권한은 검토 단계를 유지한다.
  실행 결과와 적용 기록에 허용한 정책 버전(`policy_version`)을 남긴다. 일일 한도는 슬롯 시각이 아니라 오늘 시작한 실행 수로 센다.
- 기억한 공개 출처(2ebdb42, 1e71026): 위임 상태에서 호스트가 완전히 읽은 공개 표(CSV, 평면 JSON 배열, GeoJSON FeatureCollection)를
  data 폴더의 `auto-sources.json`에 읽기 전용 http 출처로 기억한다. 설정 지문에 들어가지 않고 소유자의 host 파일을 고치지 않는다.
  자격 증명·사설 주소·조회 문자열(그 순간의 질문)이 있는 URL은 기억하지 않는다. `remember_public_sources`로 끈다.
  Pack 리더가 GeoJSON 피드를 읽도록 http 출처에 `json_rows: features`를 추가했다.
- B2 생애 주기(1e71026): 절차는 후보 → 검증 2회째에 정식 → 연속 실패 2회면 중지 → 다음 검증 통과로 복귀. 관제센터 첫 화면의
  "배운 절차와 기억한 출처"에서 목록·성적을 보고 절차를 끄거나 출처를 잊게 할 수 있다(사람만 가능).
- B3 계획 단계 선택(1e71026): 계획 입력에 가까운 검증 절차 후보(도구 이름만)를 넣고, 계획이 `procedure_selection`으로 하나를 고른다.
  호스트는 자기가 준 후보의 id만 받아들인다. 정식 절차를 고르면 읽기 단계를 재생한다.
- B4 보완: 날짜·시각이 든 인자의 단계는 재생하지 않는다(실측: 시작·종료 시각이 박힌 조회 URL).
- B6(9cf3c6a): 재계획이 기존 단계를 고치면 Swarm은 정지하지 않고 그 단계의 작업자와 하위 작업자만 같은 실행에서 다시 돌린다.
  병렬 실행에서 단일 실행기로 바뀐 Work는 검증된 작업자의 receipt를 증거로 이어받고 다시 읽지 않는다. 단계 추가·삭제와 불확실한 효과는 여전히 멈춘다.
- B7 일부(d393c06): 위임 상태의 Hermes 업무는 다음 지시에 별도 검토 클릭이 필요 없고, 실행 중에 보낸 지시는 그 턴이 끝난 뒤 이어서 전달된다.
  권한 질문 대기와 불확실한 중단 효과는 여전히 소유자가 먼저 확인한다.
- 검증 보조(9cf3c6a, d393c06): Pack 실행 receipt에 출처 주소와 다음 행동을 넣었다. 실행이 읽은 표에서 만든 결과 파일은 호스트가 원본 전체와
  행 단위로 대조해 `source_row_check`로 receipt에 적는다(열 이름이 달라도, 시각 표기가 달라도 값으로 대조).
- Aside 첫 연결: 실행이 처음 웹 도구를 쓸 때 등록된 포그라운드 브라우저 연결을 백그라운드로 미리 연다(탭은 열지 않음).
- 관제센터 문구: 남은 긴 문구 중 어색한 3개를 고쳤다. 나머지는 읽어 본 결과 고칠 필요가 없다고 판단했다.

실측 13~16차 (headless만, 위임 모드, Codex gpt-6.1-sol low):
- 13차(2ebdb42): 수집 업무 2회 성공(190·168초). 모델이 읽은 CSV는 시작·종료 시각이 박힌 조회 URL이라 기억해도 쓸모가 없었고,
  상시 피드는 GeoJSON이었다 → 조회 URL 제외, GeoJSON 지원.
- 14차(1e71026): 첫 실행은 가벼움 검증이 "원본이 잘렸다"며 판단을 미뤄 엄격 검증 5회·410초. 이때 GeoJSON 피드가 기억됐고,
  두 번째 실행은 계획이 그 출처로 **수집 계약을 봉인**하고 Pack으로 수집해 **행을 코드로 검증**했다(171초, 모델 검증 1회는 계약 밖 조건용).
  계획이 `procedure_selection`으로 앞 절차를 실제로 골랐다.
- 15차(9cf3c6a, 출처가 이미 기억된 상태): 두 번 다 Pack 경로·코드 검증, 186·186초, 검증 구간 약 30초.
- 16차(d393c06, 새 data 폴더에서 수집·비교·조사 3건): 3/3 성공. 처음 하는 수집이 행 대조 덕에 가벼움 검증 1회·170초로 끝났다(14차 410초).
  비교 업무는 가벼움 검증이 인용 하나를 다른 receipt에 잘못 붙였다는 이유로 판단을 미뤄 엄격 검증 5회·288초 → 아래 인용 규칙 수정.
- 가벼움 검증 인용 규칙: 다른 receipt에 잘못 붙인 실제 인용은 그 인용이 보이는 receipt로 옮기고, 어디에도 없는 인용(의역)은 근거로 쓰지 않는다.
  남은 인용 중 관측값에 해당하는 것이 하나도 없으면 여전히 엄격 검증으로 간다.
- 17차(4e10f92, 새 data 폴더, P1~P7 전체): **7/7 성공**, 68~190초, 검증 호출 0~1회(엄격 검증으로 간 건 없음), 승인 요청 0, 사람 개입 0.
  산출물 확인: P3는 a1·a3·a4·a6 네 행, P4는 2·2·2 합계 6, P6은 `submitted:false`·비GET 요청 0, P5는 일정 켜짐. P1·P2·P7 값은 페이지 읽기 기록과 일치한다.
- 검증: 소스 고정 quick 스위트 2008/2008 통과(4e10f92). 그 직전 실행은 `runtime-control-layout`에서 1건 실패 뒤 멈췄는데, 단독 실행과
  전체 재실행에서 재현되지 않았고 원인은 확인하지 못했다.

하지 않은 것과 이유:
- 원격 봇(OpenClaw, SSH)의 지시 대기열: 실제 서버에 쓰는 동작이고 사용자의 운영 서버는 건드리지 않기로 했으므로 fixture만으로는 바꾸지 않았다.
- 가져온 봇 결과의 호스트 검증(B7의 나머지): Hermes·원격 봇은 receipt가 아니라 답변 글만 돌려준다. 증거 없이 "검증됨"을 붙일 수 없다.
- Jev로 짧은 판단을 넘기는 것(B4): 유료 API이고 자격 증명 없이 실측할 수 없어 만들지 않았다.
- 엄격 검증 자체의 속도: 최종 비교 호출을 건너뛰면 거짓 성공 위험이 생긴다. 엄격 검증으로 가는 경우를 줄이는 쪽(행 대조, 수집 계약)으로 처리했다.
- 알림 수준 설정: 알림을 보내는 통로가 결과 전달 외에 없어 설정만 만들지 않았다.

## 최단 경로·Jev·알림·가져오기 (2026-10-02, 54f07f5 이후)

소유자 지시: Jev는 로컬 키로 확인하고 기본 켬, 알림은 텔레그램으로 실측, 다양한 시나리오와 봇 가져오기 실험, "항상 최단 경로".

### 시간은 어디에 쓰이는가 (22차 실측)
- 한 업무 약 100초 중 실제 일(읽기·저장)은 1~3초다. 나머지는 모델 호출 5회의 대기다: 계획 약 27초, 실행 턴 회당 11~17초, 검증 약 35초.
  구독 CLI는 내용이 없는 호출도 약 5초가 든다. 따라서 줄일 것은 호출 수다.

### 구현
- 반복 업무의 템플릿(a0b1408, 수정 포함): 검증된 첫 실행의 결과를 템플릿으로 저장하고, 각 값이 페이지 어디에 있었는지(앞 문구·모양)를 보정값으로 둔다.
  반복 실행은 호스트가 같은 페이지를 읽고 같은 자리에서 값을 뽑는다. 값이 바뀐 곳은 Jev가 같은 필드인지 확인한다. 못 찾거나 확인되지 않으면 모델이 이어받는다.
  실측에서 "1 USD"의 1을 타임스탬프에 잘못 묶어 틀린 결과를 만든 사례가 나왔고(검증이 잡음), 온전한 토큰 매칭·자릿수 급변 불가·한 자리 숫자는 문구·복사한 제목은 앞뒤 문맥으로 묶기로 고쳤다.
- 최단 경로: 같은 요청(업무 단어가 같음)은 검증된 계획을 다시 써서 계획 호출을 생략한다. 템플릿이 검증된 반복을 2회 통과하면 신뢰 템플릿이 되어
  호스트가 읽기·추출·저장·되읽기·완료 제안까지 하고, 결과는 "그 템플릿의 이번 실행 출력"이라는 계약으로 코드 검증한다(10회마다 전체 검증).
- 결과 저장 뒤 되읽기는 호스트가 한다. 한 번의 모델 결정이 읽기를 최대 6개 더 요청할 수 있다(`also_read`). 실행기에 주는 오래된 읽기 결과는 앞부분만 준다.
- Jev: AI 사용을 허용한 업무의 Pack 판단은 기본으로 Jev 우선·AI 보조. 하루 예산 `paid_judgment_daily_calls`(1000). 실호출 확인(건당 0.2~0.5초).
  일반 실행 흐름에는 Jev가 대신할 판단 지점이 없었고("완료 시점" 판단 실험은 28곳 중 0곳 적중), 템플릿 반복의 값 확인에서 실제로 쓰인다.
- 알림: `work.delegation.notify`(기본 `results_and_owner`). 검증된 완료와 사용자만 풀 수 있는 정지를 메신저로 보낸다. 메시지는 업무 제목·상태에 이어
  결과 본문 자체를 플랫폼 길이 한도에 맞춰 줄 단위로 싣고, 원본 파일은 앱에 남긴다.
- 실측에서 드러나 고친 결함: IPv6가 안 닿는 망에서 Node가 0.25초 만에 포기해 텔레그램 연결 실패, 출처 제목이 빈 결과가 기록·전달되지 않음,
  확인 필요 알림이 대기열에 머묾, 소셜 링크 하나로 업무 전체 실패, 피드를 바이트 단위로 나눠 읽음, 큰 저장소 가져오기 스캔이 범위와 무관한 파일을 읽음.

### 실측
- 21차: 값이 바뀌는 페이지의 반복 실행에서 Jev 1회 확인, 실행 턴 3 → 1.
- 22차(기본 팩에 없는 시나리오 5종 × 문장을 바꿔 2회): 10/10 성공, 거짓 성공 0. 재요청은 실행 턴 3~4 → 1~2. 환율 건에서 위 템플릿 결함 발견.
- 26차(같은 요청 5회 연속, 신뢰 템플릿): 94 → 50 → 60 → 10 → 10초. 4·5번째는 모델 호출 0회, 실행 2초(10초는 측정 스크립트의 확인 주기).
  결과 5건 모두 텔레그램 전달.
- 봇 가져오기(C:\prompt-expert의 "읽을거리" AI 뉴스 봇): 범위 반영 전 스캔은 봇을 찾지 못했고, 반영 후 출처 목록·15분 주기 Worker·발견 경로를 분석했다.
  스캔으로 가져온 프로젝트 업무는 설계상 Office가 직접 실행하지 않아, 분석 내용을 Office 소유 업무로 등록해 실행했다.
  원래 범위(피드 4개, 글마다 원문 추적)는 20분 안에 끝나지 못했다. `also_read` 적용 뒤 모델 13턴으로 읽기 64건을 처리했지만 여전히 시간 안에 결과를 내지 못했다.
- 28차(뉴스 봇 원래 범위, "충분히 읽었으면 저장" 장치 적용): 실행 340초에 8건짜리 결과 파일을 저장했다. 검증은 가벼움 → 엄격 27배치로 넘어가
  "빠짐없이 다뤘는가"를 증명하지 못해 `awaiting_review`(검증 564초). 확인 필요 알림의 텔레그램 전송은 응답을 확인하지 못했다(원인 미확인).
- 검증: 소스 고정 quick 스위트 2021/2022. 실패 1건은 "마지막 관측이 저장 결과"라고 가정한 픽스처였고(호스트 되읽기 추가로 바뀜), 픽스처를 고친 뒤
  그 파일만 재실행해 통과를 확인했다. 전체 재실행은 하지 않았다.

### 릴리즈 전 점검 (2026-10-02, e141038 이후)
- 텔레그램 "미확인": 메시지는 전달됐는데 확인 응답(한글 이스케이프로 약 25KB)이 8KB 읽기 한도를 넘어 미확인으로 기록됐다. 한도를 올렸고 실제 전달을 확인했다.
- 넓은 업무 검증: 실행 기록은 receipt를 32건만 보관한다. 60건씩 읽으면 결과의 근거가 창 밖으로 밀려 검증할 수 없었다.
  - 결과 저장 전 읽기는 22건에서 멈춘다(저장·되읽기·보완 읽기의 자리를 남김). 16건부터 "확인된 것으로 저장하라"고 알린다.
  - 한 번의 읽기는 10KB까지다. 그보다 큰 receipt는 보관 한도에 맞춰 중간에서 잘렸고 검증이 판정 불가로 처리했다.
  - 가벼움 검증은 결과가 주소를 적은 읽기만 내용을 보여 주고 나머지는 목록으로 준다. 저장 결과의 본문은 한 번만 싣는다. 시작하지 못한 이유를 기록한다.
  - 열린 집합에 대한 "빠짐없이" 조건은 결과가 밝힌 출처·기간 범위로 판단한다.
- 가져오기: 스캔 미리보기에 `office_prompt`(분석한 업무 + 범위 안 파일의 공개 주소)와 "Office에서 새 업무로 실행" 버튼. 원본의 실행 주체 규칙은 그대로다.
- 실측 29~34차: 환율 업무 4회 연속 모두 정답(템플릿 규칙 수정 뒤 틀린 값 없음). 뉴스 봇(피드 4개, 최근 7일)은 499초에 부분 결과를 저장했고,
  가벼움 검증 1회가 "결과 스스로 확인이 미완료라고 밝힌다"는 이유로 미충족 판정 → 사용자 확인 대기, 텔레그램 `[확인 필요]` 전달. 판정은 옳다(거짓 성공 아님).
  가져오기에서 만든 업무는 31차에 피드 12개를 읽고 6건 결과를 저장했다(검증은 당시 결함으로 실패). 34차는 계획이 "어느 기존 봇인지" 되물어 멈췄고, 업무 문장에 Office가 직접 수행함을 적도록 고쳤다(이 수정 뒤 재실측은 하지 않았다).
- 검증: 소스 고정 quick 스위트 2025/2025 통과(가져오기 문장 수정 직전 소스).

### 남은 것
- 처음 하는 업무는 여전히 모델 호출 5회(약 100초)다. 계획과 검증의 입력을 줄이거나 호출을 합치는 일은 하지 않았다.
- 넓은 업무는 읽기 22건 안에서 끝나지 않으면 부분 결과와 함께 사용자 확인으로 멈춘다. receipt 보관 창(32건)을 넓히는 일은 하지 않았다. 매일 도는 수집은 범위를 최근 1일로 두는 것이 맞지만 그 범위의 통과는 실측하지 않았다.
- "Office에서 새 업무로 실행" 버튼은 브라우저 테스트가 없다.
- 표(CSV) 결과는 템플릿 대상이 아니다. 기억한 출처·수집 계약 경로가 맡는다.

## 다음 행동

1. 반복 예약 Work에서 절차 재생과 기억한 출처의 효과를 며칠에 걸쳐 실측한다(같은 날 연속 실행만 측정했다).
2. Pack 수집 뒤 모델이 되읽는 턴(현재 4~5회)을 줄인다.
3. 가져온 봇 결과에 증거를 붙일 방법(봇이 receipt를 돌려주게 하는 계약)을 정한 뒤 B7의 나머지를 한다.
