#!/bin/bash
# Usage: ./scripts/post-room.sh <room_id_or_name> <message>
# Example: ./scripts/post-room.sh tnlx2txd "hello everyone"

export LANG=en_US.UTF-8

BROKER="http://localhost:7899"
ROOM_ID="$1"
MESSAGE="$2"
USER_ID="user-$(whoami)"

if [ -z "$ROOM_ID" ] || [ -z "$MESSAGE" ]; then
  echo "Usage: $0 <room_id> <message>"
  exit 1
fi

# Build JSON via temp file to avoid encoding issues on Windows
TMPFILE=$(mktemp)
printf '{"room_id":"%s","peer_id":"%s"}' "$ROOM_ID" "$USER_ID" > "$TMPFILE"
curl -s -X POST -H "Content-Type: application/json; charset=utf-8" --data-binary @"$TMPFILE" "$BROKER/join-room" > /dev/null

printf '{"room_id":"%s","from_id":"%s","message":"%s"}' "$ROOM_ID" "$USER_ID" "$MESSAGE" > "$TMPFILE"
curl -s -X POST -H "Content-Type: application/json; charset=utf-8" --data-binary @"$TMPFILE" "$BROKER/post-room"

rm -f "$TMPFILE"
echo ""
