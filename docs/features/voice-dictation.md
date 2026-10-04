# Voice dictation

Dictation puts spoken text into the chat-mode input box; you still press send. The browser
records the audio and the VibeTunnel server transcribes it locally with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio leaves the machine. It works in
Safari and Chrome on iOS, where the browser's own Web Speech recognizer is missing or unreliable.

## Turning it on

Dictation is **off by default**. With it off, the chat view shows no mic button,
`GET /api/dictation/status` answers `{"enabled": false, "available": false}`, and
`POST /api/dictation/transcribe` answers `403 {"error": "disabled"}` without reading the upload
or starting any process.

To turn it on, add this to `~/.vibetunnel/config.json`:

```json
{
  "voice": true
}
```

The key is read on every request, so no restart is needed. Remove it (or set `false`) to turn
dictation off again; a running `whisper-server` is stopped the next time the status or
transcribe endpoint is called. `voice` cannot be set through `PUT /api/config`.

With `voice` on but whisper.cpp not installed, the mic falls back to the browser's Web Speech
recognizer where the browser has one (desktop Chrome and Safari), and explains otherwise.

## Installing the tools

You need `ffmpeg`, `whisper-cli` and a multilingual ggml model. `whisper-server` is optional but
recommended: it keeps the model loaded, so a short phrase is transcribed in well under a second
instead of 1-2 s.

macOS (Homebrew):

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Linux: install ffmpeg from your distribution and build whisper.cpp (`cmake -B build && cmake
--build build -j`), then put `whisper-cli` and `whisper-server` on the PATH or point the
variables below at them.

The server looks for the binaries on its `PATH` plus `/opt/homebrew/bin` and `/usr/local/bin`
(the macOS app starts the server with a minimal PATH), and for models named `ggml-*.bin` in
`~/.local/share/whisper-cpp`. It prefers multilingual models (large-v3-turbo, then large,
medium, small); English-only `.en` models are skipped.

## Environment variables

| Variable | Meaning |
|---|---|
| `VIBETUNNEL_FFMPEG` | Absolute path to `ffmpeg`. |
| `VIBETUNNEL_WHISPER_CLI` | Absolute path to `whisper-cli`. |
| `VIBETUNNEL_WHISPER_MODEL` | Absolute path to the ggml model file. |
| `VIBETUNNEL_WHISPER_SERVER` | Absolute path to `whisper-server`, or `off` to always use `whisper-cli`. |

A variable that is set must name an existing absolute file (executable, for the binaries);
otherwise that tool counts as missing. It is not replaced by another copy found on the PATH.

## How it works

1. The browser records 16 kHz mono audio with Web Audio and encodes it as WAV (MediaRecorder is
   not used: it produced empty recordings in WebKit).
2. `POST /api/dictation/transcribe` (behind the normal `/api` authentication) takes at most
   8 MB and 130 seconds of audio. The audio is written to a private temporary directory
   (mode 0700), transcribed, and the directory is removed.
3. A WAV in the app's format goes straight to whisper. Anything else is converted by ffmpeg,
   restricted to WAV input from a local file (`-f wav -protocol_whitelist file`) and cut at
   130 seconds.
4. whisper runs with language detection. One transcription runs at a time; two more may wait,
   further requests get `429`. A request the client abandons is skipped or its process killed.
5. `whisper-server`, when present, is started on first use, bound to `127.0.0.1` on a random
   port, and stopped after 15 idle minutes and when VibeTunnel shuts down. Its pid is kept in
   `whisper-server.pid` (mode 0600) next to the control directory; a leftover from a crashed
   server is stopped only if that pid still runs the same binary with the same model on
   loopback.

All tools are started with argument arrays (`execFile`/`spawn`), never through a shell.
