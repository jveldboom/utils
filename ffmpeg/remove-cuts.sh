#!/bin/bash
set -euo pipefail

# remove_cuts.sh - Remove sections from a video with frame-accurate cuts
# Usage: remove_cuts.sh input.mkv cuts.txt [output.mkv]
#
# cuts.txt format (one removal per line):
#   HH:MM:SS - HH:MM:SS
#   00:12:41 - 00:12:46
#
# Every kept segment is re-encoded with settings detected from the source
# (codec, bit depth, HDR/color metadata) so the result plays reliably on any
# input and cuts land exactly on the timestamps you specify.

INPUT="$1"
CUTS_FILE="$2"
OUTPUT="${3:-${INPUT%.*}_cut.mkv}"

if [[ -z "$INPUT" || -z "$CUTS_FILE" ]]; then
  echo "Usage: remove_cuts.sh input.mkv cuts.txt [output.mkv]"
  exit 1
fi

[[ ! -f "$INPUT" ]]     && { echo "Error: '$INPUT' not found"; exit 1; }
[[ ! -f "$CUTS_FILE" ]] && { echo "Error: '$CUTS_FILE' not found"; exit 1; }

DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$INPUT")

# Convert HH:MM:SS[.mmm] to seconds
ts_to_sec() {
  awk -F: '{
    if (NF==3) printf "%.6f", ($1*3600)+($2*60)+$3
    else if (NF==2) printf "%.6f", ($1*60)+$2
    else printf "%.6f", $1
  }' <<< "$1"
}

# Parse cuts file (handles a missing trailing newline)
declare -a R_START=() R_END=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  if [[ "$line" =~ ^([0-9:\.]+)[[:space:]]*-[[:space:]]*([0-9:\.]+) ]]; then
    R_START+=("$(ts_to_sec "${BASH_REMATCH[1]}")")
    R_END+=("$(ts_to_sec "${BASH_REMATCH[2]}")")
  fi
done < "$CUTS_FILE"

N=${#R_START[@]}
[[ $N -eq 0 ]] && { echo "Error: No cuts found in '$CUTS_FILE'"; exit 1; }

echo "📁 Input:  $INPUT"
echo "✂️  Removing $N section(s)"

# Sort removals by start time (bubble sort)
for ((i=0; i<N-1; i++)); do
  for ((j=0; j<N-1-i; j++)); do
    if (( $(echo "${R_START[$j]} > ${R_START[$((j+1))]}" | bc -l) )); then
      ts="${R_START[$j]}"; te="${R_END[$j]}"
      R_START[$j]="${R_START[$((j+1))]}"; R_END[$j]="${R_END[$((j+1))]}"
      R_START[$((j+1))]="$ts"; R_END[$((j+1))]="$te"
    fi
  done
done

# Build keep segments from the gaps between removals
declare -a K_START=() K_END=()
PREV=0
for ((i=0; i<N; i++)); do
  if (( $(echo "${R_START[$i]} > $PREV" | bc -l) )); then
    K_START+=("$PREV"); K_END+=("${R_START[$i]}")
  fi
  PREV="${R_END[$i]}"
done
if (( $(echo "$PREV < $DURATION" | bc -l) )); then
  K_START+=("$PREV"); K_END+=("$DURATION")
fi

NUM_K=${#K_START[@]}
echo "📋 Keeping $NUM_K segment(s)"

# --- Detect source video parameters so the re-encode matches the original ---
VIDEO_CODEC=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$INPUT")
PIX_FMT=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=pix_fmt -of csv=p=0 "$INPUT")
COL_PRIM=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=color_primaries -of csv=p=0 "$INPUT")
COL_TRC=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 "$INPUT")
COL_SPACE=$(ffprobe -v quiet -select_streams v:0 -show_entries stream=color_space -of csv=p=0 "$INPUT")

# Detect bit depth (informational) and HDR (PQ or HLG transfer)
IS_10BIT=false
[[ "$PIX_FMT" == *10* ]] && IS_10BIT=true
IS_HDR=false
[[ "$COL_TRC" == "smpte2084" || "$COL_TRC" == "arib-std-b67" ]] && IS_HDR=true

# Video filter + output color tags.
# HDR sources are tone-mapped down to standard SDR (bt709) so they display
# correctly on any TV/player with no HDR metadata to preserve. SDR sources pass
# through untouched (color-wise) and just get re-encoded.
declare -a VF=()
declare -a COLOR_ARGS=()
if [[ "$IS_HDR" == true ]]; then
  # zscale: PQ/HLG bt2020 -> linear light -> Hable tone-map -> bt709 SDR.
  # Requires an ffmpeg built with libzimg (the zscale filter).
  VF=(-vf "zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,tonemap=tonemap=hable:desat=0,zscale=transfer=bt709:matrix=bt709:range=tv,format=yuv420p")
  COLOR_ARGS=(-color_primaries bt709 -color_trc bt709 -colorspace bt709)
else
  # Preserve the source's existing (SDR) color tags, skipping "unknown"/empty
  [[ -n "$COL_PRIM"  && "$COL_PRIM"  != "unknown" ]] && COLOR_ARGS+=(-color_primaries "$COL_PRIM")
  [[ -n "$COL_TRC"   && "$COL_TRC"   != "unknown" ]] && COLOR_ARGS+=(-color_trc "$COL_TRC")
  [[ -n "$COL_SPACE" && "$COL_SPACE" != "unknown" ]] && COLOR_ARGS+=(-colorspace "$COL_SPACE")
fi

# Hardware encoder matched to the source codec family (8-bit SDR output either way)
declare -a VENC
if [[ "$VIDEO_CODEC" == "h264" || "$VIDEO_CODEC" == "avc" ]]; then
  VENC=(-c:v h264_videotoolbox -q:v 65)
else
  VENC=(-c:v hevc_videotoolbox -q:v 65 -tag:v hvc1)
fi

echo "🎞️  Source: $VIDEO_CODEC, $PIX_FMT$( [[ "$IS_10BIT" == true ]] && echo ' (10-bit)' )"
if [[ "$IS_HDR" == true ]]; then
  echo "🌈 HDR source detected — tone-mapping to SDR (bt709)"
else
  echo "🎨 SDR source — no tone-mapping needed, preserving color"
fi

# --- Audio: re-encode to AAC, English/undefined tracks only ---
CHANNELS=$(ffprobe -v quiet -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$INPUT" | head -1)
ABRATE=$(( CHANNELS * 96 ))
(( ABRATE < 192 )) && ABRATE=192
(( ABRATE > 640 )) && ABRATE=640
declare -a AENC=(-c:a aac -b:a "${ABRATE}k")
declare -a AMAP=(-map 0:v:0 -map 0:a:m:language:eng? -map 0:a:m:language:und?)

echo ""

WORK=$(mktemp -d)
trap "rm -rf '$WORK'" EXIT
CONCAT="$WORK/concat.txt"
> "$CONCAT"

for ((i=0; i<NUM_K; i++)); do
  KS="${K_START[$i]}"
  KE="${K_END[$i]}"
  DUR=$(echo "$KE - $KS" | bc -l)
  echo "⚙️  Segment $((i+1))/$NUM_K  ($(printf '%.3f' "$KS")s → $(printf '%.3f' "$KE")s)"

  F="$WORK/$(printf '%05d' $i).mp4"
  # -ss BEFORE -i = fast keyframe seek to near the cut, then ffmpeg decodes
  # forward to the exact frame (still frame-accurate) instead of decoding the
  # whole file from 0. -t gives the duration since timestamps reset after -ss.
  ffmpeg -v warning -ss "$KS" -i "$INPUT" -t "$DUR" \
    ${VF[@]+"${VF[@]}"} "${VENC[@]}" ${COLOR_ARGS[@]+"${COLOR_ARGS[@]}"} \
    "${AENC[@]}" "${AMAP[@]}" -movflags +faststart "$F"
  echo "file '$F'" >> "$CONCAT"
done

echo ""
echo "🔗 Concatenating $NUM_K segment(s) → $OUTPUT"
# All segments share identical codec params, so a stream-copy concat is safe.
ffmpeg -v warning -f concat -safe 0 -i "$CONCAT" -c copy "$OUTPUT"

echo ""
echo "✅ Done! Output: $OUTPUT"
echo ""
echo "🔍 Output streams:"
ffprobe -v quiet -print_format json -show_streams "$OUTPUT" | \
  jq -r '.streams[] | "  [\(.index)] \(.codec_type | ascii_upcase)\t\(.codec_name)\tlang=\(.tags.language // "-")\t\(.channel_layout // "")"'
