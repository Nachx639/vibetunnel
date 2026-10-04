# Voice: dictation, read-aloud and voice mode

Dictation puts spoken text into the chat-mode input box; you still press send. The browser
records the audio and the VibeTunnel server transcribes it locally with
[whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio leaves the machine. It works in
Safari and Chrome on iOS, where the browser's own Web Speech recognizer is missing or unreliable.

## Turning it on or off

Voice is **on by default, wherever the tools are installed**: the chat view shows the mic only
when this server has whisper.cpp and ffmpeg, Read aloud only when it has a voice engine, and
Voice mode only when it has both. A server without them shows nothing new.

Two switches in **Settings > Application**, per browser:

- **Voice** (on): dictation, Read aloud and Voice mode with this server's local tools.
- **Browser speech** (off): when the server lacks a tool, use the browser's own speech
  recognizer and voices instead. Off by default because Chrome's recognizer sends the audio to
  Google (and its network voices the text).

To turn voice off for the whole server, add this to `~/.vibetunnel/config.json`:

```json
{
  "voice": false
}
```

Then the chat view shows no mic, Read aloud or Voice mode, `GET /api/dictation/status` answers
`{"enabled": false, "available": false}`, and `POST /api/dictation/transcribe` answers
`403 {"error": "disabled"}` without reading the upload or starting any process. The key is read
on every request, so no restart is needed; a running `whisper-server` is stopped the next time
the status or transcribe endpoint is called. `voice` cannot be set through `PUT /api/config`.

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

## Read-aloud and voice mode

With an engine installed, each Claude answer in the phone chat view gets a **Read aloud**
button, and with whisper.cpp too the chat's header gets a **Voice mode** button: a full-screen, hands-free conversation that
listens until you pause, transcribes what you said (the dictation pipeline above), sends it
to Claude, reads the answer aloud and listens again. Speaking over the answer, or **Stop
talking**, interrupts it. A permission prompt or plan approval is announced and the
conversation stops: it is never answered by voice.

With `"voice": false`: no Read aloud or Voice mode buttons, `GET /api/tts/status` answers
`{"enabled": false, ...}` without looking for any engine, and `POST /api/tts` answers `403`.

Answers are read by the best local engine available:

1. **Kokoro** (kokoro-onnx), kept loaded between answers and stopped after 15 idle minutes.
   It talks to the server over a stdin/stdout pipe (no network listener).
2. **Piper**, if installed with a voice model.
3. macOS **`say`**, with a voice picked from `say -v '?'` for the answer's language (an
   enhanced or premium voice first, never a novelty voice). Without a voice for that language
   the system voice reads it.

If no engine works and **Browser speech** is on, the browser's own speech synthesis reads the
answer (muted on an iPhone in silent mode); otherwise nothing is read.

Kokoro setup (any OS with Python 3.10+):

```bash
python3 -m venv ~/.vibetunnel/tts/venv
~/.vibetunnel/tts/venv/bin/pip install kokoro-onnx soundfile
mkdir -p ~/.vibetunnel/tts/models && cd ~/.vibetunnel/tts/models
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Piper: put the `piper` binary on the PATH and a `*.onnx` voice in `~/.vibetunnel/tts/piper/`.

| Variable | Meaning |
|---|---|
| `VIBETUNNEL_TTS_ENGINE` | Use only `kokoro`, `piper` or `say` (other values are ignored). |
| `VIBETUNNEL_TTS_DIR` | Absolute folder holding `venv/`, `models/` and `piper/` (default `~/.vibetunnel/tts`). |
| `VIBETUNNEL_TTS_PYTHON` | Absolute path to the Python that has kokoro-onnx. |
| `VIBETUNNEL_KOKORO_MODEL` | Absolute path to the Kokoro `.onnx` model. |
| `VIBETUNNEL_KOKORO_VOICES` | Absolute path to Kokoro's `voices-v1.0.bin`. |
| `VIBETUNNEL_PIPER` | Absolute path to `piper`. |
| `VIBETUNNEL_PIPER_MODEL` | Absolute path to the Piper voice model. |
| `VIBETUNNEL_SAY` | Absolute path to `say`. |

The same rules as above apply: a set path must be an absolute existing file and is never
replaced by a default. `POST /api/tts` takes at most 600 characters per request (the client
sends an answer sentence by sentence) and a 16 KB body; audio is written to a private temporary
directory and removed. Piper gets the text on stdin and `say` after `--`, never through a
shell. On voice mode's first use, Kokoro is warmed for the UI language only.

whisper sometimes turns noise into text. Voice mode ignores transcripts with no letters and
non-speech tags (`[Music]`, `*noise*`, `♪`); it has no phrase list for any language.
