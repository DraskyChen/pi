# Pi Local Web GUI Design

## Purpose

Pi will provide a local, single-user Web GUI launched with `pi web`. The Web GUI shares Pi's agent runtime, persisted sessions, settings, credentials, models, tools, extensions, skills, prompts, and project trust decisions with the TUI. It targets behavioral parity rather than terminal-component reuse.

The desktop experience uses a three-column workbench: session navigation on the left, the active conversation in the center, and contextual tool, session-tree, statistics, or settings details on the right. Narrow layouts may move side panels into drawers, but mobile coding workflows are not a release target.

## Product Boundaries

- The host is local-only and single-user. It does not support LAN exposure, remote workspaces, or multi-tenancy.
- The host listens on `127.0.0.1`, chooses an available port by default, and supports an explicit `--port` override.
- `pi web` opens the browser unless `--no-open` is supplied.
- Each launch creates an ephemeral bearer token. HTTP assets and WebSocket upgrades require the token, and the host accepts only its own Origin.
- Persistent sessions have one cross-process writer. TUI, RPC, and Web must acquire the same session lock; a conflict is reported and is never resolved by stealing the lock or cloning automatically.
- Project file browsing is restricted to the active session cwd. Real-path validation must reject parent traversal and symbolic-link escape.
- Browser uploads become message attachments and do not write into the project unless a separate explicit operation does so.
- Phase 2 reads the existing Pi credential store. Provider login, logout, and OAuth UI arrive in Phase 3.

## Architecture

`packages/web` owns the React, Vite, and TypeScript browser application. `packages/coding-agent` owns the privileged local host and a shared application service used by TUI, RPC, and Web. `packages/protocol`, `packages/client`, and `packages/server` remain runtime-neutral and contain only validated wire DTOs, client state, and transport/server infrastructure.

The runtime flow is:

1. `pi web` creates the same cwd-bound runtime services used by the TUI.
2. The local host serves the compiled Web application and an authenticated WebSocket endpoint.
3. The browser uses `PiClient` over a WebSocket `ByteTransport`.
4. `PiServer` delegates commands to the coding-agent application service.
5. The application service controls `AgentSessionRuntime`, `SessionManager`, and the existing tools.

TUI, RPC, and Web adapters do not implement command semantics independently. The existing RPC dispatch behavior is moved behind the shared service, while RPC remains a JSON-lines transport adapter.

Session and server snapshots are authoritative. Incremental events improve rendering latency but do not independently mutate durable state. Refresh and reconnect reacquire the session and replace browser state with a complete snapshot.

## Public Interfaces

Protocol version 2 intentionally replaces experimental version 1 without compatibility support. It retains create, list, attach, detach, prompt, steer, abort, model selection, and thinking-level selection, and adds validated command/result/event types for:

- follow-up input and queue policy;
- compaction, retry, and cancellation;
- bash execution and cancellation;
- session naming, statistics, fork, clone, tree, import, and export;
- settings, project trust, resource reload, authentication state, and available commands;
- image and file attachments plus cwd-scoped file enumeration;
- structured extension UI requests and responses.

Wire data must be serializable and schema-validated. Functions and TUI `Component` values never cross the protocol. Web-compatible extension UI includes select, confirm, input, editor, notifications, status text, and text widgets. An extension that requests a terminal-only component without a Web renderer receives an explicit unsupported-capability diagnostic.

## Delivery Priorities

### Phase 1: Infrastructure

- Introduce the shared application service and adapt RPC without changing its observable behavior.
- Upgrade the protocol to version 2 and add the first required command families.
- Add authenticated WebSocket client/server transports.
- Add the local HTTP/WebSocket host and `pi web` command.
- Add cross-process persistent-session locking.
- Verify protocol framing, authentication, Origin validation, path containment, payload limits, and locking.

### Phase 2: Daily Use

- Implement the three-column workbench and responsive drawers.
- Support session creation and resumption, authoritative snapshots, reconnect, and lock errors.
- Render streaming Markdown, code, images, thinking blocks, and tool lifecycle cards.
- Support prompt, steer, follow-up queues, abort, model selection, and thinking level.
- Add cwd-scoped file selection and drag-and-drop attachments.
- Diagnose missing credentials with exact TUI login guidance.

Phase 2 is complete when the Web GUI can replace the TUI for routine coding sessions using existing credentials.

### Phase 3: Built-in Parity

- Add bash execution, cancellation, and the command palette.
- Add every applicable built-in slash-command behavior, including session tree, fork, clone, import, export, statistics, compaction, and retry.
- Add settings, trust, reload, copy, themes, and keyboard shortcuts.
- Add provider login, logout, and OAuth.

Phase 3 is complete when all non-terminal-specific built-in behavior has a native Web entry point or equivalent Web interaction.

### Phase 4: Extension and Experience Parity

- Implement structured extension dialogs, editor requests, notifications, status, and text widgets.
- Detect and diagnose terminal-only extension UI.
- Complete desktop browser compatibility, accessibility, transcript virtualization, and shared TUI/RPC/Web contract regression coverage.

Phase 4 is complete when Web reaches the defined behavioral-parity standard.

## Error Handling and Security

- Disconnected clients cannot submit commands. Reconnect is explicit and reconciles against an authoritative snapshot.
- Conflicting commands fail rather than queue implicitly unless the selected queue mode defines queueing.
- Authentication, Origin, frame-size, attachment-size, and path violations return sanitized structured errors and never include rejected payload contents.
- Host errors are logged locally; browser errors contain actionable but non-sensitive messages.
- Stale session locks may be recovered only using a process-aware stale-lock policy. Live locks are never overridden.
- Existing project-trust checks remain authoritative for high-risk tools.

## Verification and Acceptance

- Shared application-service contract tests prove equivalent TUI, RPC, and Web adapter state transitions.
- Protocol tests cover every DTO, fragmentation/coalescing, invalid ordering, version mismatch, reconnect snapshots, and size limits.
- Security tests cover absent or invalid tokens, invalid Origins, non-loopback binding, traversal, symbolic-link escape, and oversized attachments.
- Lock tests cover multiple tabs, multiple processes, normal disposal, conflict diagnostics, and stale recovery.
- Frontend tests cover streaming updates, tool lifecycle, queues, abort, disconnect, refresh, locks, and error states.
- Browser end-to-end coverage targets current Chrome, Edge, Firefox, and Safari desktop releases.
- Modified test files are run directly during development. Each completed code batch ends with `npm run check`; the full test or build commands are not run unless explicitly requested.

## Explicit Non-Goals

- Reproducing the TUI's appearance.
- Running TUI components in the browser.
- Hosting on a public or LAN interface.
- Multi-user permissions, remote workspace isolation, or server deployment.
- Full mobile coding support.
