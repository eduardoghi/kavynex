# Support

Kavynex is maintained by one person in their spare time. There is no support contract and no
response-time guarantee - but every report is read, and a well-formed one is usually answered
faster than it takes to write a vague one. This page says where each kind of question goes.

## Try the troubleshooting section first

The README's [Troubleshooting](README.md#troubleshooting) section covers what people actually
hit, with the resolution rather than a pointer to one:

- **"yt-dlp was not found" / "ffmpeg was not found"** - how Kavynex resolves both binaries
  (PATH only, never the working directory), and the `tools/` fallback for a portable install.
- **The window does not open, or opens blank, on Windows** - almost always the WebView2 runtime.
- **"This library was released earlier in this session"** - restart and it works; nothing is lost.
  The README explains why the restart is genuinely required rather than a workaround.
- **"Kavynex reports a corrupted database"** - handled automatically on the next launch, from the
  most recent healthy snapshot. Nothing is silently discarded.

The in-app **Diagnostics** dialog answers a lot on its own: the resolved paths and versions of
yt-dlp and FFmpeg (or the exact reason each failed its health check), the library folder in use,
and a reconciliation of the database against the files on disk.

## Where to report

**Issues are the only public channel.** Discussions are not enabled, and the wiki is unused, so
please do not treat either as a way to reach the maintainer.

| What | Where |
|---|---|
| A bug | [Open an issue](https://github.com/eduardoghi/kavynex/issues) |
| A feature idea | [Open an issue](https://github.com/eduardoghi/kavynex/issues) |
| A security vulnerability | [Open a private advisory](https://github.com/eduardoghi/kavynex/security/advisories/new) - **never a public issue**. See `SECURITY.md`. |
| A question about contributing | `CONTRIBUTING.md`, then an issue if it is still unclear |

The security row is not a formality. A public issue describing a vulnerability discloses it to
everyone before there is a release that fixes it, and this project ships to whoever downloaded
it - there is no way to reach those installs quickly. `SECURITY.md` describes the threat model
the report will be assessed against, and security reports are prioritized over other work.

## What to include in a bug report

The three that decide whether a report is actionable:

1. **Your OS and the Kavynex version** (Settings shows the version). Behavior differs by platform
   more than you would expect - path handling, the webview engine, and how external processes are
   launched are all platform-specific.
2. **What you did, what you expected, what happened instead.** A screenshot of the error dialog is
   worth more than a paraphrase of it.
3. **The relevant log lines.** `docs/DIRECTORIES.md` lists where `kavynex.log` lives on each
   platform.

### Read the log before pasting it

Kavynex redacts what it can: cookie values are never recorded, a cookies *file* path is redacted,
and a successful download logs only a reduced video reference rather than the URL you pasted.

What it cannot redact away: log lines carry local file paths, and a run that **fails** also records
yt-dlp's own verbose output, which can include the full URL. So the log does reveal which videos
you fetched, and on Windows a path embeds your account name.

Paste the lines around the failure rather than the whole file, and read them through first. If
something in them is sensitive, say so in the issue instead of posting it - a description of the
shape of the failure is usually enough to start.

## What to expect

- **No SLA.** This is one person's side project. Quiet weeks happen.
- **Security reports come first**, ahead of features and ordinary bugs.
- **A feature may be declined**, and that is not a judgement of the idea. The scope that stays
  maintainable for one person is narrower than the scope that would be nice to have.
- **Small, focused pull requests are welcome** - see `CONTRIBUTING.md` for setup, the commands CI
  runs, and the commit conventions.
