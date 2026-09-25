# 첫 실행: 설치 확인과 MCP 연결

Agent Driver의 설치 경험은 사용자가 Pack, registry, GitHub 경로, MCP 설정 파일을 이해하도록 요구하지 않는다. 사용자는 설치를 담당하는 에이전트에게 다음처럼 한 번만 말하면 된다.

> Agent Driver를 설치하고, 앞으로 컴퓨터·브라우저 작업은 Agent Driver로 해줘.

설치 에이전트가 Agent Driver를 설치하고 `agent-driver connect`를 실행하면 Agent Driver의 로컬 온보딩이 열린다. 첫 화면은 설치 성공을 확인하고 Codex·Claude Code·OpenCode·Cursor·Hermes 중 사용할 클라이언트의 설치·로그인·MCP 등록을 안내한다. 연결 뒤에는 같은 화면의 업무 현황에서 단계별 진척·중단 이유·인계 기록을 확인한다. Hermes를 연결한 경우 Telegram 대화·장기 기억·계획은 Hermes가, 외부 효과·lease·승인·검증은 Agent Driver가 맡는다.

직접 설치할 때는 Ubuntu/WSL 터미널에서 다음 한 줄을 실행한다.

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/deepdivekr/agent-driver/v0.2.0/install.sh | bash'
```

bootstrap은 홈 디렉터리 안에 고정 Node/npm 런타임과 저장소를 준비하고, 의존성·빌드·Chromium·절대경로 launcher를 설치한 다음 `agent-driver connect`를 실행한다. 기존 비관리 경로, symlink, 수정된 checkout은 덮어쓰지 않는다. 관제센터 주소가 터미널에 표시되고, 브라우저를 열 수 있는 환경에서는 화면도 자동으로 열린다. 이후 관제센터에서 client 설치·인증·MCP 등록·모델 설정을 이어간다.

사용자가 직접 보는 절차는 다음과 같다.

1. 설치를 지시한다.
2. `agent-driver connect`가 표시한 로컬 화면에서 사용할 클라이언트를 선택한다. 없으면 **설치**, 설치됐지만 로그아웃 상태면 **로그인**, 준비됐으면 **MCP 등록** 순서로 같은 카드가 바뀐다.
3. **로컬 실행 승인** 뒤 AI 연결과 선택적 Jev를 설정한다. Telegram을 쓸 때는 Hermes가 안내하는 bot 연결에서 token과 허용 사용자만 한 번 입력한다.

## 연결 화면

연결 화면은 관제센터의 **연결 및 설정**이다. **에이전트 → 로컬 실행 → AI → Jev**를 한 화면씩 설정한다. 화면 하단의 **연결 작업 기록**은 이 화면에서 실행한 설치·등록·연결의 시작과 결과를 보여준다. 터미널 출력이나 업무 실행 로그가 아니다. 실제 업무 진행 기록은 **업무 현황 → 업무 상세**에서 본다. 키와 CLI 원문 출력은 기록하지 않는다. 사이트 로그인은 온보딩에 포함하지 않는다. Task가 인증이 필요한 URL을 실제로 만났을 때 해당 worker를 멈추고 관제센터에 사이트별 로그인 요청을 표시한다. `connect`는 서버를 별도 프로세스로 유지하고 기존 연결을 재사용하며, MCP 재접속은 창을 다시 열지 않는다. [세부 동작과 지원 범위](control-settings.md).

현재 제공되는 승인 선택지는 **방해하지 않는 모드** 하나다. 사용자 desktop, 탭, foreground, clipboard는 공유하거나 제어하지 않고, 지속형 전용 Agent Computer의 browser surface만 사용한다.

- **방해하지 않는 모드**: 현재 사용 가능하며 기본값이다.
- **에이전트 전용 데스크톱**: Windows guest/UIA가 실구현되기 전까지 준비 중으로 표시한다.
- **공유 화면 허용**: 제공하지 않는다. 사용자 desktop 제어는 제품 권한 범위 밖이다.

클라이언트 설치와 MCP 등록은 사용자가 각각의 버튼을 누른 뒤에만 실행한다. Linux/WSL 설치 버튼은 allowlist에 고정된 공식 HTTPS 설치 원본만 내려받고, redirect·2 MiB 초과·shell script가 아닌 응답을 거부한다. 임시 파일은 실행 후 삭제하고 raw installer 출력은 화면·journal에 보존하지 않는다. 이 검사는 원격 설치 프로그램의 내용 자체를 보증하거나 checksum을 고정하는 것은 아니다. 원격 프로그램 실행을 원하지 않으면 함께 표시되는 공식 설치 안내를 따라 수동 설치한다.

설치 뒤 Codex·Claude Code·Hermes는 지원되는 공식 CLI 로그인 흐름을 관제센터에서 시작한다. 기기 코드가 있으면 인증 URL과 코드만 표시하고 token·credential store는 읽지 않는다. OpenCode와 Cursor CLI처럼 bounded login 계약을 제공하지 않는 경로는 공식 로그인 안내를 연다. 실제 MCP 등록에는 절대 경로의 Node와 Agent Driver CLI를 사용하므로 이후 작업 디렉터리에 의존하지 않는다. Codex·Claude Code·OpenCode는 공식 CLI 등록 명령, Cursor는 사용자 설정의 `mcpServers`, Hermes는 기존 YAML의 `mcp_servers.agent-driver`만 갱신한다. 같은 이름의 다른 설정이 있으면 덮어쓰지 않고 검토 필요로 멈춘다.

로컬 실행 승인 뒤에는 사용자 홈의 `~/.agent-driver`(또는 `AGENT_DRIVER_CONNECTION_ROOT`)에 private connection state와 MCP용 runtime config가 생성된다. 실행 명령은 항상 `agent-driver mcp`다. Hermes 상태 확인은 `agent-driver hermes doctor`다. 로그인, 전용 브라우저 VM 준비, Jev 연결은 해당 작업이 실제로 요구할 때만 안내한다. 자세한 권한 경계는 [Hermes + Telegram runtime](hermes-telegram-runtime.md)을 따른다.

## 상태의 의미

`MCP 등록됨`은 클라이언트 설정에 stdio 시작 명령이 저장됐다는 뜻이다. 이미 실행 중인 클라이언트는 재시작이나 MCP 새로고침이 필요할 수 있고, 실제 gateway 연결·Telegram task 성공과는 다르다. `Hermes: 기본 Agent runtime`은 대화와 계획의 소유자를 뜻한다. `Browser`는 첫 브라우저 작업에서 전용 환경을 준비하며 host Chrome을 대신 사용하지 않는다. `Jev: 선택사항`은 API key를 설치 시점에 요구하지 않는다는 뜻이다.
