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

### 남은 것
- B2(자동 Pack화·성적), B3(계획 단계 Pack 선택), B4(재생·Jev), B6(실행 중 방향 전환), B7은 시작하지 않았다.
- B1의 나머지: 정책 객체의 효과 유형·예산·알림 수준, 로컬 Pack 쓰기 제안 승인과 Jev 비용 동의의 정책 조회 전환,
  `awaiting_review`·`reconciliation_required`의 자동 재계획/자동 조회.
- 수집을 Pack(코드 검증) 경로로 보내려면 사용자가 쓴 공개 URL을 읽기 전용 소스로 자동 등록해야 한다. 지금은 브라우저·텍스트 읽기 +
  결과 파일로 처리해 모델 판단(가벼움 검증)에 의존한다.
- 엄격 검증은 여전히 느리다(receipt 6개 안팎에 6배치+최종, 5~7분). 가벼움 검증이 판단하지 못하는 경우를 계속 줄여야 한다.
- 관제센터 문구는 고빈도 29개만 고쳤다. 가져오기·코딩 세션·전달 화면의 긴 설명(약 100개)은 다음 차례다.
- 설치본(install.sh → 온보딩)을 깨끗한 환경에서 처음부터 밟는 검증은 이번에 하지 않았다.

## 다음 행동

1. 깨끗한 환경에서 설치 → 온보딩 → 첫 Work까지 실제로 밟아 막히는 지점을 고친다(이번 측정은 이미 구성된 개발 환경에서 했다).
2. B1 정책 객체를 완성하고 남은 건별 게이트(로컬 Pack 쓰기 승인, Jev 비용 동의)를 정책 조회로 바꾼다.
3. 사용자가 쓴 공개 URL의 읽기 전용 소스 자동 등록으로 수집을 코드 검증 경로로 보낸다. 그 뒤 B2(자동 Pack화).
4. 엄격 검증 시간 단축과 관제센터 나머지 문구 정리.
