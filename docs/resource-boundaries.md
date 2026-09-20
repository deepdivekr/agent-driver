# Workload 자원 경계 — Linux 실험적 지원

에이전트가 실행하는 browser/CLI/검증기의 하위 프로세스까지 합산하여 CPU·메모리·PID 예산을 적용한다. 프로세스별 prlimit만으로 하위 프로세스 전체의 자원을 제한했다고 보지 않는다. 사용자 화면 비간섭·디스크/I/O 격리·동일 UID 공격자 방어·VM 보안과는 별도 계약이다.

## 설정

기존 host JSON에 신뢰된 사용자가 다음 블록을 추가한다. MCP 요청이나 모델 출력에서는 예산을 만들거나 올릴 수 없다.

```json
{
  "resources": {
    "domain": "my-agent-runtime",
    "cpu_percent": 100,
    "memory_mb": 1024,
    "tasks_max": 256
  }
}
```

예시는 한 CPU 코어의 100% 시간과 총1GiB, 커널 task256개 상한이다. task는 thread도 포함한다. 동일 OS 사용자의 같은 domain은 프로젝트/CLI/검증기가 달라도 **하나의 합산 예산**을 공유한다. 같은 domain에 다른 설정을 자동 적용하지 않고 거절한다. 예산 변경은 소유 작업의 안전한 종료·불명확 효과 확인 이후 새 host 설정/실행으로 진행해야 한다. 제한을 실시간으로 완화하거나 다른 domain으로 우회 재실행하는 API는 없다.

`memory_high_mb`는 선택 사항이며 기본은 memory_mb의80%(정수MiB)다. high를 넘으면 reclaim/throttling이 발생하며, max에서 회수가 불가능하면 OOM이 발생한다. OOM과 timeout·느려짐은 서로 다르다. swap 상한은0, CPU weight는10, quota period는100ms다. 이 제어는 일반 fair-class 작업에 대한 것이며 hard real-time 보장이 아니다.

예산이 없는 기존 구성은 `runtime_health.resource_boundary.status=unconfigured`, `verified=false`다. 예산이 설정돼도 아직 실행 그룹이 없거나 제한이 바뀌면 unavailable_or_changed이며 사용량은 unobserved다. health 조회는 그룹을 생성하지 않는다. enforced 관측은 특정 실행 domain의 커널 설정에 대한 것이며 제품 전체 verified_for_environment를 true로 만들지 않는다.

## 실행과 소유권

Linux cgroupv2와 동작 중인 사용자 systemd manager가 필요하다. Node·bubblewrap 외에 systemd255에서 실제 동작을 검증한다. 루트 데몬/전역 보안 완화/다른 사용자 프로세스 이동은 하지 않는다. 사용자 bus와 kernel controller가 없으면 요청된 자원 경계는 실패하며 무제한 실행으로 폴백하지 않는다.

- domain 이름에서 제품 전용 transient slice를 도출한다. description/config hash, user 경로, transient 상태, 실제 cgroup filesystem·inode 및 cpu.max/memory.high/memory.max/memory.swap.max/pids.max/cpu.weight를 확인한다.
- 각 실행은 고유 transient **service**다. 단순 scope는 메인 프로세스 사망과 모든 자손 회수를 결속하지 않으므로 사용하지 않는다. KillMode=control-group, OOMPolicy=kill, ExitType=main, stop deadline2초를 적용한다.
- trusted bootstrap이 커널 소속, 실제 서비스 MainPID/정책, memory.oom.group=1을 읽은 뒤 대상 프로그램을 실행한다. 실행 중 제한·group inode·소속이 달라지면 종료한다.
- supervisor 아래 worker/Chromium, terminal host 아래 CLI/MCP broker는 커널 membership을 상속한다. 재연결 시 살아 있는 host도 membership을 재확인한다. 브라우저 쓰기·CLI 입력·파일 쓰기 직전에 한 번 더 검사한다.
- 독립 verifier는 같은 aggregate domain 안에서 별도 실행 단위를 사용한다. namespace의 home/net/desktop 차단·RO snapshot은 유지한다. 호출자 사망은 PID 숫자만이 아니라 boot/start identity로 감지하며 서비스 자손 전체를 회수한다. 유한한 OS runtime 상한도 적용한다.
- controller/gateway는 취소·조회와 복구 기록 접근을 위해 이 workload domain 밖에 있다. gateway까지 합산한 전체 설치 자원 예산은 아직 보장하지 않는다.

새 작업이 없는 빈 slice는 domain 메타데이터로 남고, 종료된 실행 서비스는 collect된다. 제품은 살아 있는 모든 domain을 일괄 stop하거나 사용자 전체 slice를 정리하지 않는다. 실제 native 시험은 자기 UUID domain이 비어 있음을 확인한 후에만 시험 그룹을 회수한다.

## 관측·실패·검증 범위

관측은 현재/peak 메모리·task수·cpu.stat·memory.events·pids.events·cgroup.events다. 없는 counter는 unobserved이며0으로 채우지 않는다. 커널 버전과 pids_localevents 설정에 따라 PID 거절은 제한을 둔 ancestor 또는 fork한 leaf의 pids.events에 기록될 수 있으므로 두 위치를 함께 확인한다. CI에서도 실제 EAGAIN과 시작 수 제한, ancestor/leaf 중 관측된 커널 거절 증가를 함께 요구한다. 일반 pids.current==0 또는 exit0만으로 업무 완료를 판정하지 않는다.

서비스의 resource kill은 기존 durable intent/CLI state 규칙으로 처리한다. 이미 발송된 파일/외부 쓰기는 취소된 것으로 꾸미거나 다른 실행기로 재발송하지 않는다. 독립 verifier는 실제 프로그램 출력/exit와 resource 관측을 함께 기록하며 제한 종료를 성공으로 처리하지 않는다.

시험은 제한 readback 후 **유한한** 작업만 실행한다. 두 동시 실행의 합산 CPU throttling, 유한 PID 생성 거절, throttle와 hard OOM 분리, 설정 불일치/실행 중 변경, 메인 SIGKILL·caller 사망·자손 회수, 별도 sentinel 유지, 실제 Chromium 저장·합성 CLI 계약·격리 verifier를 검사한다. 실제 Claude 검증은 별도 opt-in private 실행이며 공개 CI의 합성 CLI가 이를 대신하지 않는다.

남은 조건: native Windows Job Objects/ACL/ConPTY·foreground 이벤트, 디스크/로그/스냅샷 예산·ENOSPC/rotation, I/O bandwidth, caller gateway/설치 전체 예산, 자원 경쟁 중 장시간 UI 반응성·soak, guest/VM·악성 same-UID/커널/DoS 경계. 현재 범위를 “사용자에게 절대 영향0”이라고 광고하지 않는다.

## 근거

- [Linux cgroupv2 공식 문서](https://docs.kernel.org/admin-guide/cgroup-v2.html): CPU bandwidth, memory high/max/oom group와 PID controller.
- 설치된 systemd255의 systemd-run(1), systemd.resource-control(5), systemd.service(5): transient 실행·자원 속성·ExitType·OOMPolicy와 그룹 종료. 최신 문서 내용을 설치 버전 지원으로 자동 간주하지 않고 실제 property와 kernel readback으로 확인한다.
- 공개 개발 추적: [자원 경계 #14](https://github.com/deepdivekr/agent-driver/issues/14), 전체 [출시 gate #6](https://github.com/deepdivekr/agent-driver/issues/6).
