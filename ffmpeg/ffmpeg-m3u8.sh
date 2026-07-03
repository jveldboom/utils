#!/bin/bash

# Uses ffmpeg to save a m3u8 playlist file to mp4

URL="https://example.com/index.m3u8"
FILENAME="Video Title"

ffmpeg -i "$URL" -c copy "$FILENAME".mp4
