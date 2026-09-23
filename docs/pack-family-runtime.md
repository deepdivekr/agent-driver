# Pack family runtime v1

## 제품 흐름

```text
사용자의 한 줄 요청
  → runtime_pack_plan
  → 호출 에이전트가 연결 목록과 schema로 최초 recipe 설계
  → runtime이 source/target/field/effect를 다시 검증
  → 코드 수집·정규화 + 필요 지점 Jev 판단 + 불확실 시 LLM/unknown
  → 독립 검증
  → 검증된 recipe만 같은 요청·설정·engine version에 재사용
```

사용자는 family나 JSON recipe를 선택하지 않는다. MCP 클라이언트는 `runtime_pack_plan`을 자연어 시작점으로 사용한다. 연결이 없으면 사이트 이름이나 selector를 지어내지 않고, 필요한 로그인 브라우저/파일/데이터 소스 연결만 요청한다.

## 구현된 family

| family | 실행 결과 | 검증과 경계 |
|---|---|---|
| `research.search` | 연결된 소스 통합 검색·정렬·선택적 Jev 관련성 | 관측 소스 범위, unknown 별도, 전역 최저가 미주장 |
| `portal.collect` | 필터·중복 검증 후 JSON/CSV 내보내기 | 원본 hash·행 수·새 파일 readback |
| `form.draft-submit` | 양식 초안 후 승인 대기·한 번 제출 | pre-submit snapshot·task-bound approval·GET readback |
| `record.update` | 기존 identity의 허용 필드 수정 | 수정 전 hash·관련 없는 필드 보존·GET readback |
| `inbox.triage` | Jev 우선 분류, 필요 시 LLM 보정, 답변 초안 | unknown 보존·전송 0 |
| `monitor.watch` | 기준값 유지·변화/가격하락 event | 재시작 지속·중복 억제·pause·외부 알림 0 |
| `file.pipeline` | JSON/CSV 필터·병합·형변환·정렬·새 파일 | 원본 보존·formula escape·출력 재파싱 |
| `choose.stage` | 장바구니/요청 초안 단계까지 준비 | `cart_or_draft_only` target·승인·결제/예약 확정 금지 |

## 판단 배치

TypeSafe 패턴에 맞춰 Jev에는 현재 한 행 또는 현재 브라우저 관측과 code-built 선택지만 보낸다. `unknown`은 항상 후보에 포함한다. 같은 상태에서 독립적인 질문은 한 요청에 묶을 수 있지만, 한 답으로 생긴 새 후보는 다음 관측에서 묻는다. 수치 필터·정확 복사·파일 I/O·승인·클릭은 코드가 수행한다. Jev가 임계값을 넘지 못하면 LLM은 분류 근거가 실제 레코드 문자열에 존재할 때만 보정할 수 있고, 아니면 unknown이다.

## 연결 설정과 보안

공개 읽기 소스는 host 설정에 `auth_required: false`를 명시할 수 있다. 로그인된 계정을 검증했다는 뜻이 아니다. 기본값은 `true`다.

제출 없이 양식만 채울 때는 target에 `draft_only: true`를 지정한다. 이 경우 `readback_url`은 생략할 수 있고, 결과는 `draft_ready`다. 승인 화면을 열거나 승인 토큰을 외부에 전달하지 않으며 `runtime_pack_execute_approved`도 `PACK_DRAFT_ONLY`로 거절한다. 익명 공개 폼(`auth_required: false`)은 이 초안 모드에서만 허용된다. 초안 브라우저는 일반 form 제출, non-read HTTP와 WebSocket을 차단한다. 사이트 자체의 비정상 GET 쓰기까지 막는 보안 샌드박스는 아니다.

host 설정의 `packs.sources`와 `packs.targets`는 설치/connector 화면이 만드는 내부 설정이다. 사용자용 Pack 메뉴가 아니다. 파일 소스는 읽기만 하고 `.env`, credential 디렉터리는 거절한다. HTTP 소스는 HTTPS GET, redirect 없음, 응답 8 MiB/10,000행 제한이다. fixture 외 평문 HTTP는 거절한다. 브라우저 source/target은 agent-owned persistent profile만 사용한다.

외부 write는 MCP 호출자가 승인할 수 없다. runtime 내부의 loopback approval dispatcher만 비밀 token을 받고, 기본 브라우저의 로컬 화면에 pre-submit PNG와 snapshot을 보여 준다. URL·CSRF·approval token은 MCP에 반환하지 않고, MCP에는 capture/hash/만료와 대기 상태만 보인다. 승인 후에도 최신 폼·기존 레코드가 snapshot과 다르면 중단한다. 응답을 잃었을 때 readback으로 조정하며 consumed approval로 두 번 클릭하지 않는다. loopback 화면과 위조·origin·단일 사용은 fixture에서 검증했으며, 각 OS의 실제 기본 브라우저 실행은 아직 `user_environment` 증거가 없다.

## 아직 과장하면 안 되는 것

- 계약/fixture 통과는 Gmail, Notion, Jira, 쇼핑몰 등 실제 계정 성공이 아니다.
- 임의 웹사이트의 connector 자동 생성은 아직 adaptive browser 경로와 공통 family runtime 사이에 수동 host 연결 단계가 있다.
- 상주 watch는 MCP 프로세스 수명에 의존한다. OS 자동시작과 외부 push 전달은 별도다.
- Windows desktop UIA는 계약만 있고 native guest executor는 여전히 `blocked_env`다.
- Booking 실페이지의 5성급·전체 숙박가 비교는 Phase 33의 partial 상태를 유지한다.

## 중단과 재개

같은 `request_id`와 변경되지 않은 recipe/config로 `runtime_pack_run`을 다시 호출하면 읽기 전용 기술 실패를 최대 3회까지 이어간다. stdio MCP의 기존 주기 tick도 만료된 실행 소유권과 재시도 가능한 작업을 확인한다. 살아 있는 소유자가 처리 중이면 두 번째 실행을 만들지 않는다.

소스별 관측과 완료된 판단은 SQLite에 보존한다. 소스 관측은 5분 이내, 동일한 설정·인자·해시일 때만 재사용하며 로컬 파일은 현재 바이트도 대조한다. 재사용된 관측의 원래 시각을 유지한다. 출력 파일은 이미 저장된 내용과 기대 해시가 일치하면 다시 생성하지 않는다.

`waiting_auth`는 사람이 로그인한 뒤 같은 요청으로 이어간다. 기술 오류와 의미상 `unknown`은 다르게 처리한다. 이미 실행된 쓰기는 독립 결과 확인 전 재전송하지 않으며, 소비된 승인이나 불명확한 외부 효과는 `reconciliation_required`에 남긴다. 무제한 재시도나 모든 실행기 사이의 자동 전환을 보장하지 않는다.
