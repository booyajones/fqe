# Recipe: Node web app (Next.js / React / Vue / Svelte)

Complete `.fqe.yml` for a Node-based web app. Gates on: unit tests, type-check, ESLint, Playwright smoke, Lighthouse perf budget.

## Prerequisites

- `package.json` with `test`, `typecheck`, `lint` scripts.
- Playwright installed (`npm i -D @playwright/test`).
- Lighthouse CI installed (`npm i -D @lhci/cli`).
- A `.lighthouserc.json` with your perf budgets.

## `.fqe.yml`

```yaml
# Node web-app gate. Catches: failing tests, type errors, lint violations,
# broken UI smoke flows, perf regressions below budget.

runners:
  unit-tests:
    command: "npm"
    args: ["test", "--", "--ci", "--reporters=default"]
    when: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "package.json"]
    required: true
    timeout_ms: 300000   # 5 min

  typecheck:
    command: "npm"
    args: ["run", "typecheck"]
    when: ["**/*.ts", "**/*.tsx", "tsconfig.json", "package.json"]
    required: true

  lint:
    command: "npm"
    args: ["run", "lint", "--", "--quiet"]
    when: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", ".eslintrc*", "package.json"]
    required: true

  playwright-smoke:
    command: "npx"
    args: ["playwright", "test", "--project=smoke", "--reporter=line"]
    when: ["**/*.tsx", "**/*.jsx", "**/*.html", "**/*.css", "pages/**", "app/**", "components/**"]
    required: false   # smoke is informational in v1; flip to required once stable
    timeout_ms: 600000

  lighthouse:
    command: "npx"
    args: ["@lhci/cli", "autorun", "--config=.lighthouserc.json"]
    when: ["pages/**", "app/**", "components/**", ".lighthouserc.json"]
    required: false
    timeout_ms: 600000
```

## Notes

- **`unit-tests` requires Node test script to exit non-zero on failures.** Most Jest / Vitest configurations do this by default.
- **`playwright-smoke` is `required: false` in v1.** Browser tests are the flakiest part of any CI pipeline. Start informational, watch the FLAG rate for a sprint, then promote to `required: true` once it's stable on your team's PRs.
- **`lighthouse` needs `.lighthouserc.json` budgets.** A minimum example:
  ```json
  {
    "ci": {
      "collect": { "url": ["http://localhost:3000/"] },
      "assert": {
        "assertions": {
          "categories:performance": ["warn", { "minScore": 0.85 }],
          "categories:accessibility": ["error", { "minScore": 0.95 }]
        }
      }
    }
  }
  ```

## Common adjustments

- **Monorepo:** scope each runner to its package via `when`. Example: `when: ["packages/web/**"]` for a web-only runner.
- **Storybook visual regression:** add a Chromatic or Argos runner with `required: false` initially.
- **Bundle size budget:** add a `size-limit` runner with `required: true` once you have a baseline.
