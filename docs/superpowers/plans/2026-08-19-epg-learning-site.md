# EPG Learning Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline React website for learning and simulating the 33 EPG interview questions with simple spoken answers.

**Architecture:** Create an independent Vite + React app in `epg-learning/`. Keep question data, deterministic answer feedback, and browser persistence in small testable modules; compose them into study, interview, and progress views in the UI.

**Tech Stack:** React 18, Vite 6, Node built-in test runner, browser `localStorage`, CSS.

**Spec:** `docs/superpowers/specs/2026-08-19-epg-learning-site-design.md`

## Global Constraints

- Offline-only: no accounts, back end, analytics, or external API calls.
- Use the 33 questions, hooks, simple spoken answers, and three numerical targets from the supplied extreme-simple EPG document.
- Evaluation is transparent keyword coverage; never claim AI semantic grading.
- Persist learning state and interview history with safe `localStorage` fallbacks.
- Support narrow mobile and desktop screens.

---

### Task 1: Create testable learning data and domain logic

**Files:** Create `epg-learning/package.json`, `epg-learning/src/data/questions.js`, `epg-learning/src/lib/evaluation.js`, `epg-learning/src/lib/storage.js`, `epg-learning/test/evaluation.test.js`, and `epg-learning/test/storage.test.js`.

**Interfaces:** `QUESTIONS` holds `{ id, question, hook, answer, keywords }`; `evaluateAnswer(answer, keywords)` returns `{ covered, missing, score, total }`; storage exports `createDefaultProgress`, `loadProgress`, and `saveProgress`.

- [ ] Write a failing test asserting `evaluateAnswer('我们先试点，再收集反馈。', ['试点', '反馈', '推广'])` returns covered `['试点', '反馈']`, missing `['推广']`, score `2`, total `3`.
- [ ] Run `npm test --prefix epg-learning` and confirm the missing-module failure.
- [ ] Implement the smallest evaluator: normalize whitespace and case, use `includes` for each keyword, and return covered/missing arrays plus counts. Populate all 33 simple-answer records. Return an empty compatible progress object for unavailable, malformed, or incompatible stored data.
- [ ] Run `npm test --prefix epg-learning` and confirm evaluator, corrupt-data fallback, and storage round-trip tests pass.
- [ ] Commit only these domain files with message `feat: add EPG learning domain`.

### Task 2: Implement study, continuous interview, and progress UI

**Files:** Create `epg-learning/index.html`, `epg-learning/src/main.jsx`, `epg-learning/src/App.jsx`, `epg-learning/src/components/StudyView.jsx`, `epg-learning/src/components/InterviewView.jsx`, `epg-learning/src/components/ProgressView.jsx`, and `epg-learning/src/styles.css`; modify `epg-learning/package.json`.

**Interfaces:** UI consumes Task 1 exports. `StudyView`, `InterviewView`, and `ProgressView` receive `questions`, `progress`, and callbacks for state changes.

- [ ] Write a failing test that imports `feedbackForAnswer` and expects one missing keyword to produce `再补一个点：反馈`.
- [ ] Run `npm test --prefix epg-learning` and confirm it fails because the helper does not exist.
- [ ] Implement feedback: full coverage yields `说得不错，核心要点都提到了。`; zero coverage yields `可以这样说：` plus the concepts; partial coverage yields `再补一个点：` plus the first missing concept.
- [ ] Implement the learning screen with counter, previous/next/random controls, memory hook, reveal-answer action, and persistent `已掌握`/`待复习` buttons.
- [ ] Implement a shuffled continuous interview: reject blank responses, show coverage and simple answer, append each turn to an on-screen timeline, save it, and advance on `下一题` without clearing the timeline.
- [ ] Implement progress totals, recent practice date, review-question list, and confirmation before clearing records. Show a nonfatal warning if local storage cannot be used.
- [ ] Add responsive CSS: large Chinese type, clear contrast, and a single-column small-screen layout.
- [ ] Run `npm test --prefix epg-learning && npm run build --prefix epg-learning`; confirm all tests pass and Vite creates `dist/`.
- [ ] Commit the application with message `feat: add offline EPG learning site`.

### Task 3: Validate the complete delivery

**Files:** Create `epg-learning/README.md`; modify `epg-learning/test/evaluation.test.js`.

**Interfaces:** The README explains `npm run dev --prefix epg-learning`, production build, and local-only storage.

- [ ] Write a failing test expecting `QUESTIONS.length` to equal 33.
- [ ] Run `npm test --prefix epg-learning` and confirm it fails if the data is incomplete.
- [ ] Complete any missing records and create the usage/privacy README.
- [ ] Run `npm test --prefix epg-learning && npm run build --prefix epg-learning && npm run lint --prefix epg-learning` and confirm all pass.
- [ ] Manually verify: reveal answer; submit a partial answer; continue to next question; refresh and confirm progress/history persists; inspect narrow layout.
- [ ] Commit verification files with message `docs: add EPG learning site usage`.
