# Agent Driver alpha.15 출시 준비 상태

이 문서는 alpha.15 당시의 기록이다. 현재 라이선스와 검증 상태는 [alpha.18 기록](release-readiness-alpha-18.md)을 따른다.

## 판정

`0.1.0-alpha.15`는 **Jev Decision Plane이 연결된 공개 평가용 alpha 후보**다. GA 또는 무감독 운영 인증이 아니다.

## 통과한 gate

- adaptive browser, Pack family, Telegram/intake가 공통 catalog/profile/journal 계약을 사용한다.
- 판단별 exact label, train/holdout 누수 차단, Wilson 하한, shadow 비교, content-addressed profile, operator-only promote/rollback을 구현했다.
- MCP는 집계 상태만 읽고 profile 승격·승인 권한을 갖지 않는다.
- 실제 TypeSafe provider 106회에서 latency와 1개 오답을 포함한 원본 evidence를 보존했다.
- 작은 fixture holdout은 관측 precision이 100%여도 목표 precision 0.90의 95% Wilson 하한을 넘지 못해 전부 shadow-only다.
- external write는 Decision Plane과 별도로 task-bound single-use human approval 및 독립 readback을 계속 요구한다.

## 아직 통과하지 않은 gate

- production profile 0개: 새 catalog/model에 결속된 `user_environment` train/holdout 라벨이 부족하다.
- Windows native UIA executor와 장시간 foreground 비간섭은 미인증이다.
- arbitrary-site 자동 adaptation과 실계정 coverage는 제한적이다.
- 공개 라이선스가 없어 source-visible evaluation 범위다.
- 실제 Telegram 왕복은 노출된 과거 bot token 폐기와 새 Hermes gateway 자격 증명이 필요하다.

## 출시 표현

허용: “빠른 typed judgment를 durable execution/approval/recovery control plane에 결합한 experimental public alpha.”

금지: “Jev가 모든 사이트에서 100% 정확하다”, “production calibrated”, “Windows 전체 앱을 무간섭 제어한다”, “사람 승인 없이 제출·구매한다.”

## production calibration 재개 조건

각 catalog 판단별로 실제 사용자 환경의 독립 라벨을 모으고, 잠긴 holdout에서 목표 precision의 95% Wilson 하한을 넘긴 head만 운영자가 production으로 승격한다. 질문 문구, candidate 의미, 모델 또는 catalog hash가 바뀌면 다시 보정한다.
