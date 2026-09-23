# Agent Driver Control Center

Control Center는 Agent Driver 로컬 MCP의 **통합 관제 및 연결 설정 화면**이다. 작업 현황·HTTP/SSE snapshot은 읽기 전용이며, 별도 **연결 및 설정**에서 사용자가 컴퓨터 연결·구독/API·Jev를 관리한다. 사이트 인증은 Task가 필요성을 발견했을 때만 **사이트 로그인 N개 필요**로 나타난다. 설정 변경은 엄격한 로컬 POST 경계 안에서만 허용하며 작업 제출·실행 승인 권한은 만들지 않는다. [통합 설정 안내](control-settings.md).

```bash
agent-driver dashboard --config /absolute/path/to/host.json
```

명령은 `127.0.0.1`에 서버를 열고 실행할 때마다 새로운 capability URL을 출력한다. 내부 서버 API는 운영 중 재시작을 위해 기존 48자리 capability token을 재사용할 수 있으나, 공개 CLI flag로 노출하지 않는다. 이 화면에서 확인할 수 있는 것은 다음과 같다.

- Swarm run과 각 logical worker
- 범용 Pack 실행
- 단일 runtime Task
- coding CLI session과 turn 상태
- MCP gateway의 실제 heartbeat
- 각 actor의 stage, executor, 짧은 활동, 정리된 현재 endpoint
- actor가 점유한 VNC 또는 owned-browser 화면의 저해상도 live preview
- 화면 없는 LLM/Jev·파일/API worker의 status surface
- 실제 최근 activity에 보고된 `LLM / JEV / CODE` 단계 점등
- 위 실행을 시간순으로 합친 공통 activity timeline

상태 카드에서 `active`는 최근 heartbeat나 활성 session을 실제로 관측했다는 뜻이다. `configured`는 설정은 있지만 현재 process를 확인하지 않았다는 뜻이며, `unobserved`는 확인 근거가 없다는 뜻이다. Browser/VM 설정이 존재해도 process probe가 없으면 `active`로 올리지 않는다.

## 활동 보고

Swarm worker는 기존 `runtime_swarm_activity`를 사용한다. Pack·Task·CLI 같은 일반 실행은 아래의 공통 도구를 사용한다.

```text
runtime_activity_report(owner_kind, owner_id, actor_id?, activity)
```

`activity`는 `started / navigating / observing / tool_call / checkpoint / waiting / completed` 중 하나와 500자 이하의 요약, 선택적인 HTTP(S) endpoint를 받는다. `decision_layer`는 실제로 그 단계를 수행한 경우에만 `llm / jev / code` 중 하나로 보고한다. `surface_id`는 host config가 미리 허용한 화면만 참조할 수 있다. endpoint의 userinfo·query·fragment·secret-like path는 저장 전에 제거한다. 보고 호출은 authority, approval, completion을 만들지 않는다.

## 화면 wall

상단에는 MCP·Browser/VM·CLI·Decision Plane의 최소 현황, 왼쪽에는 실행 큐와 선택한 활동 기록, 오른쪽에는 actor의 고밀도 화면 wall을 표시한다. 기본값 `LATEST + SELECTED`는 가장 최근 생성된 실행을 따라가며 해당 실행의 actor만 보여준다. 과거 실행을 누르면 자동 추적을 멈추고, `LATEST`를 누르면 다시 최신 실행을 따라간다. `ALL`은 현재 종류 필터에 해당하는 모든 실행을 wall에 펼친다. 녹화는 하지 않는다. Windows 화면 녹화 도구가 관제센터 창을 그대로 녹화하면 된다.

SSE가 갱신돼도 같은 actor의 타일과 이미지 요소를 유지한다. 프레임 요청은 타일당 하나만 진행하며, 새 이미지를 모두 받은 뒤 화면을 교체하므로 관제 데이터 갱신 때문에 영상이 깜빡이지 않는다. 서버도 같은 surface의 진행 중인 캡처 요청을 공유한다. 수신 실패는 `UNAVAILABLE`과 마지막 성공 프레임의 시각을 표시하고, worker lease 만료는 `LEASE EXPIRED`, 종료된 화면은 `CLOSED · 마지막 화면`으로 표시한다. 완료·만료된 worker를 계속 작업 중인 live 화면처럼 표시하지 않는다.

마지막 프레임은 열려 있는 관제 화면에 보관한 이미지다. 녹화·영구 스크린샷 저장이 아니며, 실행기 종료 뒤 관제 페이지를 새로 열면 종료 상태만 보이고 이전 프레임은 없을 수 있다.

`LLM / JEV / CODE`는 각 단계의 마지막 실제 activity 시각(`layer_activity_at`)부터 3초간 점등한다. 0.25초짜리 Jev 판단 직후 코드가 실행되어 한 번의 snapshot 사이에 두 단계가 지나가도 둘의 최근 기록이 남는다. 점등은 **최근 관측 이력**이며 동시에 실행 중이라는 뜻은 아니다. 툴팁에 관측 시각과 이 의미를 표시하고, 최신 `decision_layer`는 `•`로 별도 구분한다. executor 이름이나 작업 설명에서 모델 개입을 추정하지 않으며, 완료·lease 만료 시 점등을 멈춘다.

각 논리 agent가 언제나 VM 한 대를 가진다는 뜻은 아니다. Agent Driver의 logical worker는 제한된 executor를 빌려 쓸 수 있다. **독립 Page/브라우저/데스크톱을 실제로 점유한 actor는 독립 화면 타일**, 화면이 없는 planner·Jev 판단·파일/API worker는 독립 status 타일을 갖는다. persistent VM 모드도 worker별 CDP Page를 캡처하므로 화면은 분리되지만 profile과 VM은 공유한다. 같은 VNC 물리 화면의 복제본을 여러 독립 화면인 것처럼 표시하지 않는다. 관리형 executor는 `run_id + worker_id` 결속으로 자동 연결되며 private preview endpoint는 snapshot에 노출하지 않는다. 별도 [Website connections](browser-connections.md) 화면에서 인증을 진행하며 로그인 탭은 wall에 등록하지 않는다.

지원 surface는 다음과 같다.

- `vnc`: agent 전용 Linux/Windows guest 전체 화면. loopback RFB 3.8 + None security endpoint만 읽는다.
- `browser`: actor 전용 Chromium CDP endpoint의 단일 non-blank page. 여러 page가 있으면 임의 선택하지 않고 unavailable로 표시한다.
- `terminal`: coding CLI session의 상태/활동 텍스트 타일.
- `status`: LLM/Jev, file, API, synthesis처럼 영상이 없는 worker 타일.

VNC/CDP를 사용할 때 host config에 허용 화면을 명시한다. 임의 원격 주소는 받지 않는다.

```json
{
  "observability": {
    "frame_interval_ms": 1000,
    "surfaces": [
      {"id": "vm-a", "label": "Ubuntu worker A", "kind": "vnc", "port": 5901},
      {"id": "browser-b", "label": "Headless browser B", "kind": "browser", "endpoint": "http://127.0.0.1:9223"}
    ]
  }
}
```

정적 화면은 actor가 `runtime_activity_report` 또는 `runtime_swarm_activity`에서 허용된 `surface_id`를 보고하면 해당 타일에 frame이 붙는다. 관리형 worker browser는 executor의 프로젝트 범위 surface registry를 사용하며 별도 host config 수정이 필요 없다. 관리형 browser의 preview는 executor가 소유한 loopback 서버에서 가져온다. preview는 GET-only이고 마우스·키보드 입력이나 승인 권한을 제공하지 않는다.

## 관측 경계

Control Center는 같은 project DB를 쓰며 **Agent Driver MCP/tool을 거친 작업만** 안다. Hermes, Codex, Claude 또는 다른 앱이 Agent Driver 밖에서 직접 실행한 브라우징·sub-agent·파일 작업은 자동으로 감시하지 않는다. 그런 작업까지 표시하려면 상위 runtime이 Agent Driver run에 결속해 활동을 보고해야 한다.

원문 DOM, prompt 전문, 비밀번호, cookie, token, 모델 내부 추론은 표시하지 않는다. 영상 preview에는 agent 전용 화면에 실제 표시된 내용이 포함될 수 있으므로 전용 profile/VM만 등록해야 한다. HTTP surface는 capability URL 아래의 GET snapshot/SSE/frame만 제공하며 실행·승인·취소 endpoint가 없다.
