# Contributing to Agent Tool Call Tracer

Thank you for your interest in improving `agent-tool-call-tracer`!

## Development Requirements

- [Bun](https://bun.sh) (>= 1.3.0)
- Git

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/martin-winkler-dev/agent-tool-call-tracer.git
   cd agent-tool-call-tracer
   ```
2. Install dependencies:
   ```bash
   bun install
   ```

## Development Commands

- **Run all checks** (linting, typechecking, tests):
  ```bash
  bun run check
  ```
- **Run tests with coverage**:
  ```bash
  bun run coverage
  ```
- **Run linter**:
  ```bash
  bun run lint
  ```
- **Format code automatically**:
  ```bash
  bun run lint:fix
  ```
- **Typecheck**:
  ```bash
  bun run typecheck
  ```

## Testing & Code Quality Standards

- Maintain code coverage above 90% (enforced by `bunfig.toml`).
- Follow strict TypeScript 7 and Biome configurations.
- Ensure all hooks remain non-blocking, fail-safe (exit code 0 on errors), and never emit unexpected stdout.
