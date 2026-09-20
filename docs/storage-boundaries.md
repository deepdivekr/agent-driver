# 저장 예산과 증거 보존

Phase22의 저장 경계는 **애플리케이션의 새 작업 접수·발송 제한**이다. 파일시스템 hard quota나 전용 VM 디스크가 아니며, 다른 프로그램 또는 CLI 자체 캐시가 디스크를 채우는 것을 막지는 않는다. CPU/메모리/PID 경계와도 별개다.

## 신뢰된 host 설정

기존 host JSON에 선택적으로 추가한다. 설정하지 않으면 `unconfigured`, 관측은 `unobserved`이며 저장 제한을 검증했다고 표시하지 않는다.

```json
{
  "storage": {
    "max_bytes": 268435456,
    "min_free_bytes": 268435456,
    "journal_margin_bytes": 8388608,
    "segment_bytes": 262144,
    "retention_days": 30,
    "cleanup_enabled": false
  }
}
```

- `max_bytes`: 설정된 runtime data directory의 논리 크기와 할당 크기 중 큰 값에 대한 합산 예산. sparse file은 논리 크기도 계산하고, 같은 inode는 한 번만 센다. symlink 목적지는 따라가지 않는다.
- `min_free_bytes`: 새 효과 전에 남겨야 할 파일시스템 여유 공간. 작업 파일이 별도 볼륨에 있으면 그 볼륨도 별도로 확인한다.
- `journal_margin_bytes`: intent/상태 기록을 위한 보수적 여유분. 타 프로세스가 소비할 수 있으므로 실제 예약 블록이나 ENOSPC 방지 보장은 아니다.
- `segment_bytes`: 정규화 로그 파일의 목표 분할 크기. 한 프레임은 자르지 않으므로 큰 프레임 하나는 목표보다 커질 수 있다. 기존 프레임·세션 총량 상한은 유지한다.
- `retention_days`: 마지막 작업 활동과 자료 생성 후 최소 보존 기간. wall clock 기준이며 잘못된 시스템 시각을 보안 시계로 보장하지 않는다. 시간 경과만으로 자동 삭제하지 않는다.
- `cleanup_enabled`: 기본 false. true일 때만 검토한 정리 계획을 명시적으로 실행할 수 있다. 모델 입력으로 바꾸지 못한다.

첫 예약에서 설정 해시와 data directory inode를 DB에 결속한다. 이후 경로 교체·예산 변경을 자동 수용하지 않는다. 실행 중 예산 상향이나 새 경로로 옮기는 관리용 migration은 아직 제공하지 않으므로, 검증되지 않은 수동 DB 수정을 복구 방법으로 안내하지 않는다.

## 실행·공간 부족 계약

SQLite v6에 소유 프로세스의 boot/start identity가 있는 저장 예약을 추가했다. 여러 gateway/host가 같은 DB를 쓰면 예약 검사를 transaction으로 직렬화한다. API 접수, CLI 발송, 브라우저 실행/저장 직전, 파일 쓰기, 인계와 검증 snapshot에서 재검사한다. 이미 쓰인 데이터와 예약이 일시적으로 중복 계산될 수 있으며 허용보다 보수적으로 차단하는 쪽이다.

`STORAGE_BUDGET_EXCEEDED`, `STORAGE_LOW_SPACE`, 실제 `ENOSPC`/SQLite FULL은 성공이 아니다. 새로운 효과는 차단하고 기존 intent·불명확 상태를 보존한다. 공간 부족으로 상태 갱신까지 실패하면 이전 intent가 남으며 자동 재전송하지 않는다. 조회와 종료 요청에 새 작업 admission을 적용하지 않지만, 물리적으로 가득 찬 DB가 취소 기록을 쓸 수 있다는 보장은 없다. 실제 시험에서는 FULL 상태의 DB 재오픈·읽기를 확인했다.

`runtime_storage_recover_reservations`는 확실히 죽은 boot/start identity의 예약만 해제한다. 살아 있거나 관측 불가인 owner는 보존한다. 예약 해제는 외부 효과의 취소·성공 또는 작업 재실행이 아니다.

## 분할 로그와 정리

global byte offset, 프레임 hash, 세션/generation, 페이지 revision은 파일 분할 후에도 유지한다. 파일 fsync가 DB offset 기록보다 앞선다. 중간 쓰기·초과 tail·변조를 발견하면 gap으로 중단하며, 자동 truncate나 덮어쓰기로 성공 기록을 만들지 않는다. v5 단일 로그는 v6의 첫 segment로 읽되 과거에 소유권을 등록하지 않은 파일을 삭제 대상으로 소급 등록하지 않는다.

정리 표면은 공통 CLI의 `call --config HOST_JSON --tool TOOL --request-file REQUEST_JSON`과 stdio MCP에서 같다. 요청 파일에는 아래 인수 객체를 넣는다.

1. `runtime_storage_status {}`: 실제 관측, 예약량, 적용 범위와 차단 이유.
2. `runtime_storage_plan {}`: 삭제 후보와 보호 이유. 경로를 인수로 받지 않는다.
3. `runtime_storage_prune {"plan_sha256":"계획에서 받은 값"}`: host 정책·동일 계획·소유권·세대·현재 상태를 다시 검사하고 실행한다. 해시는 권한이 아니다.
4. 중단 후에는 새 계획을 조회한다. `pruning` 자료는 기록된 삭제 의도에 한해서 이어서 처리한다. 같은 옛 계획을 무조건 재전송하지 않는다.

등록된 **정규화 spool과 인계 사본만** 후보가 된다. 종료가 확인된 세션이어야 하며 진행/재개 예약, 미확인 프로세스, 불확실 턴·파일 효과, 미관측 tool result, 미완료 verifier는 보호한다. 전체 파일 hash·inode·단일 hardlink·부모 inode를 확인한다. 계획과 실행 사이 변경도 거절한다.

삭제 의도를 DB에 먼저 확정한 후, 같은 private directory의 `.prune-<artifact-id>`로 옮기고 재검사한 뒤 삭제한다. 중단 지점은 journal/rename/unlink로 구분한다. 옮겨진 파일이 달라졌으면 **삭제하지 않고 격리 위치에 보존**하며 `STORAGE_ARTIFACT_CHANGED`로 중단한다. 이 경우 사용자 검토가 필요하고 자동 원위치 덮어쓰기는 하지 않는다. 모든 동작은 동일 runtime DB에 참여하는 writer 간 직렬화이며, 같은 UID로 private directory를 악의적으로 동시에 조작하는 공격자에 대한 OS 보안 경계는 아니다.

출력 조회는 `retention_pruning`과 `retention_expired`를 이유 없는 파일 누락·변조와 구분한다. 삭제된 출력의 내용을 검증했다고 주장하지 않는다. 일부 사본이라도 삭제 의도가 생긴 세션은 재개를 차단한다. DB의 세션/turn/intent/hash/event와 기존 평가 증거는 삭제하지 않는다.

보호 대상: 사용자 worktree, Chrome/profile/auth, 다른 서비스 파일, DB/WAL와 이벤트, 검증 snapshot, 실패 staging, legacy 미등록 파일, 알 수 없는 파일. 자동 vacuum·재귀 디렉터리 삭제도 하지 않는다. 따라서 이것만으로 무기한 운영이 가능하다고 보장하지 않는다. 후보는 한 번에 최대200개, bounded scan은10000개이며 보호 항목은 이유별로 관측한다. 상한 초과는 별도 정리가 필요하다는 오류이지 미관측 데이터를 버릴 권한이 아니다.

## 증거와 남은 출시 조건

실제 파일·동시 프로세스 예약, owner SIGKILL, private32MiB tmpfs의 ENOSPC/SQLite FULL, 부분 spool 쓰기와 재접수 차단, 삭제 세 지점의 실제 SIGKILL을 시험한다. 보존 시간·CLI 세션 상태는 합성 fixture로 조절하며 실제 장기 보존 또는 실제 CLI 성공으로 혼동하지 않는다. 별도의 opt-in actual CLI 시험은 저장/자원 예산을 적용한 실제 broker·검증·재개 경로를 확인한다.

Windows quota/JobObject, 모든 CLI cache·gateway·browser profile의 OS 디스크/I/O 상한, snapshot/staging의 소유권 기반 회수, 장기 soak, 재부팅/전원 상실, 백업·복원·설정 migration은 여전히 출시 gate다. `health=ready`가 이 범위의 검증 완료라는 뜻은 아니다.
