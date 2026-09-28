# Phase 70 — Work 계획과 압축 인계

작업 위치: `/home/<user>/projects/agent-driver/release-v0.2.0`, `release/v0.2.0`.
개인 런타임과 원본 no-Git 사본은 수정하지 않았다. 시작 시 이미 변경되어 있던 Phase 69 문서 내용은 보존했다.

## 완료한 구현

- RQ-714: Work plan v1, imported DAG·근거·효과 범위 보존, 순환/없는 의존성 검사. 기존 import는 원본을 다시 쓰지 않는 계획 투영.
- RQ-715: `runtime_work_context`, 보호된 목표/지침/영수증을 포함한 해시 결속 계약. 코딩 단계는 압축 계약을 사용하고 전체 체크포인트는 Git 메타데이터에 유지.
- RQ-716: 저장된 근거 색인과 선택적 최대 5개 본문 조회, 프로젝트 안내/테스트/소스 경로 맵.
- RQ-717: SQLite 기반 문맥 크기·반복 부분·코딩 단계 결과·재시도·이전/새 프롬프트 크기 관측. Work 상세 화면의 접힌 계획/인계 영역. 미관측 토큰을 추정하지 않음.

## 검증과 남은 것

- 빌드 및 집중 Work/import/coding/UI 검증을 진행했다. 초기 코딩 테스트의 구 프롬프트 문구 기대 1건은 압축 계약·영수증 검증으로 갱신 후 통과했다.
- 전체 quick 검증 `runtime-tests-2026-09-26T01-48-22-969Z.json`은 617/627이었다. 브라우저/복구 7개 실패, 구 빌드와 새 테스트 불일치 2개, 입력 fingerprint 변경 1개를 기록했다. 해당 실행을 최종 소스의 통과 증거로 쓰지 않는다.
- `runtime-interface.test.mjs` 자식 PID 3848717은 테스트 출력 종료 후 정리 단계에서 장시간 멈춰 해당 자식만 SIGTERM했다. 사용자 런타임은 종료하지 않았다.
- 첫 집중 재검증 `runtime-tests-2026-09-26T02-47-29-124Z.json`: 83/83 통과(82개 사례 + 입력 일치). 실제 CLI/모델은 fixture runner이며 실서비스 성공으로 해석하지 않는다. 데스크톱/모바일 UI 검증 포함.
- 실패 7개 단독 재현 `runtime-tests-2026-09-26T02-53-45-052Z.json`: 6개 재통과 + 입력 일치, persistent browser profile 재시작 1개 실패(총 7/8). 최초 실패 기록은 그대로 보존. 아직 전체 정상 판정 불가.
- 마지막 점검에서 Work의 최신 실행과 실제 이어받는 실행이 다를 가능성을 보완했다. `runtime_work_context.run_id`로 현재 회차에 결속하고 다른 Work의 회차를 거부한다.
- 최종 소스 빌드 + 집중 검증 `runtime-tests-2026-09-26T03-01-28-899Z.json`: **84/84 통과**(83개 사례 + 입력 일치). Work/import/coding/dialog/continuity/client-handoff/UI 포함. `git diff --check`, `ledger:verify` 통과. 공개 범위 패턴 검사 403개 파일에서 발견 0개(포괄적 비밀 검증 보증은 아님).
- 익명 owned browser 진단 `/tmp/agent-driver-phase70-cdp-3EztcZ/report.json`: 일반 localhost 응답 20~140ms, CDP 응답 1,186~2,365ms. CDP만 500ms probe에 반복 취소됐다. 진단 스크립트는 공개 트리 밖 `../phase70-cdp-diagnostic.mjs`에 보존.
- `tests/runtime-browser-auth.test.mjs`의 개별 probe를 남은 전체 예산 내 최대 5초로 수정했다. 전체 준비 제한 30초와 로그인 유지/작업용 페이지 정리 검증은 유지. 실패를 삭제하거나 결과를 재분류하지 않았다.
- 수정 후 `runtime-tests-2026-09-26T03-06-46-535Z.json`: **2/2 통과**(실브라우저 프로필 지속성 사례 + 입력 일치). 이전 실패 7개 중 6개는 단독 재통과했고 마지막 1개는 관측에 근거한 probe 수정 후 통과했다.
- RQ-718은 partial 유지. 운영 소스 관련 집중 검증은 끝났으나 최종 상태의 전체 quick 일괄 재실행은 하지 않았다. 전체 회귀 green이나 출시 승인으로 해석하지 않는다. 다음 행동은 `npm run test:runtime`으로 최종 전체 quick 재실행.
- 운영 배포·공개 릴리즈·유료 모델 호출은 하지 않았다. 일반 외부 에이전트의 재개 성공은 영수증이 없으면 미관측이다.

## 먼저 읽을 파일

`docs/work-context-contract.md`, `src/work/plan.ts`, `src/work/context.ts`, `src/coding/runtime.ts`, `tests/runtime-work-migration.test.mjs`, `tests/runtime-coding.test.mjs`.

## 고정 버전

제품 0.2.0 유지. Node 22.22.0 / npm 11.11.0 / TypeScript 7.0.2 / Playwright 1.63.0. 의존성 변경 없음.
