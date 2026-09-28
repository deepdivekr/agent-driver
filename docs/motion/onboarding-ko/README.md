# 첫 실행 모션그래픽 (한국어)

[`docs/assets/motion/onboarding-ko.mp4`](../../assets/motion/onboarding-ko.mp4)의 원본입니다.
1080×1350, 48초 루프입니다. 설치 한 줄부터 첫 업무 접수까지 6개 샷으로 보여줍니다.

| # | 샷 | 보여주는 것 |
|---|---|---|
| 1 | 설치 한 줄 | 에이전트에게 설치 요청 → `install.sh` 출력 → `control_center_ready` |
| 2 | 에이전트 연결 | Claude Code에 MCP 등록, 배지가 `MCP 등록됨`으로 바뀜 |
| 3 | 로컬 실행 | 로컬 실행 승인, 내 화면은 그대로 두고 전용 Chromium만 준비 |
| 4 | AI 연결 · Jev | 구독 연결, 유료 API 자동 전환 없음, Jev는 선택사항으로 끔 |
| 5 | 첫 업무 접수 | 한 줄 요청 → 업무 접수 → AI가 Pack family(`research.search`) 선택 |
| 6 | 업무 상세 | 완료 조건과 계획 3단계, 연결된 에이전트가 이어받아 01 단계 시작 |

화면 문구는 v0.3.1 관제센터와 설치기의 실제 한국어 문구를 따릅니다.
업무 내용과 ID는 예시입니다.

## 다시 만들기

[Storyboarding 스킬](https://github.com/deepdivekr/Storyboarding-skill)의 kit으로 그립니다.
`build.py`는 스킬의 검사와 player를 그대로 쓰고, 한글 글리프용으로 저장소의
Pretendard(`assets/fonts`) 부분 집합을 추가합니다.

```bash
pip install playwright fonttools brotli   # ffmpeg도 필요합니다
python build.py --skill ~/.claude/skills/storyboarding
python ~/.claude/skills/storyboarding/scripts/render.py out/onboarding-ko.html --keyframes out/frames
python ~/.claude/skills/storyboarding/scripts/render.py out/onboarding-ko.html --mp4 out/onboarding-ko.mp4
```

문구·타이밍은 `storyboard.json`, 그리는 코드는 `scene.js`에서 고칩니다.
