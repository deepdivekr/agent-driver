# Jev 활용 범위와 이번 추가 기능

2026-09-28 · Phase 75 · **Windows 개발 후보판**

기존 브라우저 판단·Swarm 분배·검증된 사례 메모리에 더해, 수집 결과의 근거 확인과 인계 자료 선별을 연결했다. Pack family를 늘리거나 새로운 Work별 Jev ON/OFF 정책을 만들지는 않았다. 원본 WSL 작업본과 설치본에는 아직 반영하지 않았다.

## 12가지 사례와 실제 코드 비교

| 사례 | 현재 범위 | 이번 결정 / 주요 코드 |
|---|---|---|
| 1. 브라우저 다음 행동 | 기존 지원: 관측된 상태·행동·대상·값을 제한된 후보에서 선택 | 유지. `src/taskpack/adaptive-decision.ts`; 선택과 실행·완료 확인은 별개 |
| 2. 맥락 압축 | 기존 필수 인계 계약 + **관련 참조 선별 추가** | `src/work/reference-selection.ts`. 이미 기록된 발췌문만 선택하며 재작성하지 않음. 전체 대화/이벤트 압축은 아님 |
| 3. 스킬·맥락 로딩 | Pack 경로 선택과 참조 지도는 있음. 외부 런타임 전체 스킬 자동 로더는 없음 | 이번 참조 선별로 일부만 보강. Hermes 등의 자체 스킬 선택을 중복 구현하지 않음 |
| 4. 타입이 있는 도구 호출 | 기존 후보 경로·입력값 판단, 스키마·원문 위치 검증 | 유지. `src/taskpack/typesafe-jev.ts`, `src/interface/intake.ts`. 임의 함수 실행 권한을 주지 않음 |
| 5. 인용 검증 | **추가**: 인용구 존재 여부 + 원문이 주장을 뒷받침하는지 분리 | `src/packs/evidence.ts`, `citation.support` |
| 6. 추출값 검증 | **추가**: 값이 원문에 나온다는 사실과 해당 필드의 값이라는 의미를 분리 | `extraction.support`. 일반 문서 추출기를 새로 만들지는 않음 |
| 7. 실행 이력 평가 | 기존 정체/방해 판단, Swarm 품질·진행 판단, 이벤트 감사 | `src/swarm/decision.ts`, `src/decision-plane/operations.ts`. 임의 외부 에이전트 전체 이력을 자동 평가하는 기능은 없음 |
| 8. 의미 기반 회귀 검사 | **추가**: 라벨된 의미 판단을 동일 경로로 재생 | `src/decision-plane/regression.ts`. 기존 calibration·shadow 체계를 유지하고 자동 승격하지 않음 |
| 9. 의미 기반 코드 검색 | 제한된 코드베이스 스캔·참조 조회는 있음 | 새 선별은 기록된 스캔 발췌문에만 적용. 저장소 전체를 검색하는 Jevgrep은 미구현 |
| 10. 엔티티 정렬 | 기존 정확한 키 기반 중복 제거 | 의미가 비슷한 고객·계정 등을 자동 병합하지 않음. 도메인별 정답과 잘못된 병합의 복구 기준이 먼저 필요 |
| 11. 검색 결과 재정렬 | 기존 검색 관련성 판단 + **인계 참조의 관련성 선택 추가** | `src/packs/judgment.ts`, `context.relevance`. 임베딩 검색 또는 모든 결과의 정밀 순위 모델은 아님 |
| 12. 메모리 승격 | 기존 검증된 판단 사례 메모리 | `src/decision-plane/memory.ts`, `src/swarm/learning.ts`. 독립 결과 확인 후 재사용하며, 자유 서술 교훈이나 AGENTS.md를 자동 수정하지 않음 |

## 1. 수집 결과의 근거 확인

`research.search`, `portal.collect`, `file.pipeline`의 선택적 `verification`에 연결했다. 최초 Pack 설계 지침은 실제 자료에 원문·인용·주장 또는 추출값이 있을 때만 이 항목을 제안하도록 안내한다. 일반 복사·검색·다운로드에 추가 호출을 강제하지 않는다.

기존에 등록된 source가 다음 열을 제공한다고 가정한 **recipe의 일부**:

```json
{
  "verification": [
    {
      "id": "claim_support",
      "kind": "citation",
      "source_field": "source_text",
      "claim_field": "claim",
      "quote_field": "quote"
    },
    {
      "id": "exit_oxygen",
      "kind": "extraction",
      "source_field": "source_text",
      "value_field": "oxygen",
      "quote_field": "oxygen_quote",
      "meaning": "해당 시각의 배출구 산소 농도, 단위 %"
    }
  ]
}
```

- 코드가 결측·형식·인용구의 정확한 존재 여부를 먼저 검사한다. 없는 원문이나 인용구를 모델이 만들어 넣지 않는다.
- 의미가 필요한 부분만 Jev의 `SUPPORTED / UNSUPPORTED / CONTRADICTED / UNKNOWN` 판단으로 보낸다. 예: 숫자 `8.2`가 있어도 그것이 입구 값이면 배출구 값으로 인정하지 않는다.
- 저신뢰·잘못된 응답·shadow 불일치는 설정된 LLM으로 한 번 보정한다. LLM도 해당 원문에 실제 있는 인용구와 허용된 답을 반환해야 한다. 이 검사는 인용구의 존재를 보증할 뿐, LLM 답의 정답 보증은 아니다.
- 판단을 확인할 수 없으면 `needs_review`다. 원본 행은 지우거나 고치지 않는다. 파일 수집 경로는 미확인 원본도 보존하며 검증 결과를 별도 반환하므로, 파일 생성 성공과 내용 검증 성공은 다르다.
- `literal_copy`는 코드의 문자열 일치 확인 전용이다. `semantic_verified`를 참으로 만들지 않는다.
- 실행 중 Work revision 또는 호스트 설정이 바뀌면 이전 판단으로 내보내지 않는다. Work revision 변경은 `needs_replan`으로 남기며 같은 요청을 다시 보내도 묵은 결과를 실행하지 않는다.

한 recipe당 검사 정의 최대 4개, 행×검사 최대 200개, 의미 판단 batch 최대 12개다. batch마다 Jev 요청 최대 1회, 미해결 항목의 LLM 보정 최대 1회다. 원문은 항목당 16,000자까지이며 초과하면 자르지 않고 검토 대상으로 남긴다. 실제 비용·속도는 입력량과 fallback 빈도에 따라 달라진다.

판정 범위는 **제공받은 원문 스냅샷**이다. URL 원본의 진위·최신성, 웹 전체 사실 확인, 정부 보고의 법적 적합성까지 검증하지 않는다. 일반 정규식 형태의 비밀정보가 감지된 항목은 모델로 보내지 않고 `REDACTION_REQUIRED`로 남긴다. 이것은 완전한 개인정보 탐지기가 아니다.

## 2. 인계할 참조만 원문 그대로 선택

연결된 에이전트가 다음처럼 MCP를 호출할 수 있다. 식별자는 실제 Work의 값을 사용한다.

```json
{
  "work_id": "실제-work-id",
  "actor": "successor",
  "selection": {
    "focus": "다운로드 결과 검증을 이어가기 위해 필요한 코드와 절차",
    "max_references": 3,
    "max_bytes": 4000
  }
}
```

이는 `runtime_work_context`의 입력이다. 기록된 가져오기/코드 스캔 참조 최대 100개 중 코드가 최대 24개를 먼저 추리고, Jev 또는 설정된 LLM이 `KEEP / SKIP / UNKNOWN`을 고른다. 발췌문은 기존 비밀정보 제거·길이 제한 이후의 텍스트를 그대로 전달한다. 선택 한도는 최대 5개·텍스트 8,000바이트다. 이 한도는 전체 인계 응답 크기 한도가 아니다.

완료 조건, 현재 사용자 지침, 승인 경계, 불확실한 실행 결과는 선택 대상이 아니며 항상 필수 계약에 남는다. 판단 중 Work·설정·참조가 바뀌면 응답을 폐기한다. 상세 판단은 모델 판단 journal에 연결하고 인계 응답에는 선택 ID·개수·byte·event ID 등 짧은 요약만 추가한다.

`selection`을 생략하면 기존 동작이다. `reference_ids`를 직접 지정하면 모델을 호출하지 않는다. 두 방식을 동시에 지정할 수 없다. 이것은 전체 대화 압축이나 자동 코딩 인계의 전면 교체가 아니라, 호출자가 선택할 수 있는 참조 선별 도구다. 기존 코딩 인계의 필수 계약은 유지한다. 절약한 토큰 수와 인계 성공률은 측정 전까지 `unobserved`다.

## 3. 의미 판단 회귀 검사

`replaySemanticCases`는 라벨된 입력을 위와 같은 `semanticBatch` 경로에 재생한다. 정상적인 형식으로 높은 confidence를 반환했어도 정답과 다르면 실패한다. 제공자 미연결·장애는 `BLOCKED_ENV`, 잘못된 응답은 실패로 구분한다. 데이터·catalog hash, event ID, confidence, 선택 확률을 남기며 calibration 파일을 바꾸지 않는다.

현재 포함한 10개 라벨 사례는 인용의 부정·모순·불충분함, 다른 항목에서 가져온 숫자, 한국어 시각, 관련/무관한 맥락, 원문 속 지시문이다. 테스트에서는 합성 제공자를 쓰므로 **실제 Jev의 정확도·지연 측정이 아니다**. 새 테스트 파일은 기존 quick test 탐색에 포함된다. 별도 상주 평가 서비스나 유료 자동 호출은 추가하지 않았다.

## 설정과 비용

- 판단 지점은 Pack 계약이 정한다. 신규 Work 설계 단계에 별도의 Jev 사용 계획을 추가하지 않는다.
- 기존 전역 Jev OFF, 명시적 Work OFF, 가져오기 비용 동의, `model_data_approved`를 존중한다.
- Jev가 없거나 OFF여도 설정된 LLM으로 의미 판단을 수행할 수 있다. 모델 전체가 OFF면 의미 검증 성공을 가장하지 않는다.
- 사용자가 저장한 LLM/클라이언트 선택과 기존 라우팅을 재사용한다. 구독 한도 소진을 유료 API로 바꾸지 않는다.
- `pack.semantic` catalog는 공통 Decision Plane 상태·journal·profile registry·shadow 설정을 사용한다. 새 판단의 기본 threshold는 provisional이며 도메인 calibration을 마쳤다는 뜻이 아니다.
- 이 변경으로 새 수집 이력을 자유 서술 장기기억에 자동 승격하지 않는다. 검증된 기존 Swarm 사례 메모리의 범위를 넓혔다고 주장하지 않는다.

## 참고한 1차 자료

- [TypeSafe 인용 검증 cookbook](https://docs.typesafe.ai/cookbooks/citation_check): 코드의 인용구 일치 검사와 문맥의 의미 판단 분리.
- [TypeSafe state](https://docs.typesafe.ai/concepts/state), [Choice](https://docs.typesafe.ai/primitives/choice), [confidence](https://docs.typesafe.ai/confidence): 질문에 정확한 state 항목을 명시하고 확률·confidence·정답을 구분.
- [Beacon](https://github.com/Asymptote-Labs/agent-beacon), [cross-harness memory](https://github.com/Asymptote-Labs/agent-beacon/blob/main/docs/concepts/cross-harness-memory.mdx), [memory CLI](https://github.com/Asymptote-Labs/agent-beacon/blob/main/docs/cli/memory.mdx): 세션 포착과 학습 후보 평가·검토·승격을 분리하는 참고 구조. 이번에는 기존 검증 메모리를 유지했다. Beacon 설치, 세션 업로드, 자동 스킬 수정은 하지 않았다.

외부 코드를 복사한 것이 아니라 기존 TypeSafe SDK·Decision Plane 위에서 구현했다. 검증 결과와 남은 환경 제약은 [Phase 75 인계](handoff/phase-75.md)에 기록한다.
