# 첫 실행: 내 컴퓨터 연결

Agent Driver의 설치 경험은 사용자가 Pack, registry, GitHub 경로, MCP 설정 파일을 이해하도록 요구하지 않는다. 사용자는 설치를 담당하는 에이전트에게 다음처럼 한 번만 말하면 된다.

> Agent Driver를 설치하고, 앞으로 컴퓨터·브라우저 작업은 Agent Driver로 해줘.

설치 에이전트는 런타임을 설치하고, 자신이 사용하는 MCP 클라이언트에 공통 stdio 명령 `agent-driver mcp`를 등록한다. MCP 표준은 각 클라이언트가 자신의 연결 설정을 보유하므로 그 등록 자체는 클라이언트가 수행하지만, Agent Driver 쪽에는 vendor별 adapter나 registry가 없다. Codex에서는 한 번의 등록 뒤 데스크톱 앱·CLI·IDE 확장이 같은 MCP 구성을 공유한다. [OpenAI MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?translationFallback=ko-KR)

사용자가 직접 보는 절차는 두 단계뿐이다.

1. 설치를 지시한다.
2. `agent-driver connect`가 연 loopback 로컬 화면에서 **이 컴퓨터 연결**을 승인한다.

## 연결 화면

현재 제공되는 승인 선택지는 **방해하지 않는 모드** 하나다. 사용자 desktop, 탭, foreground, clipboard는 공유하거나 제어하지 않고, 지속형 전용 Agent Computer의 browser surface만 사용한다.

- **방해하지 않는 모드**: 현재 사용 가능하며 기본값이다.
- **에이전트 전용 데스크톱**: Windows guest/UIA가 실구현되기 전까지 준비 중으로 표시한다.
- **공유 화면 허용**: 제공하지 않는다. 사용자 desktop 제어는 제품 권한 범위 밖이다.

승인 뒤에는 사용자 홈의 `~/.agent-driver`(또는 `AGENT_DRIVER_CONNECTION_ROOT`)에 private connection state와 MCP용 runtime config가 생성된다. 실행 명령은 항상 `agent-driver mcp`다. 로그인, 전용 브라우저 VM 준비, Jev 연결은 해당 작업이 실제로 요구할 때만 안내한다.

## 상태의 의미

`MCP 명령 준비됨`은 Codex·Claude 등 클라이언트가 공통 stdio 명령을 등록할 준비가 됐다는 뜻이지, 특정 클라이언트가 이미 연결됐다는 뜻은 아니다. `Browser`는 첫 브라우저 작업에서 전용 환경을 준비하며, host Chrome을 대신 사용하지 않는다. `Jev: 선택사항`은 API key를 설치 시점에 요구하지 않는다는 뜻이다.
