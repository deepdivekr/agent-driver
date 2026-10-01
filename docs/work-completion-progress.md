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

## 다음 행동

A6(지시문 축소: 금지 문장 목록 → 코드 거부 테스트 → 문장 제거 → 크기 테스트),
A7(frozen quick suite와 진행 기록)을 진행한다.
Swarm 결과 경로의 수정 루프(A2 잔여)와 중간 등급(A5 잔여)은 A6 이후 다시 판단한다.
