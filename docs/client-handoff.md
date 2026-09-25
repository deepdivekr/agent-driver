# 클라이언트 인계와 모델 선택

관제센터의 **연결 및 설정 → AI**에서 우선 사용할 클라이언트와 Codex·Claude Code·OpenCode 각각의 모델을 저장한다. 이 설정은 Work가 실행 중이어도 **다음 모델 호출부터** 적용된다. 선택한 클라이언트가 실패하면 연결된 다른 클라이언트를 순서대로 시도하며, 받는 클라이언트에는 그 클라이언트에 저장한 모델을 전달한다. 모델을 선택하지 않으면 공식 클라이언트의 기본값을 사용한다.

모델 드롭다운의 출처는 Codex의 현재 `model/list`, OpenCode의 현재 `models`, Claude Code의 `sonnet`·`opus`·`haiku` 최신 버전 별칭이다. API 공급자 목록은 해당 공급자의 현재 Models endpoint에서 새로고침한다. 목록 조회 실패 시 저장한 모델 ID를 유지한다. 특정 버전 ID를 저장한 경우 새 릴리스가 나와도 자동으로 다른 ID로 바꾸지 않는다. 최신 버전을 계속 따르려면 클라이언트 기본값 또는 Claude의 최신 별칭을 선택한다. MCP sampling의 모델은 호출 클라이언트가 관리하며 이 화면에서 지정하지 않는다.

## 인계 계약

자동 비용 전환은 단방향이다. API 모드에서 인계를 켜면 **API → 구독 인증**을 시도한다.
**구독 인증 → 유료 API**는 허용하지 않는다. 저장된 설정이 없거나 환경변수에 API 키가
있어도 같으며, 과거의 `codex,claude,api` 같은 목록도 API 자동 전환을 허용하지 않는다.
API를 사용하려면 관제센터에서 직접 API 모드를 선택하거나 호스트가 명시적으로
`AGENT_DRIVER_LLM_CLIENT=api`를 지정해야 한다. 인계할 구독이 없으면 업무와 중단 지점을
보존한 채 연결·한도 복구를 기다린다. 요금 방식을 확인할 수 없는 CLI는 자동 구독
후계자로 쓰지 않는다. 사용자가 직접 선택한 외부 클라이언트의 내부 요금·모델 설정은
그 클라이언트가 관리한다.

SQLite `client_handoff` 기록은 `project_id`와 가능한 `work_id`·`run_id`·`stage_id`, 이전/다음 클라이언트 및 모델, 실패 이유, 외부 효과 상태, 인계 상태, 입력 해시, 시간을 갖는다. 실패 이유는 인증 만료, 한도 초과, 속도 제한, 컨텍스트 소진, 공급자 불능 등으로 분류한다. `transferred`, `no_candidate`, `requires_reconciliation`를 구분한다. 원문 프롬프트·CLI 출력·인증 정보는 기록하지 않는다. Work 상세에서 인계 결과를 볼 수 있다.

도구 없는 구조화 LLM 판단은 이전 호출이 외부 효과를 내지 않으므로 클라이언트를 바꾸어 다시 판단할 수 있다. 명시적으로 **구독**을 선택하면 API 과금 경로로 자동 전환하지 않는다. **API**를 선택한 경우에도 기본은 자동 전환하지 않으며, 화면에서 *API 인증·한도 오류 시 연결된 구독 앱으로 이어가기*를 켠 경우에만 대체 클라이언트를 시도한다. API의 무효 요청(예: HTTP 400)이나 잘못된 구조화 응답은 대체 호출로 숨기지 않는다.

코딩 업무의 Claude 읽기 전용 검토·소개문·README 초안은 인증/한도 실패 시 Codex의 도구 없는 구조화 호출로 이어받을 수 있다. 이전 단계의 검증된 영수증과 허용된 Git diff/소스만 전달한다. 문서의 실제 쓰기는 이후 코드가 기존 권한·변경 없음 검사를 통과한 경우에만 수행한다. Codex 구현, README 파일 쓰기 또는 커밋의 결과가 불확실한 경우에는 다른 클라이언트에서 자동 재실행하지 않는다. `requires_reconciliation`으로 정지하고 `runtime_coding_reconcile`의 Git 관측과 사람 검토를 요구한다.

코딩 Work에는 [로컬 Git 체크포인트](coding-orchestration.md#로컬-git-인계-체크포인트)도 적용한다. SQLite의 단계 영수증과 Git 지문에서 다시 만든 인계 내용을 새 클라이언트의 호출 입력에 넣는다. GitHub 원격은 필요하지 않다. 이전 단계 뒤의 외부 Git 변경이 감지되면 다음 CLI 실행 전에 거부한다.

현재 범위는 런타임 내부의 판단 및 위 코딩 단계다. 사용자가 별도로 연 Codex Desktop/CLI·Claude 대화 세션의 메시지 기록을 가져오거나 임의의 외부 에이전트 대화를 자동으로 이어붙이지는 않는다. 클라이언트의 구독 인증과 토큰 갱신은 해당 공식 클라이언트가 소유한다.

공식 모델 목록 참고: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [OpenAI Models API](https://developers.openai.com/api/reference/cli/resources/models), [Claude Code CLI](https://code.claude.com/docs/en/cli-usage), [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list), [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).
