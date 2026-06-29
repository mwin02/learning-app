#!/usr/bin/env python3
"""Fetch YouTube caption transcripts for grounding concept-bank questions.

Usage:
    python3 fetch-transcript.py <videoIdOrUrl> [<videoIdOrUrl> ...]

Accepts bare 11-char video IDs or full youtube.com/youtu.be URLs. Prints one
labelled block per video. Videos with no captions, or that YouTube blocks, are
reported as FAIL on stderr-style lines so the caller can fall back to
title + domain knowledge for just those resources.

Depends on `youtube-transcript-api` (pip). If it is missing the script prints a
one-line install hint and exits non-zero.
"""
import re
import sys

try:
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError:
    print("MISSING_DEP: run `python3 -m pip install youtube-transcript-api`", flush=True)
    sys.exit(2)

_ID = re.compile(r"(?:v=|/shorts/|youtu\.be/|/embed/)([A-Za-z0-9_-]{11})")


def video_id(arg: str) -> str | None:
    arg = arg.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", arg):
        return arg
    m = _ID.search(arg)
    return m.group(1) if m else None


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: fetch-transcript.py <videoIdOrUrl> [...]", flush=True)
        return 1
    api = YouTubeTranscriptApi()
    rc = 0
    for arg in argv:
        vid = video_id(arg)
        if not vid:
            print(f"=== {arg} FAIL: not a recognizable video id/url ===", flush=True)
            rc = 1
            continue
        try:
            snippets = api.fetch(vid)
            text = " ".join(s.text for s in snippets)
            print(f"=== {vid} OK len={len(text)} ===", flush=True)
            print(text, flush=True)
            print(flush=True)
        except Exception as e:  # noqa: BLE001 - report any fetch failure, keep going
            print(f"=== {vid} FAIL: {type(e).__name__}: {str(e)[:160]} ===", flush=True)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
