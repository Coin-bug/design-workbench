#!/bin/zsh
cd "$(dirname "$0")"
python3 server.py &
SERVER_PID=$!
sleep 1
if [ -f ".last-url" ]; then
  open "$(cat .last-url)"
else
  open "http://127.0.0.1:4173"
fi
wait $SERVER_PID
