# WSL 응답 불능과 Windows 메모리 진단 — 2026-09-28

사용자 요청: 처음부터 WSL이 왜 과부하 상태가 되었는지 설명. 이 조사에서는 프로세스 종료,
서비스 재시작, 설정 변경, 테스트 부하를 실행하지 않았다. 최초 원인은 아직 확정되지 않았다.

## 복구 이력에서 확인한 사실

- Phase 71에서 이미 `Wsl/Service/E_UNEXPECTED`와 `/bin/true` 지연이 기록됐다.
- Phase 72의 Ubuntu 전용 종료 후에는 일반 사용자 명령과 Node 22.22.0이 한 번 정상 실행됐다.
- 이후 전체 quick 회귀 중 임시 테스트 경로가 사라졌고, 실행 중 프로세스가 잡고 있던
  로그를 `/proc/727/fd/1`에서 보존했다. systemd-tmpfiles도 관측됐지만 원인으로 확정하지 않았다.
- 기존 파일이 없던 `.wslconfig`에 `memory=8GB`를 저장했다. 이후 `wsl --shutdown`과
  시작 확인 명령이 끝나지 않았다. 실제 게스트 상한 적용은 미확인이다.
- 당시 서비스 정지는 접근 거부(exit 5)였다. 마지막 Phase 72 표본에서도 Windows 여유 RAM은
  약 2.9GiB, vmmemWSL working set은 약 800MiB였다. 즉 이후의 지속적 응답 불능을
  현재의 높은 WSL 메모리 사용만으로 설명할 수는 없다.

근거: `docs/handoff/phase-71.md`, `docs/handoff/phase-72-candidate-limitations.md`,
`C:/Users/<user>/AppData/Local/Temp/agent-driver-phase72-recovery.md`.

## 이번 읽기 전용 표본

2026-09-28 08:03 KST 부근, Windows CIM 및 프로세스 조회:

| 측정 | 값 |
|---|---:|
| 물리 RAM 총량 / 여유 | 31.51 / 0.94 GiB |
| 시스템 commit / commit 한도 | 51.55 / 74.88 GiB |
| 페이지 파일 사용량 / 부팅 후 최대 | 5,218 / 12,879 MiB |
| 가장 큰 Codex renderer(PID 62940) working set | 13,315~13,352 MiB |
| 같은 renderer의 private memory | 13,909~13,945 MiB |
| vmmemWSL(PID 43656) working set / private memory | 약 369 / 1,197 MiB |

큰 프로세스는 `ChatGPT.exe`라는 이름이지만 실행 경로는
`OpenAI.Codex_26.915.4065.0_x64` 앱의 `ChatGPT.exe`이며 `--type=renderer`다.
이 프로세스는 9월 22일 15:16 KST부터 실행 중이다. 사용자 대화, 창, 탭 중 어느 것이
이 프로세스의 메모리를 차지하는지는 확인하지 않았다. 앱 메모리 누수도 확정하지 않았다.
프로세스 그룹 working set을 합하면 공유 페이지를 중복 계산할 수 있으므로 정확한 전용 RAM
총량으로 제시하지 않는다. 시스템 commit은 실제 RAM 점유량과 다르다.

최근 5일 System 로그의 Resource-Exhaustion-Detector 2004 이벤트는 조회되지 않았다.
같은 기간 Application 1000/1001/1002 최근 300건에서도 WSL 관련 일치 기록은 없었다.
이 결과는 Linux 내부 OOM이나 WSL의 다른 장애가 없었다는 증거가 아니다. 내부 로그와
실패 시점의 메모리 추이가 없으므로 최초 원인을 특정할 수 없다.

## 판단과 다음 검증

- 확인됨: 현재 Windows 메모리 여유가 적고, 가장 큰 관측 소비자는 Codex UI renderer다.
- 확인됨: WSL 명령 응답 불능은 이번 Windows 워크플로 구현 이전부터 있었다.
- 가능성: 전체 PC 자원 압박이 지연에 기여했을 수 있다. 현재 표본만으로 과거 장애 인과를
  역으로 증명할 수 없으며, WSL 내부 고장/종료 정체가 별도로 남아 있을 수 있다.
- 수정: WSL 상한 설정만으로 근본 해결했다고 설명해서는 안 된다. 게스트 재시작 및 실제
  상한 확인도 필요하다.
- 후속 조치에는 사용자 승인과 작업 보존이 필요하다. Codex 장기 실행 상태를 보존한 뒤
  앱 재시작 전후 메모리를 비교하고, 이후에도 WSL이 응답하지 않으면 서비스 복구 및
  Linux 내부 kernel/OOM/서비스/임시 경로 로그를 확인한다. 이번에는 실행하지 않았다.

Microsoft 문서는 `.wslconfig`가 WSL VM 시작 시 적용되며 완전한 종료/재시작이 필요하다고
설명한다: https://learn.microsoft.com/en-us/windows/wsl/wsl-config
OpenAI 공식 문제 해결 문서는 실행 중 작업이 끝난 뒤 앱을 재시작하는 일반 복구 절차를
안내하지만, 이번 renderer 점유의 원인이나 메모리 누수를 입증하지 않는다:
https://learn.chatgpt.com/docs/reference/troubleshooting
