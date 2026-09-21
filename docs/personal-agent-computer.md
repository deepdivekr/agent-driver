# 개인 상주 Agent Computer

## 기본값

`agent-driver`의 기본 실행 환경은 task마다 새 guest를 만드는 sandbox가 아니라, 한 명의 사용자가 소유하는 **persistent Agent Computer 한 대**다. guest 안의 브라우저 profile, 앱 상태, 로그인 세션은 같은 사용자의 후속 task가 재사용한다.

```text
개인 Agent Computer (persistent VM)
  ├─ guest 브라우저 profile·로그인·파일·앱 상태
  ├─ task A lease ─┐
  ├─ task B lease ─┼─ 같은 computer resource, interactive control은 직렬
  └─ task C lease ─┘

사용자 host desktop
  └─ 공유·attach·foreground 제어하지 않음
```

task는 VM을 새로 만들지 않고 `personal-agent-computer:<id>` resource에 lease를 잡는다. 기존 `RuntimeStore`의 durable `lease` fence가 같은 display/profile의 동시 조작을 막는다. 따라서 개인 VM의 상태는 넓게 재사용하지만, 두 task가 같은 브라우저나 desktop 창을 동시에 조작할 수는 없다.

## 앱은 어디에 있는가

VM은 두 번째 컴퓨터다. host의 Chrome, Windows 앱, 창, clipboard, 저장된 로그인 정보를 자동으로 공유하지 않는다. 앱을 agent가 쓰게 하려면 **그 VM 안에 설치·로그인**되어 있어야 한다.

- 현재 Ubuntu Agent Computer: 실제 구현·검증된 surface는 `browser`뿐이다.
- CLI surface: 별도 guest terminal executor가 연결된 경우에만 advertise한다.
- Windows native desktop surface: Windows guest와 UI Automation executor가 연결된 경우에만 advertise한다. Phase30은 안전한 guest/UIA **계약**까지 구현했으며, 실제 Windows guest agent는 아직 없으므로 현재 surface로 advertise하지 않는다.
- host 파일: shared folder가 아니라 명시적인 import/export bridge로만 전달한다. 현재 bridge 자체도 구현 전이다.

## 격리 VM은 예외

낯선 다운로드, 악성 사이트, 다른 계정/회사 trust zone, 또는 snapshot rollback이 필요한 대량 task는 별도의 ephemeral VM을 사용한다. 개인 기본 VM을 매 task마다 재생성하지 않는다.

## TypeSafe/Jev 경계

Jev는 자연어 task를 어떤 Pack/route로 보낼지처럼 의미 판단에만 쓴다. VM ID, 앱 surface, task lease, UI control, file bridge는 모델 선택이 아니라 결정론적 policy와 durable lease가 소유한다.

## Task Pack 연결

승인형 browser Task Pack에 Personal Agent Computer를 명시해 전달하면, 기존 `browser:<profile>:<account>` lease 대신 `personal-agent-computer:<id>` lease를 획득한다. 그래서 같은 VM 안의 persistent browser profile과 이후 앱 surface를 한 task만 조작한다. descriptor가 없으면 이전 project browser-resource 경로를 그대로 사용한다.

Task Pack은 Jev에게 자연어를 code-defined route/field 후보로 고르게만 한다. VM 선택, lease, 로그인 상태, UI control click은 Jev의 권한이 아니다.
