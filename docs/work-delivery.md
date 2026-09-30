# Work delivery

Results always remain in Work details with their recorded sources and downloadable files. A messenger is optional.

## Setup and use

1. Open **Connections & settings → Delivery** (also the final connection-onboarding step).
2. Add a named Telegram destination with a bot token and chat ID, or Slack/Discord with its incoming webhook URL. Save it and optionally select default destinations.
3. When starting a Work, enter instructions, a completion condition and one or more result destinations. A blank condition lets AI derive checks; material missing information becomes a clarification question. One-line requests remain supported.
4. Once the new Work's outcome passes independent verification, Office dispatches its result to the selected destinations. Each receipt appears in the final delivery stage and result card.
5. Click the final stage to change destinations. A genuinely unsent current result can use the new destination; already delivered or uncertain sends are not replayed. Future outputs use the saved choice.

The app remains available even when unselected. Changing global defaults does not retarget existing Works. Imported bots keep their original runtime, schedule and sender; Office does not duplicate those deliveries.

## What is sent

- Telegram sends short result text as a message; long result text as `result.txt`.
- Discord sends short result text as a message with mentions disabled; long text as `result.txt`.
- Slack sends result text through the webhook within the supported length budget.
- Original generated files are downloadable in Work details, not automatically uploaded to these messengers.

A saved result can be a draft. Automatic messenger delivery requires a succeeded run with independently verified completion, not merely a file write or finished tool call. Delivery failures do not erase the saved output or falsely mark it delivered.

## Status and safety

**Saved · delivery unverified** means configuration has been stored, not that a test message was sent. Office makes no test send during setup. Provider acknowledgement proves acceptance by that service, not that a person read the message.

Credentials are stored in a private local file next to runtime state and are not returned to the settings page, model prompt, logs or public release. Only official webhook hosts and paths are accepted. Saving recipient or credential changes invalidates the binding of an older pending send; Office does not silently send it to the changed recipient.

Pending sends use durable claims and bounded calls. Confirmed failures can be reviewed and retried; unknown network outcomes or interrupted sends require reconciliation instead of automatic replay. Pause and disconnect prevent new dispatch but cannot retract a request already sent. Restart recovery only handles eligible pending sends, not uncertain ones.

Email, native OAuth setup and automatic upload of all generated files are not implemented by this delivery layer. Local contract and HTTP tests replace provider responses; they are not certification of live Telegram, Slack or Discord accounts.

## 한국어 요약

**연결 및 설정 → 결과 수신**에서 Telegram 봇·대화 ID 또는 Slack·Discord 웹훅을 저장합니다. 신규 업무에서 여러 수신처를 선택하면 완료조건 검증 후 결과 본문을 보냅니다. 긴 본문은 Telegram·Discord에서 텍스트 파일로 전달하며, 별도 생성한 원본 파일은 업무 상세에서 다운로드합니다.

마지막 발송 단계를 눌러 아직 발송하지 않은 결과와 이후 수신처를 바꿀 수 있습니다. 이미 발송했거나 발송 여부가 불확실한 결과는 다시 보내지 않습니다. 앱의 결과는 항상 남으며, 가져온 봇은 기존 발송 경로를 유지합니다. ‘저장됨’은 실제 연결·발송 검증을 뜻하지 않습니다.
