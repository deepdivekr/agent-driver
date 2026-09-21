# 기본 Pack catalog

Agent Driver의 Pack은 사용자가 설치 전에 고르는 메뉴가 아니다. 한 줄 요청은 먼저 **후보 Pack family**로만 분류되며, 알려진 입력·출처·효과·검증 계약이 준비된 concrete Pack만 실행할 수 있다. 이 catalog는 MCP adapter registry가 아니고, 고객별 사이트나 계정을 포함하지 않는다.

| family | 기본 목적 | 효과 경계 |
|---|---|---|
| `research.search` | 출처 탐색·비교·근거 반환 | 읽기 전용 |
| `portal.collect` | 조회·다운로드·정규화 | 서버 쓰기 금지 |
| `form.draft-submit` | 양식 초안·검증·승인 뒤 제출 | 제출마다 승인 |
| `record.update` | 기존 기록의 제한된 필드 수정 | 수정마다 승인 |
| `inbox.triage` | 받은 일 분류·요약·답변 초안 | 전송 금지 |
| `monitor.watch` | 변화 감지·근거 알림 | 후속 행동 자동 시작 금지 |
| `file.pipeline` | 파일 정리·변환·내용 검증 | 외부 업로드 금지 |
| `choose.stage` | 비교·장바구니/요청 초안 준비 | 결제·예약 확정 금지 |

공통 작업 노드는 `observe → discover/collect → extract → normalize → draft → verify → approve → commit → reconcile`이다. 모든 Pack이 모든 노드를 쓰는 것은 아니다. 특히 `form.draft-submit`과 `record.update`는 `commit` 전에 pre-submit snapshot과 task-bound single-use approval을 요구한다.

새로운 한 줄 요청이 catalog 밖이거나 값·효과가 불명확하면, runtime은 관측 또는 명확화 단계로 멈춘다. Jev/LLM의 Pack family 선택은 후보 제안일 뿐 실행 권한이 아니다.
## 자연어와 Jev의 자리

사용자는 “지난달 청구서를 찾아 비교해줘”처럼 한 줄로 시작한다. `runtime_pack_plan`은 연결된 출처·대상과 recipe schema를 에이전트의 LLM에 제공하고, LLM이 최초 실행 recipe를 만든다. 사용자가 Pack 정의서를 먼저 작성하지 않는다. 성공 또는 안전한 watch 시작이 독립 검증된 recipe만 요청 원문·host 설정·`family_runtime_v1`에 결속해 저장하며, 같은 요청은 다음부터 재사용한다. 변경된 입력이나 연결은 새 recipe가 필요하다. 모델의 recipe는 실행 권한이 아니며 runtime이 연결·필드·효과를 다시 검증한다.

Jev는 선택 사항이며 **상태 확인 전용으로 제한하지 않는다**. Task Pack 설계자는 업무를 분해하고 각 단계에서 코드, Jev, 추론·생성 LLM의 역할을 정한다. 설계자는 LLM일 수 있다. TypeSafe의 [function calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling)도 함수 설명·질문·선택지 spec을 LLM이 작성하는 방식을 설명한다.

| 역할 | 적합한 담당 | Pack에 정의할 내용 |
|---|---|---|
| 목표 분해·처음 보는 흐름 탐색·재계획·자유문 작성 | LLM | 목표, 현재 증거, 가능한 도구, 완료 조건 |
| 다음 도구·행동·대상·후보 값 선택 | Jev `Choice` | 현재 관측에서 만든 후보, 선택 기준, 해당 없음 |
| 팝업 방해 여부·조건 충족·성공 근거 확인 | Jev `Noul` | 필요한 증거와 독립된 판단 질문 |
| 후보 관련성·선호도 평가 | Jev `Score` | 구체적인 척도와 순위 조합 방식 |
| 클릭·입력·탐색·다운로드·정확한 계산·권한 확인 | 실행 코드 | selector/locator/DOM 참조 등 대상 결속과 실행 후 관측 |

한 질문은 명확한 판단 단위를 갖되, Jev를 단순 키워드 분류기로 축소하지 않는다. 같은 상태를 사용하는 독립 질문은 묶고, 이전 답에 따라 새 관측이나 후보가 필요한 질문은 다음 호출로 나눈다. API가 직접 마우스를 누르는 것은 아니지만, Jev가 클릭할 행동과 대상을 선택하고 실행기가 수행하는 루프는 유효한 설계다.

각 Jev 지점의 설계에는 `입력 state → 질문/출력 타입 → 후보 생성 근거 → 결과 사용 방법 → 실행 후 검증 → 실패 시 재관측/LLM 전환 → 평가 데이터`를 남긴다. 관측 시점이 바뀌면 오래된 대상 선택을 그대로 실행하지 않는다. 정확한 숫자·날짜·출처 값은 가능한 한 코드로 복사·정규화한다. 확률 임계값은 역할과 데이터에 맞춰 평가하며 보편 임계값 하나로 모든 단계를 중단하지 않는다. 후보 누락·증거 누락·모델 오답·실행기 오류를 구분한다.

이 표는 Pack 설계 기준이다. 현재 공통 family runtime은 호출 에이전트의 LLM이 만든 recipe를 검증·실행·성공 후 재사용한다. `inbox.triage`와 선택적 검색 관련성 판단은 Jev 우선·LLM 보정·unknown 경로를 쓸 수 있다. 자유 UI의 state/action/target 판단은 별도의 adaptive browser loop가 제공된다. 두 경로를 하나의 임의 사이트 자동 연결기로 합쳤다는 뜻은 아니다. typed 응답과 높은 확률도 실행 권한·제출 승인·실제 성공을 대신하지 않는다.

### 브라우저 손 선택

“selector냐 에이전트냐”는 올바른 이분법이 아니다. selector·locator·DOM 참조·좌표는 대상을 지정하는 도구이고, Jev/LLM은 무엇을 할지 결정할 수 있다. 검증된 Pack의 결정론적 절차도 사용할 수 있다. **selector/Playwright/OpenCLI 사용 자체를 이유로 실행을 금지하거나 LLM 경로를 강제하지 않는다.** 모델 제어도 사이트의 자동화 정책과 무관해지거나 탐지되지 않는다는 보장은 없다.

```text
현재 상태·사용자 목표·Pack 범위
  → 검증된 절차 / Jev의 행동·대상 선택 / LLM의 탐색·재계획
  → 브라우저 도구로 탐색·입력·검색·읽기·팝업 처리
  → 결과 재관측·검증 → 다음 단계
```

어떤 판단 경로도 selector를 사용할 수 있고, 결과 읽기·팝업 닫기에만 제한하지 않는다. 처음 보는 UI는 재관측과 모델 판단으로 처리할 수 있으며, 낯설다는 이유만으로 무조건 사람에게 넘기지 않는다. 이미 승인된 로그인 절차 등은 해당 Pack의 범위를 따른다. 실제 인증·동의·외부 쓰기에 필요한 권한 경계는 도구 선택과 별개다.

`browser-execution-policy.ts`는 공개 읽기 전용 여행 Pack을 위한 **독립 hand 선택 helper**이며 현재 실제 여행 runner에는 연결되지 않았다. v2는 검색 폼에도 결정론적 단계를 허용하고, 결과에서도 모델 경로 선택을 존중하며, unknown UI를 적응형 관측으로 보낸다. 이 helper의 source permission·인증·동의·challenge 중단은 해당 읽기 전용 범위에만 적용한다. 이를 모든 Pack의 로그인 금지나 selector 제한으로 확대하지 않는다. 실제 외부 write Pack의 task-bound 승인·독립 readback은 그대로 유지한다.

## 현재 범위

8개 family는 `agent-driver mcp`의 공통 `runtime_pack_*` 도구로 노출된다. 파일·HTTP GET·검토된 브라우저 표 소스, 검토된 브라우저 쓰기 대상이 host 설정에 연결되어야 실제 실행할 수 있다. 연결되지 않은 사이트를 recipe만으로 임의 조작하지 않는다. 읽기 결과·로컬 내보내기·변화 event·답변 초안은 각각 근거/hash/unknown을 남긴다. write family는 기존 durable snapshot·single-use approval·독립 readback을 재사용하며 MCP에는 승인 토큰이나 승인 도구가 없다.

`monitor.watch`는 MCP runtime이 살아 있는 동안 30초 tick과 명시적 tick을 제공하고, 재시작 뒤 SQLite 기준값을 이어간다. 알림은 로컬 event까지이며 Telegram·메일 발송은 승인된 외부 오케스트레이터가 맡는다. write Pack은 loopback 검토 화면을 기본 브라우저에 열고 제출 직전 캡처와 snapshot을 보여 준다. URL·CSRF·approval token은 MCP에 반환하지 않는다. 실제 Windows/WSL/macOS/Linux 기본 브라우저 launcher의 사용자 환경 검증, OS 상주 자동시작, 처음 보는 사이트를 adaptive loop에서 자동으로 concrete source/target 연결로 승격하는 UX는 아직 별도 통합 작업이다.

`travel.price-watch`는 `research.search`와 `monitor.watch` 위에 만든 공개 읽기 전용 예시 Pack이다. 실제 웹 검색·가격 판단은 수행하지만 예약·결제·로그인·외부 알림 전송은 포함하지 않는다. 자세한 데모 경계는 [실제 웹 가격 모니터 데모](demo-travel-price-watch.md)를 따른다.
