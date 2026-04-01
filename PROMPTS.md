# PROMPTS

This file documents representative prompts used during the AI-assisted development of this project. The wording below is a normalized, professional version of the actual prompts used during implementation, debugging, deployment, and submission packaging.

## Project framing

- `Interpret the Cloudflare AI application assignment and translate it into a concrete product and technical scope.`

- `Recommend a project concept that is both impressive and realistic to build quickly, with a preference for Cloudflare-native primitives and Workers AI.`

## Product and architecture

- `Build a stateful incident-response copilot on Cloudflare using realtime chat, persistent shared state, and an LLM-backed workflow.`

- `Use Cloudflare Agents and Durable Objects to maintain a live incident board that stays synchronized across tabs and refreshes.`

- `Design the application so the user can describe symptoms, mitigations, and follow-up actions in plain language while the system updates structured incident state.`

## Implementation refinement

- `Ensure the agent performs real tool execution rather than rendering pseudo tool-call JSON in the chat transcript.`

- `Improve the interface so it feels like a polished product rather than a starter template.`

- `Simplify the header by removing unnecessary severity and status badges while keeping the underlying incident state intact.`

## Deployment and testing

- `Deploy the application to Cloudflare immediately so the full experience can be tested in a live environment.`

- `Provide a practical validation flow to confirm that shared state, persistence, reset behavior, and postmortem generation all work correctly.`

## Repository and submission packaging

- `Publish the project to GitHub so it can be attached to the application submission.`

- `Use a repository name that follows the required cf_ai_ prefix convention.`

- `Create a concise README with project documentation, a deployed link, and clear instructions for trying the application locally or via the live deployment.`

- `Add a screenshot from the local machine to the repository and reference it from the README.`

- `Move the selected screenshot into the repository instead of copying it from Downloads.`

## Submission compliance

- `Update the repository so it complies with the application requirements, including the required README and PROMPTS.md documentation.`

- `Rewrite the prompts documentation so it reads as professional project documentation while still accurately reflecting the AI-assisted build process.`
