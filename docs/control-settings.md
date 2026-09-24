# 관제센터에서 연결과 설정 관리

Agent Driver는 로컬 MCP 실행 도구이며, 관제센터는 그 상태를 보고 연결을 관리하는 로컬 웹 화면이다. 외부 클라이언트가 계획·작업을 요청하고 Agent Driver가 위임받은 실행과 판단을 처리한다.

## 사용자 흐름

설치 에이전트 또는 `install.sh` bootstrap이 `agent-driver connect`를 실행하면 관제센터가 백그라운드에서 시작되고 로컬 브라우저의 연결 화면이 열린다. bootstrap은 홈 디렉터리 안에서 공식 저장소, checksum을 확인한 Node.js 22.22.0, npm 11.11.0, 빌드, Chromium과 절대경로 launcher를 준비한다. 기존 서버는 재사용한다. 자동 열기가 실패하면 같은 주소를 반환한다. 터미널을 닫아도 관제센터는 유지된다. MCP 재접속마다 브라우저가 뜨지는 않는다.

한 화면에 한 단계씩: **에이전트(MCP 등록) → 로컬 실행 → AI 연결 → Jev(선택)**. 완료 후 관제센터로 돌아간다. 언제든 **연결 및 설정**으로 다시 들어가 변경할 수 있다. 마지막 저장 단계를 기억하며 API 키 입력 중인 미저장 내용은 기억하지 않는다.

에이전트 단계는 현재 실행 환경에서 Agent Driver 설치를 확인하고 Codex·Claude Code·OpenCode·Cursor CLI·Hermes를 모두 표시한다. 클라이언트가 없으면 공식 설치, 설치됐으면 공식 로그인, 로그인 여부와 별개로 MCP 등록을 진행할 수 있다. 설치와 등록은 각각 사용자가 버튼을 눌러야 시작한다. 등록에는 shell 없이 절대 경로 command/args를 사용한다. 기존의 다른 MCP server는 유지하고, 같은 `agent-driver` 이름에 다른 명령이 있으면 자동 덮어쓰기를 거부한다. 등록 성공은 클라이언트 설정 저장을 뜻하며, 이미 열린 클라이언트의 실제 재연결은 재시작 또는 MCP 새로고침 뒤 관측한다.

관리 설치는 Linux/WSL에서만 제공한다. 고정된 공식 HTTPS origin에서 shell script를 최대 2 MiB까지 내려받아 redirect와 비 shell payload를 거부하고 `/bin/bash`에 파일 인자로 전달한다. pipe나 조립한 shell command는 사용하지 않는다. script와 raw stdout/stderr는 응답·setup journal에 남기지 않고 임시 디렉터리를 제거한다. checksum 고정이나 공급자 서명 검증은 아직 없으므로 공식 설치 안내를 통한 수동 설치도 항상 제공한다.

화면 하단 **연결 작업 기록**은 사용자가 이 화면에서 실행한 설치·MCP 등록·로컬 실행·AI·Jev 설정의 시작·완료·실패 이벤트를 SSE로 보여준다. 설치·MCP 등록 완료 시 실제 경과 시간을 표시한다. 자동 설치 스크립트의 raw stdout/stderr나 전체 업무 실행 로그를 보여주는 터미널 tail은 아니다. 업무별 실제 계획·진행·인계·결과는 **업무 현황 → 업무 상세**에서 확인한다. API key, 인증 token, 이메일 같은 credential 자료는 기록하지 않는다. 기록은 `~/.agent-driver/setup-activity.jsonl`의 최근 120개로 제한하고 로컬 사용자만 읽을 수 있게 저장한다.

클라이언트 연결은 자동(MCP sampling → Codex → Claude Code → OpenCode) 또는 우선 클라이언트 선택이다. 선택한 클라이언트가 실패하면 연결된 다른 클라이언트가 이어받으며 각 클라이언트에 저장된 모델을 적용한다. Codex는 현재 app-server 모델 목록, OpenCode는 설치된 CLI의 모델 목록, Claude Code는 최신 버전 별칭을 드롭다운에서 선택한다. 모델 목록 확인 실패 시 저장한 선택을 유지한다. 공식 클라이언트의 상태 명령을 사용하며 OAuth 저장소를 읽거나 토큰을 복사하지 않는다. 토큰 갱신도 해당 클라이언트 소유다. OpenCode는 사용자가 OpenCode에 연결한 공급자를 재사용하며, Agent Driver는 모든 도구 권한을 거부한 임시 작업 디렉터리에서 구조화 판단만 요청한다. WSL에서 실행하면 WSL용 로그인 기준이며 Windows 로그인과 공유하지 않는다. Cursor/Hermes는 상태 표시/지원되는 공식 로그인만 제공하고 직접 판단 모델 선택은 제공하지 않는다. [인계 계약](client-handoff.md).

API는 OpenAI Responses, Anthropic Messages, OpenRouter Chat Completions, 사용자 지정 OpenAI 호환 Chat Completions를 지원한다. 공급자, 모델 ID, 추론 강도, 호환 endpoint와 키를 설정한다. 저장 전에 nonce와 엄격한 JSON schema를 넣은 최소 호출을 실제로 보내 키·모델 접근·구조화 출력 계약을 확인한다. 이미 확인한 공급자·모델·endpoint·키가 그대로인 Jev/온보딩 설정 저장은 같은 유료 probe를 반복하지 않는다. HTTP 성공만으로 준비 완료로 표시하지 않으며 모델 연결 설정이 바뀌면 다시 확인해야 한다. 사용자 지정 endpoint는 HTTPS가 기본이고 loopback만 HTTP를 허용하며 URL credential·query·fragment·redirect를 거부한다. 이 검증은 잔액이나 이후 호출의 영구 성공을 보장하지 않는다. 클라이언트 연결로 저장하면 API로 자동 폴백하지 않는다.

Jev는 기존 호스트 설정 유지 / 사용 안 함 / 키로 사용을 선택한다. 없는 키를 요구하며 실행을 막지 않는다. 사용 안 함을 선택하면 새로운 판단 단계는 LLM 경로를 사용한다. 기존에 시작한 판단 단계는 그 단계에서 잡은 공급자를 유지할 수 있다.

사이트 로그인은 이 온보딩에 포함되지 않는다. Task가 URL에 접근하다 인증 벽을 확인하면 해당 worker를 임대 전에 멈추고 관제센터에 **사이트 로그인 N개 필요**를 표시한다. 이 링크에서 필요한 사이트의 로그인 창 열기, 로그인 확인, 접근 재시도를 제공한다. 비밀번호/OTP는 전용 사이트 화면에서 사용자가 입력한다. 기존 owned VM이 있어야 persistent 사이트 연결을 제공하며 로그인 완료/세션 영속성은 보장하지 않는다.

## 실제 적용 범위

- Pack / Swarm / MCP의 기본 판단 bridge는 다음 LLM 호출 시작 시 저장된 선택을 읽는다. 실행 중 LLM 호출은 중단하거나 재호출하지 않는다.
- 새 Jev 판단 단계는 최신 키/사용 여부를 읽는다. 시작된 판단 단계는 완료까지 기존 공급자를 유지한다.
- 현재 task/lease/브라우저 세션, 승인 및 외부 효과 권한은 바꾸지 않는다. 기존 runtime-config 파일도 덮어쓰지 않는다.
- 외부 Codex/Hermes 등 오케스트레이터가 직접 실행한 worker 모델은 해당 호출자 소유다. 이 화면의 선택은 Agent Driver 내부의 Pack·Swarm 계획/판단과 Jev 보정용 LLM 호출에 적용된다.
- key를 삭제하면 이 런타임에서 저장된 키를 제거하고 해당 환경변수의 상속 사용도 중지한다. 공급자 측 키 폐기는 별도로 해야 한다.

## 저장과 보안

런타임 DB 디렉터리의 `.connection/models.json` 한 파일에 선택·진행 단계·키를 원자적으로 저장한다. 비밀은 API 응답·로그·모델 입력에 넣지 않는다. UI 입력칸은 비밀번호 타입이며 저장 후 지운다. 공백 입력은 기존 키 유지, 삭제는 별도 체크박스다. revision 검사로 오래 열린 창의 덮어쓰기를 거부한다.

POSIX 디렉터리 0700 / 파일 0600, 고정된 경로, symlink 거부, loopback bind, capability URL, 정확한 Host/Origin 및 별도 POST 헤더, CSP/no-store가 적용된다. MCP 등록 receipt에는 command fingerprint와 시각만 남기고 CLI 출력은 저장하지 않는다. 이것은 OS 비밀 저장소 암호화가 아니다. Windows는 사용자 프로필의 ACL 경계에 의존하며 이번 검증은 Linux/WSL이다. 로컬 URL도 다른 사람에게 공유하지 않는다.

비정상 종료 중 `.settings.lock` 또는 `.control-center.lock`이 남으면 안전하게 busy로 멈춘다. 해당 프로세스가 종료됐는지 확인하고 설치 에이전트가 그 파일만 복구해야 한다. 자동 lock 탈취나 임의 프로세스 종료는 하지 않는다.

## 검증 경계

실제 로컬 Chromium에서 1440/390 폭의 네 단계, MCP 등록, live tail, API 과금 확인, 키 마스킹, 클라이언트/API 왕복 전환, 재접속·단계 저장을 검사한다. Codex·Claude Code·OpenCode 등록 명령과 Cursor/Hermes 설정 보존은 격리된 fixture home에서 검증하며 사용자의 실제 클라이언트 설정을 테스트 중 바꾸지 않는다. 네 공급자의 요청/응답과 probe는 fixture 계약 테스트다. 실제 유료 공급자 호출과 OpenCode의 모든 공급자 조합을 성공으로 표시하지 않는다.
