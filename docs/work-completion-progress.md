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

## 다음 행동

A1(검증 거짓 거부 제거)부터 진행한다. 각 단위는 실패 재현 테스트를 먼저 추가하고,
빌드와 관련 테스트를 통과한 뒤 커밋·푸시하며 이 기록을 갱신한다.
