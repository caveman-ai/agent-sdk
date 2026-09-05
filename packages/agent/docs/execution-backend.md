# Execution backends

`CodingAgentOptions.executionBackend` moves coding-agent process and workspace
effects behind one host-owned boundary. Default `localExecutionBackend()` keeps
existing host behavior. Host execution remains uncontained host execution; this
interface does not claim isolation.

Remote providers use `httpExecutionBackend({ url, token })`. Every request is a
JSON `POST` with these headers:

```text
Authorization: Bearer <token>
Content-Type: application/json
```

Contract:

| Endpoint | Request JSON | Success JSON |
| --- | --- | --- |
| `/exec` | `{execId,command,args,cwd,env,timeoutMs,maxOutputBytes}` | `{stdout,stderr,code,timedOut,truncated,startFailed?}` |
| `/read` | `{path,maxBytes?}` | `{data}` (`data` is base64) |
| `/write` | `{path,data}` (`data` is base64) | `{}` |
| `/cancel` (optional) | `{execId}` | `{}` |
| `/prepare` (optional) | `{}` | `{}` |
| `/snapshot` (optional) | `{}` | `{snapshotId}` |
| `/restore` (optional) | `{snapshotId}` | `{}` |

`/read` returns HTTP 404 for a missing path and HTTP 422
`{"error":"not_a_file"}` for a non-regular path. A workspace escape returns HTTP
403 `{"error":"path_escapes_workspace"}`. Every other non-2xx response fails
closed. A command that cannot start returns code `127`, empty `stdout`, and
`startFailed: true`. `/exec` must enforce `timeoutMs` and `maxOutputBytes`; `truncated` is
true whenever bytes were discarded. Client also bounds oversized responses to
`maxOutputBytes`. `AbortSignal` is not serialized; client uses it to cancel
the HTTP request, then posts `/cancel` with the aborted call's `execId` so the
server can kill that process tree. `/cancel` is best effort and bounded at 5s:
its response is ignored, a provider that does not implement it answers 404, and
the client still returns the aborted `ExecResult` either way. A server that
omits `/cancel` leaves the remote process running until its own `timeoutMs`
expires, so providers should implement it. `execId` is unique per `/exec` call;
servers must scope a cancel to the matching call and ignore unknown ids.

For remote backends, `env` contains only allowlisted locale/terminal keys:
`LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, and `TERM`. Server owns `PATH`, `HOME`,
`TMPDIR`, `PWD` (set to request `cwd`), and `USER`, then layers supplied `env`
over those values. Server must not add anything else, especially ambient
provider secrets.

Interactive command sessions are local-only. Remote backends support bounded
foreground `bash`; `yieldTimeMs` and session operations fail with
`cave_execution_backend_command_sessions_local_only`. Setting
`commandSessions: true` or configuring command-session spill with non-local
backend fails with same code during agent construction. Provider must enforce
its own workspace-root containment for remote paths. `cwd` and `path` are
absolute strings under client's `workspace` option. Server must map that client
prefix to its own workspace root, resolve symlinks, and return specified 403
response for escapes.
