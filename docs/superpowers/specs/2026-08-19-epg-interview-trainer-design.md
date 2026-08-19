# EPG Interview Trainer Design

## Goal

Build a standalone local website for learning the fixed EPG interview question bank, practising typed answers, and receiving LLM-based feedback without exposing the model API key to the browser.

## Scope

- Preload the 33 EPG questions with a memory prompt, short answer, reference answer, and scoring points.
- Offer a study mode with reveal/hide controls for memory prompts, short answers, and reference answers.
- Offer a practice mode that selects one question at a time, accepts typed input, and evaluates it.
- Persist learning status, attempts, and weak questions in browser localStorage.
- Use a local Node HTTP server as a same-origin API proxy for `/api/evaluate`.
- Read `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` only from `.env`; never return them in an API response or bundle them into client code.

## Non-goals

- No voice input, speech recognition, user accounts, cloud synchronization, or remote deployment.
- No storage of answers or keys outside the local machine.

## Architecture

The standalone app lives in `interview-trainer/`. A Vite React client renders study and practice workflows; a small Node server serves the built client and exposes the evaluation API. The client sends only a question id and the learner's response. The server loads the corresponding reference material from its local question-bank module, asks the configured OpenAI-compatible model for strict JSON feedback, validates the result, and returns normalized feedback.

```text
Browser UI -> POST /api/evaluate {questionId, answer}
           -> local Node server -> OpenAI-compatible chat completions endpoint
           <- normalized score and coaching JSON
```

## Data model

`Question`:

```js
{
  id: 'epg-01',
  question: '您在过程改进中的角色和责任是什么？',
  memoryCue: '角色｜工作｜目的',
  shortAnswer: '我是EPG组长，负责改进过程，支撑业务目标。',
  referenceAnswer: '我是EPG组长，主要负责组织和推动公司过程改进……',
  keyPoints: ['EPG组长', '过程改进', '业务目标']
}
```

`Attempt` (stored in localStorage):

```js
{
  questionId: 'epg-01',
  score: 78,
  answer: '……',
  createdAt: 'ISO date string'
}
```

## Evaluation contract

`POST /api/evaluate` requires a non-empty `questionId` and a 10–3000 character answer. It returns:

```js
{
  score: 0,
  coverage: 0,
  clarity: 0,
  matchedPoints: ['…'],
  missingPoints: ['…'],
  feedback: '…',
  improvedAnswer: '…'
}
```

The server requests JSON only from the LLM and validates all fields. If the upstream is unavailable or returns invalid data, the server returns a clear 502 response; the client preserves the typed answer and tells the user to retry. A missing local configuration returns a 503 response explaining which variable is needed, without leaking values.

## UI behavior

- **学习卡**: list of questions; selecting one shows the question first. Buttons reveal the cue, short answer, and full reference answer independently. “已掌握 / 继续练习” update local status.
- **模拟答题**: displays one random question, a text area, and a submit button. After evaluation, show score, matched/missing points, coaching, and an improved answer.
- **错题复习**: filters questions with a last score below 80 or manually marked “继续练习.”
- **Progress**: shows total answered, mastered count, and average score from local attempts.

## Visual design

Use an understated study interface: a left navigation rail, a clear question card, and focused typography. Accent colors distinguish memory cues, score status, and corrective feedback. The app must remain usable at 360px wide.

## Testing

- Node tests cover question bank integrity, evaluation-request validation, response normalization, and local scoring data helpers.
- A production build is required before completion.

## Configuration

Provide `.env.example` with placeholders only:

```dotenv
LLM_BASE_URL=http://localhost:3000
LLM_API_KEY=replace-with-your-key
LLM_MODEL=replace-with-supported-model-name
PORT=8787
```

The actual `.env` is gitignored. The user must rotate the credential previously shared in chat and place the replacement in `interview-trainer/.env`.
