
# Stayblz Development Instructions

## Project Overview
Stayblz is a horse management web application.

Frontend:
- React, Vite, TypeScript
- Hosted on Vercel
- GitHub: romswel/stayblz-frontend

Backend:
- Node.js, Express, TypeScript
- Hosted on Render
- GitHub: romswel/stayblz-backend

Database:
- Supabase PostgreSQL
- Backend uses SUPABASE_URL and SUPABASE_SECRET_KEY
- Never expose server-side secrets in frontend code

## Current Architecture
Frontend communicates with the backend through:
VITE_API_URL=https://stayblz-backend.onrender.com

Backend API base:
https://stayblz-backend.onrender.com/api

Existing database-backed features:
- Horse Inventory
- Horse Tracking
- Activity Feed
- Conversations and message history

Some remaining features still use mock data.
Inspect the existing code before changing functionality.

## Development Rules
1. Preserve the existing design and working features.
2. Inspect relevant files before editing.
3. Prefer small, focused changes over large refactors.
4. Reuse existing components, services, and API contracts.
5. Keep frontend and backend changes synchronized.
6. Do not expose credentials, tokens, or secret keys.
7. Do not delete or overwrite database records without approval.
8. Do not modify database schemas without approval.
9. Do not invent completed features or test results.
10. Do not automatically commit, push, merge, or deploy.

## Security
- Existing demo authentication is not production-ready.
- In-memory sessions are not suitable for production.
- Proper authentication and authorization are required.
- Never expose Supabase privileged keys to the browser.
- Do not use real customer data until security is verified.
- Do not enable real-money betting functionality.

## Git Workflow
Frontend and backend are separate Git repositories.

Frontend main branch deploys to Vercel.
Backend main branch deploys to Render.

For each task:
1. Identify which repository needs changes.
2. Explain the planned changes briefly.
3. Implement only the requested task.
4. Run relevant tests and TypeScript checks.
5. Report changed files and validation results.
6. Wait for approval before committing or pushing.

## Validation
Frontend:
- npm run build
- Run available lint and tests when applicable

Backend:
- npm run build
- Run available tests when applicable

Do not claim tests passed unless they were executed.

## Codex Efficiency
The user has limited Codex usage.

- Avoid unnecessary repository-wide searches.
- Read only files relevant to the task.
- Avoid repeated explanations and large reports.
- Do not perform unrelated cleanup.
- Prefer completing one feature at a time.
- Report blockers clearly.
- Keep responses concise and straightforward.

## Response Format
After completing a task, provide:

Changes:
- Short list of implemented changes

Validation:
- Tests/builds executed and their results

Remaining:
- Any unfinished work or manual steps

Git:
- Whether changes are uncommitted, committed, or pushed
