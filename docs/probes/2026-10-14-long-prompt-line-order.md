# Long prompt line order

- Date: 2026-10-14 PDT
- Source: `a04e8b1` with the adapter change in the working tree, then the committed `0a4751c`; both plus the temporary stop described under Method
- Scope: two prompts of 5,337 and 5,446 characters typed into the default project's composer and stopped before Send
- Result: both failed the staging check before the change and staged exactly after it; nothing was sent

## Symptom

Every Pro query with a prompt over 500 characters ended with `prompt_staging_failed` ("The composer text did not match the requested prompt") and sent nothing. A 74-character query on the same build completed.

## Cause

`#typeHuman` types a prompt over 500 characters one line at a time: `page.insertText(line)`, then `sendKey('Return', { modifiers: ['shift'] })`. In the Electron adapter, `sendKey` used `webContents.sendInputEvent`, which queues the key and returns at once, while `insertText` uses `webContents.insertText`, a separate channel. The next line could reach the editor before the newline ahead of it. The staging check added on 2026-10-12 compares the composer's text with the prompt before Send, and it refused the joined lines. That check first ran live on 2026-10-14; the app running before had started on 2026-10-06.

The adapter's `sendKey` now arms a `keyup` listener in the page, sends the key, and returns once the page has seen the keyup, waiting at most one second. The newline stays a key press. Inserting it as text was not tried: Enter submits in ChatGPT's composer, and a ProseMirror editor may read a native paragraph split as an Enter key press.

## Method

A temporary patch in `#typePrompt`, never committed, stopped any prompt containing a marker string after the staging check and before Send, then cleared the composer. Prompts without the marker were unaffected. The patch was removed after the checks.

| Build | Prompt | Run | Result |
|---|---|---|---|
| before the change | 5,337 characters, Markdown headings, bullets, bracketed words | `2e8e24b8-6db3-4a55-b6cc-bd2015633d8a` | `prompt_staging_failed`, first difference at character 49: the newline after `## Intent` arrived after the next line |
| before the change | 5,446 characters, plain prose | `c6ef7b36-5873-44a0-9097-c4ff6f3220c1` | `prompt_staging_failed`, first difference at character 321 |
| working-tree change | the same two prompts | `f3ba8351-fe97-47b0-8c0a-84d2d500a1be`, `a2c6967c-c670-4e59-a627-354a6c7e105e` | staged exactly |
| committed `0a4751c` | the same two prompts | `6fe928c5-5a87-4b2a-bb2a-560894a61e2c`, `b99b0597-8a33-4321-9415-6fa4ad6503e9` | staged exactly |

ChatGPT kept an unsent composer draft for the project page across tabs and app restarts: the first probe in a fresh tab began with text left by an earlier failed query. Typing replaced it, and the drafts were cleared afterwards; a fresh project tab then showed an empty composer.

## End to end

On the changed build, a 31,560-character Pro query from another local caller, run `a4dd7382-fea4-4479-9067-447a794a92ec`, was sent at 01:56:52 and finished `success` at 02:29:19 with complete prompt delivery, `extended-pro` confirmed from response metadata, and a completion receipt.

## Limits

Electron's `webContents.selectAll()` is another unordered channel. If it is processed after text typed later, the composer holds something other than the prompt, and the staging check refuses it before Send. The chrome-cdp backend already awaits each input command and was not exercised.
