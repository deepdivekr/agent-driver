# 커스텀 Pack 신뢰성 리팩토링 — Source of Truth

Status: R0–R5 merged in main e0a8e07; October 1 post-main collection/reliability fixes implemented and locally verified. Original 24-case acceptance remains partial (1/24).
Delivery update (October 1): the user explicitly authorized committing and merging
the completed common fixes into main. This supersedes the earlier branch-only
delivery restriction, not the live acceptance criteria. No new release or personal
installation replacement is included. The latest full-suite source is ab960f7.
Current baseline: e0a8e0790b64ff663fa87f5d894b415a1d6f1843.
Current branch: fix/main-work-reliability.
Original refactor baseline: 0b11f1850a2afa846f191ce356aa4f486284b41f (refactor/custom-pack-reliability).

이 문서는 제품 방향, 구현 범위, 수용 기준의 기준 문서다.
진행 상태와 실제 검증 결과는 custom-pack-refactoring-progress.md에 기록한다.
최종 검증 수치와 입력 해시는 custom-pack-refactoring-validation.json에 저장한다.
대화 요약이나 이전 제안이 이 문서와 충돌하면 이 문서를 우선한다.
사용자의 새 명시적 지시가 방향을 바꾸면 근거와 함께 이 문서를 갱신한다.

## 1. 제품 목적

Agent Office는 개인과 업무의 구체적인 반복 작업을 커스텀 Pack으로 익히고,
반복 수행하며, 실패에서 복구하고, 사용자가 예외에 개입하는 관제센터다.

이용자는 업무를 설명한다. 에이전트는 실제 입력과 환경을 관찰하고 실행
절차를 설계한다. 최초 결과를 검증한 뒤 같은 업무의 절차와 완료 조건을
재사용한다. 매 실행의 새로운 결과는 실제로 확인한다.

성공 기준은 연결된 도구 수가 아니라 다음 실행을 맡길 수 있는 신뢰성이다.

### 범위에 포함

- 구체적인 Pack의 이름, 불변 버전, 검증된 실행 계약과 재사용.
- 현재 family recipes와 Work 단계/실행기의 점진적 활용.
- 입력/원본/대상/출력의 명시적 계약과 증거 연결.
- 기술적인 사실을 검사하는 코드 검증기, 필요한 의미 판단.
- 중단, 수정, 부분 재개, 검증만 재개, 안전한 보충 조회.
- 스케줄과 반복 실행의 독립 실행 ID, 중복 효과 방지.
- 사용자에게 현재 상태와 가능한 개입을 정확히 보여주기.

### 이번 리팩토링의 범위 밖

- 범용 외부 도구 마켓플레이스와 수천 개 도구 카탈로그.
- Composio/Pipedream 등 다중 SaaS 연결 플랫폼 구축.
- 모든 업무에 새로운 외부 도구나 Docker 의존성 강제.
- 전체 UI의 React 이전, 새 DB/분산 큐/워크플로 엔진 도입.
- 현재 지원되지 않는 임의 다단계 실행을 지원한다고 표시하기.

특정 Pack에 API나 CLI가 더 적합하면 실행 의존성으로 사용할 수 있다.
도구 선택은 업무의 완료 조건과 복구 가능성에 근거한다.

## 2. 최신 변경과 증거 기준

main의 7efc862는 v0.4.0 공개 기준이다. 최신 원격 브랜치
docs/phase104-issue-resolution에는 다음 변경이 추가돼 있다.

- 36b5b37: CLI 유지보수와 모델 목록/기본값 갱신, 실행 제어.
- 0b11f18: 실사용 복구, 검증 전용 재시도, source/readback 증거,
  local-record 준비, native output certificate, 계약 오류 진단.

위 기능을 재사용한다. 구현을 다시 만드는 계획으로 돌아가지 않는다.

Phase112의 공개 handoff는 quick 1776/1776 PASS와 실제 24건의
PASS 0 / FAIL 23 / NOT_RUN 1을 구분한다. FAIL에는 중단/미완료도
포함된다. 이 기록은 23번의 제품 crash를 의미하지 않는다.
비공개 DB/receipt가 없는 환경에서 실제 24건을 재검증했다고 주장하지 않는다.

선택 사례의 10/250은 요금제의 동시 브라우저 용량 조건이다.
Office의 10/250개 동시 Work 부하 시험으로 해석하지 않는다.

## 3. 목표 구조

사용자 지시 → Work 제어 → 커스텀 Pack의 명시적 단계 → 기존 실행기
→ 원본 관측/산출물/실행 기록 → 조건별 검증 → 결과 제공/전달.

- Work는 목표, 권한, 단계 의존성, 개입과 복구를 소유한다.
- Pack은 특정 업무의 입력, 절차, 완료 조건, 반복/복구 정책을 소유한다.
- 실행기는 현재 파일/HTTP/브라우저/공식 CLI를 재사용한다.
- 검증기는 실행 계약에 따른 기술 사실과 사용자 목표의 의미를 구분한다.
- 정상 진행, 감시 due/변경 없음/이벤트 연결은 코드가 판단한다.
- 모델은 최초 설계, 필요한 해석/분류/생성, 예외 재계획을 담당한다.

기존 8개 family는 실행 재료/분류로 유지한다. 특정 반복 업무를
식별하는 이름/버전/완료 계약을 그 위에 둔다. 첫 구현은 현재 실제로
실행 가능한 recipe 범위를 사용하며, 기존 Work 단계가 지원하는 범위와
독립적인 새 워크플로 엔진을 만들지 않는다.

## 4. 구현 단위와 완료 기준

### R0. 기준 문서와 복귀 절차

- 이 계획서와 진행 기록을 저장하고 루트 AGENTS.md에서 지정한다.
- 압축/재개 후 문서와 실제 git 상태를 먼저 점검한다.
- 각 구현 단위의 결과, 테스트, 제한과 다음 일을 기록한다.

### R1. Pack 입력/원본/출력 계약

- local record의 read_fields와 수정 fields를 분리한다.
- 원본 status와 비대상 필드/행 보존을 호스트가 확인한다.
- 소스의 명시적 numeric_columns를 수집 경계에서 정규화한다.
- 원본 bytes/DOM hash와 정규화된 관측을 구분한다.
- 등록된 필드를 아는 소스는 실행 전 참조 필드를 확인한다.
- Work 결과는 명시적 TXT/JSON/CSV 형식을 지원하고 재읽는다.
- 기존 설정과 receipt 의미, 권한 범위를 유지한다.

### R2. 검증 계약

- 명시적인 typed native check로 출력 family/형식/열/행 수/정렬 등의
  기술 조건을 검사한다. 임의 자연어와 metadata를 연결해 우회하지 않는다.
- 호스트가 같은 Work의 저장된 run과 현재 source/artifact를 재확인한다.
- 감시에는 별도 native_watch_observations 계약을 사용한다. 기준/후속 관측,
  요청된 최소 관측 간격, 실제 비교 필드, 변경/하락 판정, 같은 회차의 로컬
  이벤트를 코드로 확인한다. 금지 행동 부재는 별도 닫힌 실행 기록으로 판단한다.
- 2026-10-01 사용자 승인에 따라 수집·변환 업무의 최초 LLM 해석(출처,
  기간, 필터, 전체 수집 범위, 저장 형식)을 호스트가 업무 계약으로 고정한다.
  코드는 저장된 원본 전체에 그 조건을 다시 적용해 누락·중복·값·형식을
  실제 산출물과 대조한다. 정답 행 수를 사례별 상수로 고정하지 않는다.
- 최초 계약으로 표현된 수집 조건을 모두 코드로 확인한 경우 추가 LLM
  승인은 요구하지 않는다. 나머지 요약·분류 등 의미 조건만 모델이 검증한다.
  계약이 없는 기존 업무는 기존 독립 목표 검증을 유지하며, 사용자 지시를
  바꾸거나 새 증거를 과거 receipt에 덧붙이지 않는다. 새 계약은 정상 정의·
  명시적 재계획·검증된 반복 준비 경로에서만 봉인한다.
- 등록된 파일/명시적인 HTTP 응답 전체와 원격 서비스의 모든 페이지는
  구분한다. 관측하지 않은 페이지·시점·기간의 완전성을 주장하지 않는다.
  실행기가 최초 계약의 출처·조건을 바꾸면 거절하고 재계획을 요구한다.
- 과거 성공/모순 evidence를 숨기거나 조건을 약화해 통과시키지 않는다.
- 검증만 재개하는 경로와 bounded repair를 재사용한다.
- 지속적인 검증 재사용은 관측 시간/방향/범위/내용 변화가 안전하게
  무효화될 때만 도입한다. unsafe generic cache는 이번 범위에 넣지 않는다.

### R3. 실행과 복구

- 알려진 no-effect read-only 관측은 bounded repair에서 새로 읽을 수 있다.
- local/external 쓰기, unknown/uncertain 효과는 반복하지 않는다.
- Swarm의 기존 verifiedWorkflowAnswer가 증명하는 정상 진행은 코드로
  결정하고, 실제 예외 판단/재계획은 기존 경로를 유지한다.
- 스케줄 due/실제 두 관측/변경 없음의 기존 watch 기능을 유지한다.
- 모델/계약/기술 실패/사용자 중단을 구분해서 보고한다.

### R4. 커스텀 Pack의 불변 버전과 반복

- 검증된 특정 실행 recipe와 원래 Work 완료 계약을 함께 저장한다.
- draft와 ready를 구분한다. recipe 성공만으로 사용자 목표 검증을
  주장하거나 활성 버전을 만들지 않는다.
- 버전은 수정하지 않고 새로운 버전을 만든다. 과거 실행은 원래 버전을
  유지하며 recipe/config/engine/계약 binding을 확인한다.
- 각 반복 실행은 별도 request/run ID를 사용한다. 과거 출력은 새 출력이나
  현재 remote 관측으로 간주하지 않는다.
- 현재 등록 단위는 검증된 하나의 recipe다. 여러 다른 recipe를 실행해야
  완료되는 Work를 단일 Pack으로 등록하지 않는다.
- 회차 준비는 새 Work를 만들고 실행하지 않는다. 실행은 명시적인
  current_run_only를 요구한다. 다음 반복은 새 cycle_id로 준비한다.
  자동 반복은 기존 WorkSchedules를 사용하고, 명시적인 일정과 미래 모델
  사용 승인을 요구한다. 각 예약 slot은 새 커스텀 회차 Work를 생성한다.
  같은 커스텀 회차 Work의 자동 재실행은 과거 출력 재사용을 방지하기
  위해 허용하지 않는다. 기존 일반 Work 스케줄은 유지한다.
- 커스텀 일정 여부는 일정 행에도 별도로 저장한다. 부모/회차 연결 정보가
  유실돼도 일반 실행으로 대체하지 않는다. 손상된 회차만 보류하며 정상
  업무는 계속한다. 실패·검토·불명확한 효과는 다음 회차보다 복구를 우선한다.
- 관측 전체 행 수가 달라지는 업무는 명시적인 observed_source_rows 수량
  규칙을 사용할 수 있다. 고정 9행 같은 조건은 여전히 정확한 숫자를 쓴다.
- 기존 저장 recipe/Works는 호환 독자를 통해 이어간다.

### R5. 전체 검증과 전달

- 변경별 behavioral tests, TypeScript build, frozen quick suite를 실행한다.
- input fingerprint를 통해 전체 검증 중 source/test/dist가 바뀌지 않았음을
  확인한다. ledger/public-boundary 검사를 통과시킨다.
- 비공개 24건은 복구 성공/남은 증거 부족/불명확한 효과를 각각 유지한다.
- 실제 재실행이 가능한 공개 source acceptance만 별도로 보고한다.
- 최종 소스 revision과 결과를 진행 기록에 쓰고 커밋/브랜치 푸시한다.
- 개인 설치 교체와 새 공개 release는 이 작업에 포함하지 않는다.

## 5. 23건의 추적과 수용 기준

| 번호 | 사례 | 변경/수용 기준 |
|---|---|---|
| 1 | 조회 USGS | CSV의 정확한 내용/readback 검사; 중단 뒤 남은 검증만 재개 |
| 2 | 조회 311 | 필터 결과의 전체 식별자/내용/hash 검사 |
| 3 | 조회 식품 | 해당 관측의 Critical 9행과 출력의 정확한 대응 |
| 4 | 파일 USGS | 완료 요청은 검증 시작; 이전 completion_verified 대기 없음 |
| 5 | 파일 311 | 보고서와 현재 검증/산출물 버전 연결; 원본 재생성 없음 |
| 6 | 파일 식품 | 변환/readback 성공 보존; 검증 재개 |
| 7 | 분류 USGS | 실제 출력 형식 제공; 명시하지 않은 형식 요구로 대기하지 않음 |
| 8 | 분류 311 | 응답 형식/실행 계약 오류 구분과 제한된 보정 |
| 9 | 분류 식품 | 분류 의미와 TXT 산출물 검사 분리 |
| 10 | 수정 주차 | 안전한 원본 보충 조회 허용; 쓰기 replay 금지 |
| 11 | 수정 소음 | 수정 권한과 별도로 원본 status 읽기 계약 제공 |
| 12 | 수정 식당 | 전체 원본/초안 비교; 비대상 필드/행 보존 |
| 13 | 폼 데모 | 입력 전후 값/캡처/대상/run 연결 |
| 14 | 폼 지원 | 실패 호출의 not-dispatched/unknown 구분; 기록 부족은 미확인 |
| 15 | 폼 평가 | 금지된 제출/전송/가입을 각각 scoped trace로 확인 |
| 16 | 선택 10 | 가격/조건/Pack/대상/초안 binding 확인 |
| 17 | 선택 250 | 등록 유지; 정의 단계만 복구; 원인별 진단 |
| 18 | 검색 HN | 선언한 숫자 타입 정규화와 필터 전 검사 |
| 19 | 검색 Node | 요청 URL/source/관측 시점 보존과 권한 내 보충 조회 |
| 20 | 검색 Ethereum | 저장 HTTP 관측/request/run/hash binding; freshness 과장 없음 |
| 21 | 감시 HN | 두 관측과 변경 이벤트 연결을 코드 검사 |
| 22 | 감시 Node | first_released 등 선언 필드를 실행 전 검사; 추측 치환 없음 |
| 23 | 감시 시세 | 두 관측과 하락 없음 정상 판정; 별도 audit 모델 루프 제거 |

기존 matrix의 명시적인 Pack 실행 조건은 유지한다. 실제 목표가 완료되지
않은 과거 사례를 새 테스트의 PASS로 바꾸지 않는다. 남은 24번째 선택
사례도 별도 완료 증거가 확보되기 전에는 NOT_RUN/미완료로 남긴다.

## 6. 벤치마킹 적용 범위

### October 1 user-directed capacity correction

The user explicitly requested no arbitrary file-collection size limit. Remove
the 8 MiB / 10,000-row ceilings from file/HTTP collection, exports, artifact
readback and native output verification together. Read/hash/write in chunks and
keep model evidence pages bounded; a page is never the entire original. Preserve
complete inputs/results and report missing coverage or resource errors instead
of declaring partial processing complete. This does not add PDF/EXE parsing or
remove schema, path, approval, browser-DOM or per-model-call protections. Existing
in-memory row/checkpoint storage still consumes resources in proportion to rows;
do not claim infinite capacity or constant-memory end-to-end processing.

- Rakazo: 상태 전이, 실행 중 지시의 대상 binding, 실제 산출물 검증 방식.
  전체 DB/큐/Pi runtime과 범용 MCP marketplace는 이전하지 않는다.
- Grok CLI bridge: 필요한 경우 정확한 턴/세션 제어와 접수/실행 불명 구분.
- OpenGrokBot: 개입 UI의 표현만 참고한다. 기존 durable authority를 유지한다.
- pstack/HumanLayer: 반복 규칙의 구조화와 실제 결과 검증 방법을 적용한다.
- Emil: 마지막 조작 품질 정리에서 필요한 패턴만 사용한다.

코드를 실제 이식하면 원본 revision과 라이선스 고지를 기록한다.
원칙만 적용한 변경을 외부 구현을 이식한 것으로 표시하지 않는다.

검토한 공개 기준 revision:

| 원본 | revision | 이번 적용 |
|---|---|---|
| [Rakazo](https://github.com/elie222/rakazo) | 2913bb2f00e463382eabb2254b394026f1e6936c | 상태 전이·실제 산출물 중심 검증 원칙 |
| [Grok Bot CLI](https://github.com/ScriptedAlchemy/grok-bot-cli) | 7ce35cf2c9f326f546f8c44c474bbffc3f771f6f | 실행·접수 identity 구분과 중복 효과 방지 원칙 |
| [OpenGrokBot](https://github.com/wolfqing/OpenGrokBot) | 43ba51fc0487b7adbb23861a1062a113390833d9 | 개입 표현 참고; 기존 durable authority 유지 |

이번 구현은 Agent Office의 기존 실행기/스케줄러를 보강한다.
위 저장소의 코드를 복사하거나 런타임을 교체한 변경은 없다.

## 7. 운영 불변조건

- 사용자 원문과 명시적 후속 지시가 목표의 기준이다.
- typed native proof만으로 전체 사용자 목표를 주장하지 않는다. 최초 목표와
  봉인된 수집 계약의 연결, 현재 출처/결과의 전체 대조, 나머지 의미 조건을
  각각 확인한다. 수집 계약이 전체 요구를 포괄하면 코드 검증으로 완료한다.
- 완전하지 않은 trace로 금지 행동의 부재를 증명하지 않는다.
- 새 결과는 새 실행의 실제 입력/출력으로 검사한다.
- 압축 이후에도 새 마켓플레이스/플랫폼 작업으로 범위를 넓히지 않는다.
- 개선 측정은 모델 호출/검증 시간/불필요한 재실행/사람의 보정 횟수다.
  fixture PASS와 실제 업무 PASS를 구분한다.
